// Depo iş mantığı: Vega görüntüsü + programın kendi tabloları. Terminal ve yönetici ekranı buradan beslenir.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const vega = require('./vega');
const log = require('./log');
const fuzzy = require('./fuzzy');

const EPS = 1e-9;
const now = () => Date.now();
const yuvarla = (x) => Math.round(Number(x) * 10000) / 10000;

// ---- Değişiklik sayacı ---------------------------------------------------------------------
// Ana veri her değişiklikte yeniden kurulur; terminal ETag ile değişmediyse 304 alır.
let surum = 1;
let masterCache = null;
const dinleyiciler = new Set();

function degisti() {
  surum++;
  masterCache = null;
  for (const f of dinleyiciler) {
    try {
      f(surum);
    } catch {}
  }
}

function dinle(f) {
  dinleyiciler.add(f);
  return () => dinleyiciler.delete(f);
}

// ---- Vega görüntüsü ------------------------------------------------------------------------

let goruntu = null;
let urunIndex = new Map();
const vegaDurum = { ok: false, hata: null, at: null, sureMs: null, calisiyor: false };

function goruntuKur(g) {
  goruntu = g;
  urunIndex = new Map(g.products.map((p) => [p.id, p]));
  goruntu.stockMap = new Map(Object.entries(g.stock || {}));
  goruntu.movedSet = new Set(g.moved || []);
  aramaIndex = null;
}

// İsimle arama alanları; ilk aramada kurulur.
let aramaIndex = null;
function arama(p) {
  if (!aramaIndex) aramaIndex = new Map(goruntu.products.map((x) => [x.id, fuzzy.kayit(x)]));
  return aramaIndex.get(p.id);
}

function goruntuYukleOnbellek() {
  const r = db.get("SELECT json, updated_at FROM vega_cache WHERE key='goruntu'");
  if (!r) return;
  try {
    goruntuKur(JSON.parse(r.json));
    vegaDurum.at = r.updated_at;
    vegaDurum.onbellek = true;
  } catch (e) {
    log.hata('Vega önbelleği okunamadı', e);
  }
}

async function vegaYenile() {
  if (vegaDurum.calisiyor) return vegaDurum;
  const cfg = config.load();
  if (!vega.hazirMi(cfg.vega)) {
    vegaDurum.ok = false;
    vegaDurum.hata = 'Vega bağlantısı ayarlanmadı';
    return vegaDurum;
  }
  vegaDurum.calisiyor = true;
  const bas = now();
  try {
    const g = await vega.goruntu(cfg);
    goruntuKur(g);
    db.run(
      "INSERT INTO vega_cache(key, json, updated_at) VALUES('goruntu', ?, ?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
      JSON.stringify(g),
      g.at,
    );
    Object.assign(vegaDurum, { ok: true, hata: null, at: g.at, sureMs: now() - bas, onbellek: false });
    degisti();
  } catch (e) {
    Object.assign(vegaDurum, { ok: false, hata: e.message, sureMs: now() - bas });
    log.hata('Vega okunamadı', e);
  } finally {
    vegaDurum.calisiyor = false;
  }
  return vegaDurum;
}

let zamanlayici = null;
function vegaZamanla() {
  clearInterval(zamanlayici);
  const sn = Math.max(30, Number(config.load().yenileme) || 120);
  zamanlayici = setInterval(() => vegaYenile().catch(() => {}), sn * 1000);
}

function urun(id) {
  return urunIndex.get(String(id)) || null;
}

function vegaStok(id) {
  return goruntu ? Number(goruntu.stockMap.get(String(id)) || 0) : 0;
}

// ---- Raf stoku -----------------------------------------------------------------------------

function rafVarMi(code) {
  return Boolean(db.get('SELECT 1 FROM shelf WHERE code=?', code));
}

function rafEkle(code, { zone, note = '', source = 'ADMIN' } = {}) {
  const c = rafKodu(code);
  if (!c) throw new Error('Raf kodu boş');
  db.run(
    'INSERT INTO shelf(code, zone, note, source, created_at) VALUES(?,?,?,?,?) ON CONFLICT(code) DO NOTHING',
    c,
    zone ?? c.split(/[-./ ]/)[0],
    note,
    source,
    now(),
  );
  return c;
}

function rafKodu(code) {
  return String(code || '').trim().toUpperCase();
}

function miktar(productId, shelf) {
  return Number(db.get('SELECT qty FROM location WHERE product_id=? AND shelf=?', String(productId), shelf)?.qty || 0);
}

/** Raftaki miktarı verilen değere çeker ve hareketi yazar. Dönen: gerçek fark. */
function miktarAyarla(productId, shelf, yeni, hareket) {
  const pid = String(productId);
  const once = miktar(pid, shelf);
  const sonra = Math.max(0, yuvarla(yeni));
  if (sonra <= EPS) db.run('DELETE FROM location WHERE product_id=? AND shelf=?', pid, shelf);
  else
    db.run(
      'INSERT INTO location(product_id, shelf, qty, updated_at) VALUES(?,?,?,?) ON CONFLICT(product_id, shelf) DO UPDATE SET qty=excluded.qty, updated_at=excluded.updated_at',
      pid,
      shelf,
      sonra,
      hareket.ts || now(),
    );
  const delta = yuvarla(sonra - once);
  if (Math.abs(delta) > EPS || hareket.kind === 'COUNT') {
    db.run(
      'INSERT INTO movement(ts, product_id, shelf, delta, after, kind, ref, user, device, op_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      hareket.ts || now(),
      pid,
      shelf,
      delta,
      sonra,
      hareket.kind,
      hareket.ref || null,
      hareket.user || null,
      hareket.device || null,
      hareket.opId || null,
    );
  }
  return delta;
}

function miktarEkle(productId, shelf, delta, hareket) {
  return miktarAyarla(productId, shelf, miktar(productId, shelf) + Number(delta), hareket);
}

// ---- Terminal işlemleri ----------------------------------------------------------------------

class Ret extends Error {}

function sayi(x, ad) {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Ret(`${ad} geçersiz`);
  return n;
}

function islemUygula(op, cihaz, kullanici) {
  const p = op.payload || {};
  const user = String(p.user || kullanici || '');
  const device = String(p.device || cihaz || '');
  const ts = Number(op.createdAt) || now();
  const h = { ts: now(), user, device, opId: op.id };
  // Terminal ürünleri ana veriden alır; tanınmayan kimlik (demo verisi, başka kurulum) raf stokuna girmesin.
  const bilinen = (pid) => {
    if (goruntu && !urun(pid)) throw new Ret(`Ürün Vega'da bulunamadı (${pid})`);
  };

  switch (op.type) {
    case 'PUTAWAY': {
      const qty = sayi(p.qty, 'Miktar');
      if (qty <= 0) throw new Ret('Miktar sıfırdan büyük olmalı');
      const pid = String(p.productId || '');
      if (!pid) throw new Ret('Ürün yok');
      bilinen(pid);
      // Mal fiziken rafa kondu; raf tanımı sonradan silinmiş olsa bile kayıt kaybolmasın.
      const shelf = rafKodu(p.shelf);
      if (!shelf) throw new Ret('Raf yok');
      if (!rafVarMi(shelf)) rafEkle(shelf, { source: 'TERMINAL', note: 'Terminalden geldi' });
      const belge = p.receiptId ? receiptById(String(p.receiptId)) : null;
      miktarEkle(pid, shelf, qty, { ...h, kind: 'PUTAWAY', ref: belge ? belge.docNo : p.receiptId || null });
      if (p.lineId) {
        db.run(
          `INSERT INTO receipt_shelved(line_id, receipt_id, product_id, shelved, updated_at) VALUES(?,?,?,?,?)
           ON CONFLICT(line_id) DO UPDATE SET shelved = shelved + excluded.shelved, updated_at = excluded.updated_at`,
          String(p.lineId),
          String(p.receiptId || ''),
          pid,
          qty,
          now(),
        );
      }
      return;
    }
    case 'TRANSFER': {
      const qty = sayi(p.qty, 'Miktar');
      if (qty <= 0) throw new Ret('Miktar sıfırdan büyük olmalı');
      const pid = String(p.productId || '');
      const from = rafKodu(p.from);
      const to = rafKodu(p.to);
      if (!pid || !from || !to) throw new Ret('Eksik bilgi');
      bilinen(pid);
      if (from === to) throw new Ret('Kaynak ve hedef raf aynı');
      if (!rafVarMi(to)) rafEkle(to, { source: 'TERMINAL', note: 'Terminalden geldi' });
      // Sunucudaki miktar terminalin gördüğünden azsa eksiye düşmez; fazlası hareket kaydında görünür.
      miktarEkle(pid, from, -qty, { ...h, kind: 'TRANSFER_OUT', ref: to });
      miktarEkle(pid, to, qty, { ...h, kind: 'TRANSFER_IN', ref: from });
      return;
    }
    case 'COUNT_SUBMIT':
      sayimKaydet(op, p, { ...h, ts: now() }, ts);
      return;
    default:
      throw new Ret(`Bilinmeyen işlem türü: ${op.type}`);
  }
}

function sayimKaydet(op, p, h, olusturma) {
  let sid = String(p.sessionId || '');
  if (!sid) throw new Ret('Sayım kimliği yok');
  let s = db.get('SELECT * FROM count_session WHERE id=?', sid);
  if (!s) {
    if (!sid.startsWith('LOCAL-')) throw new Ret('Sayım sunucuda bulunamadı');
    // Terminalde başlatılmış serbest sayım: yönetici incelesin diye kapalı olarak açılır.
    db.run(
      `INSERT INTO count_session(id, no, title, blind, kind, status, source, note, created_at, closed_at)
       VALUES(?,?,?,?, 'RAF', 'CLOSED', 'TERMINAL', ?, ?, ?)`,
      sid,
      String(p.no || sid),
      String(p.title || 'Serbest sayım'),
      0,
      `${h.device} · ${h.user}`,
      olusturma,
      now(),
    );
    s = db.get('SELECT * FROM count_session WHERE id=?', sid);
  }
  const ref = s.no;
  const raflar = [...new Set((p.shelves || []).map(rafKodu).filter(Boolean))];
  // Vega'da olmayan ürün satırı (demo verisi) yok sayılır; sayımın geri kalanı geçerli.
  const satirlar = (Array.isArray(p.lines) ? p.lines : []).filter((l) => !goruntu || urun(String(l.productId)));
  for (const l of satirlar) {
    const raf = rafKodu(l.shelf);
    if (raf && !raflar.includes(raf)) raflar.push(raf);
  }
  for (const raf of raflar) {
    if (!rafVarMi(raf)) rafEkle(raf, { source: 'TERMINAL', note: 'Sayımdan geldi' });
    const sayilan = new Map();
    for (const l of satirlar.filter((x) => rafKodu(x.shelf) === raf)) {
      const pid = String(l.productId);
      sayilan.set(pid, { counted: Math.max(0, sayi(l.counted, 'Sayılan')), system: Number(l.system) || 0 });
    }
    // Rafta sunucuya göre olup terminalin bilmediği ürün: sayımdan önce yerleştiyse sayılmadı = 0 demektir;
    // sayımdan sonra yerleştiyse (başka terminal) dokunulmaz.
    for (const loc of db.all('SELECT product_id, qty, updated_at FROM location WHERE shelf=?', raf)) {
      if (!sayilan.has(loc.product_id) && loc.updated_at <= olusturma) sayilan.set(loc.product_id, { counted: 0, system: 0 });
    }
    for (const [pid, x] of sayilan) {
      const once = miktar(pid, raf);
      miktarAyarla(pid, raf, x.counted, { ...h, kind: 'COUNT', ref });
      db.run(
        `INSERT INTO count_line(session_id, shelf, product_id, terminal_system, server_before, counted, user, device, submitted_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, shelf, product_id) DO UPDATE SET terminal_system=excluded.terminal_system,
           server_before=excluded.server_before, counted=excluded.counted, user=excluded.user, device=excluded.device,
           submitted_at=excluded.submitted_at`,
        sid,
        raf,
        pid,
        x.system,
        once,
        x.counted,
        h.user,
        h.device,
        now(),
      );
    }
  }
}

/** Terminalden gelen işlemler. Aynı kimlik ikinci kez gelirse yeniden işlenmez (bkz. docs/API.md). */
function islemler(cihaz, kullanici, ops) {
  const sonuc = [];
  let degisiklik = false;
  for (const op of Array.isArray(ops) ? ops : []) {
    const id = String(op && op.id || '');
    if (!id) continue;
    const eski = db.get('SELECT ok, error FROM op WHERE id=?', id);
    if (eski) {
      sonuc.push({ id, ok: Boolean(eski.ok), ...(eski.ok ? {} : { error: eski.error }) });
      continue;
    }
    const kayit = (ok, error) =>
      db.run(
        'INSERT INTO op(id, type, payload, device, user, created_at, received_at, ok, error) VALUES(?,?,?,?,?,?,?,?,?)',
        id,
        String(op.type || ''),
        JSON.stringify(op.payload || {}),
        String(op.payload?.device || cihaz || ''),
        String(op.payload?.user || kullanici || ''),
        Number(op.createdAt) || now(),
        now(),
        ok ? 1 : 0,
        error || null,
      );
    try {
      db.tx(() => {
        islemUygula(op, cihaz, kullanici);
        kayit(true, null);
      });
      sonuc.push({ id, ok: true });
      degisiklik = true;
    } catch (e) {
      if (e instanceof Ret) {
        kayit(false, e.message);
        sonuc.push({ id, ok: false, error: e.message });
        log.uyari(`İşlem reddedildi ${op.type} ${id}: ${e.message}`);
      } else {
        // Beklenmeyen hata kalıcı ret değildir; cevapta yer almayan işlem terminalde bekler, sonra yeniden gelir.
        log.hata(`İşlem işlenemedi ${op.type} ${id}`, e);
      }
    }
  }
  if (degisiklik) degisti();
  return sonuc;
}

// ---- Mal kabul -----------------------------------------------------------------------------

function kabulDurumu() {
  const shelved = new Map(db.all('SELECT line_id, shelved FROM receipt_shelved').map((r) => [r.line_id, r.shelved]));
  const kapali = new Map(db.all('SELECT receipt_id, closed, closed_at, note FROM receipt_state').map((r) => [r.receipt_id, r]));
  return { shelved, kapali };
}

function belgeler({ shelved, kapali } = kabulDurumu()) {
  if (!goruntu) return [];
  return goruntu.receipts.map((r) => {
    const lines = r.lines.map((l) => ({ ...l, shelved: Number(shelved.get(l.id) || 0) }));
    const kalan = lines.reduce((t, l) => t + Math.max(0, l.accepted - l.shelved), 0);
    const st = kapali.get(r.id);
    const elleKapali = Boolean(st && st.closed);
    return {
      ...r,
      lines,
      kalemSayisi: lines.length,
      biten: lines.filter((l) => l.shelved >= l.accepted - EPS).length,
      kabul: lines.reduce((t, l) => t + l.accepted, 0),
      kalan: yuvarla(kalan),
      elleKapali,
      acik: !elleKapali && kalan > EPS,
    };
  });
}

function receiptById(id) {
  return goruntu ? goruntu.receipts.find((r) => r.id === id) || null : null;
}

/** Açık belgelerde rafa kaldırılmayı bekleyen miktar, ürün başına. Vega stoku bunu içerir. */
function bekleyenKabul() {
  const out = new Map();
  for (const r of belgeler()) {
    if (!r.acik) continue;
    for (const l of r.lines) {
      const k = Math.max(0, l.accepted - l.shelved);
      if (k > EPS) out.set(l.productId, (out.get(l.productId) || 0) + k);
    }
  }
  return out;
}

// ---- Ana veri (terminale) --------------------------------------------------------------------

function master() {
  if (masterCache && masterCache.surum === surum) return masterCache;
  if (!goruntu) {
    const e = new Error('Vega verisi henüz alınamadı. Yönetici programında Vega bağlantısını kontrol edin.');
    e.status = 503;
    throw e;
  }
  const cfg = config.load();
  const acik = belgeler().filter((r) => r.acik);
  const locations = db.all('SELECT product_id, shelf, qty FROM location WHERE qty > 0');
  const ref = new Set(locations.map((l) => l.product_id));
  for (const r of acik) for (const l of r.lines) ref.add(l.productId);

  const tum = cfg.urun.kapsam === 'tum';
  const products = [];
  for (const p of goruntu.products) {
    const st = goruntu.stockMap.get(p.id);
    if (!tum && !ref.has(p.id) && !st && !goruntu.movedSet.has(p.id)) continue;
    products.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, vegaStock: Number(st || 0), barcodes: goruntu.barcodes[p.id] || [] });
  }
  const shelves = db.all('SELECT code, zone FROM shelf ORDER BY code');
  const counts = db
    .all("SELECT id, no, title, blind FROM count_session WHERE status='OPEN' ORDER BY created_at")
    .map((c) => ({ id: c.id, no: c.no, title: c.title, blind: Boolean(c.blind) }));
  const users = db
    .all('SELECT username, name, salt, pin_hash FROM app_user WHERE active=1 ORDER BY username')
    .map((u) => ({ username: u.username, name: u.name, salt: u.salt, pinHash: u.pin_hash }));

  const govde = {
    warehouse: goruntu.depoAd,
    products,
    shelves,
    locations: locations.map((l) => ({ productId: l.product_id, shelf: l.shelf, qty: l.qty })),
    receipts: acik.map((r) => ({
      id: r.id,
      docNo: r.docNo,
      supplier: r.supplier,
      date: r.date,
      lines: r.lines.map((l) => ({ id: l.id, productId: l.productId, accepted: l.accepted, shelved: l.shelved })),
    })),
    counts,
    users,
  };
  const apk = require('./apk').bilgi();
  if (apk) govde.app = { versionName: apk.versionName, versionCode: apk.versionCode, path: '/apk' };
  const json = JSON.stringify(govde);
  masterCache = { surum, json, etag: '"' + crypto.createHash('sha1').update(json).digest('base64').slice(0, 27) + '"', boyut: json.length };
  return masterCache;
}

// ---- Yönetici görünümleri -------------------------------------------------------------------

function rafToplamlari() {
  const m = new Map();
  for (const r of db.all('SELECT product_id, SUM(qty) AS q, COUNT(*) AS n FROM location WHERE qty>0 GROUP BY product_id')) m.set(r.product_id, { q: r.q, n: r.n });
  return m;
}

/** Ürün listesi: Vega stoku, raflardaki toplam, bekleyen kabul ve yerleşmemiş fark. */
function urunListesi({ q = '', filtre = 'hepsi', limit = 300 } = {}) {
  if (!goruntu) return { toplam: 0, liste: [] };
  const raf = rafToplamlari();
  const bek = bekleyenKabul();
  const ara = String(q || '').trim();
  const qt = fuzzy.tokens(ara);
  const compact = qt.join('');
  const bc = goruntu.barcodes;
  const out = [];
  let toplam = 0;
  for (const p of goruntu.products) {
    const vs = Number(goruntu.stockMap.get(p.id) || 0);
    const r = raf.get(p.id);
    const rq = r ? r.q : 0;
    const b = bek.get(p.id) || 0;
    const fark = yuvarla(vs - rq - b);
    if (filtre === 'rafta' && !r) continue;
    if (filtre === 'yerlesmemis' && !(fark > EPS)) continue;
    if (filtre === 'fazla' && !(fark < -EPS)) continue;
    if (filtre === 'bekleyen' && !(b > EPS)) continue;
    // Ararken stoksuz kartlar da bulunur (isimle aranan ürün henüz depoda olmayabilir).
    if (filtre === 'hepsi' && !ara && !vs && !r && !b) continue;
    let skor = 0;
    if (ara) {
      skor = (bc[p.id] || []).includes(ara) ? 100 : fuzzy.puan(qt, compact, arama(p));
      if (!skor) continue;
    }
    toplam++;
    out.push({ ...p, vegaStock: vs, raf: rq, rafSayisi: r ? r.n : 0, bekleyen: yuvarla(b), fark, skor });
  }
  out.sort((a, b) => b.skor - a.skor || a.name.localeCompare(b.name, 'tr'));
  return { toplam, liste: out.slice(0, limit) };
}

function urunDetay(id) {
  const p = urun(id);
  const pid = String(id);
  const konumlar = db.all('SELECT shelf, qty, updated_at FROM location WHERE product_id=? AND qty>0 ORDER BY qty DESC', pid);
  const hareketler = db.all('SELECT * FROM movement WHERE product_id=? ORDER BY ts DESC, id DESC LIMIT 200', pid);
  const kabul = belgeler()
    .filter((r) => r.lines.some((l) => l.productId === pid))
    .slice(0, 30)
    .map((r) => {
      const l = r.lines.find((x) => x.productId === pid);
      return { id: r.id, docNo: r.docNo, tur: r.tur, date: r.date, supplier: r.supplier, accepted: l.accepted, shelved: l.shelved, acik: r.acik };
    });
  const vs = vegaStok(pid);
  const raf = konumlar.reduce((t, k) => t + k.qty, 0);
  const bek = bekleyenKabul().get(pid) || 0;
  return {
    urun: p ? { ...p, barcodes: goruntu.barcodes[pid] || [] } : { id: pid, code: '?', name: 'Vega\'da bulunamayan kart', unit: '' },
    vegaStock: vs,
    raf: yuvarla(raf),
    bekleyen: yuvarla(bek),
    fark: yuvarla(vs - raf - bek),
    konumlar,
    hareketler,
    kabul,
  };
}

function raflar() {
  const ozet = new Map(
    db.all('SELECT shelf, COUNT(*) AS n, SUM(qty) AS q, MAX(updated_at) AS u FROM location WHERE qty>0 GROUP BY shelf').map((r) => [r.shelf, r]),
  );
  return db.all('SELECT * FROM shelf ORDER BY code').map((s) => {
    const o = ozet.get(s.code);
    return { ...s, cesit: o ? o.n : 0, miktar: o ? yuvarla(o.q) : 0, sonHareket: o ? o.u : null };
  });
}

function rafDetay(code) {
  const c = rafKodu(code);
  const s = db.get('SELECT * FROM shelf WHERE code=?', c);
  const icerik = db.all('SELECT product_id, qty, updated_at FROM location WHERE shelf=? AND qty>0', c).map((l) => {
    const p = urun(l.product_id);
    return { productId: l.product_id, code: p ? p.code : '?', name: p ? p.name : 'Vega\'da bulunamayan kart', unit: p ? p.unit : '', qty: l.qty, updated_at: l.updated_at };
  });
  icerik.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  const hareketler = db.all('SELECT * FROM movement WHERE shelf=? ORDER BY ts DESC, id DESC LIMIT 100', c);
  return { raf: s, icerik, hareketler: hareketler.map((h) => ({ ...h, ...urunAdi(h.product_id) })) };
}

function urunAdi(id) {
  const p = urun(id);
  return { urunKod: p ? p.code : String(id), urunAd: p ? p.name : '' };
}

// ---- Sayım -------------------------------------------------------------------------------------

function sayimNo() {
  const son = Number(db.meta('sayimNo', 0)) + 1;
  db.set('sayimNo', son);
  return 'SAY-' + String(son).padStart(4, '0');
}

/**
 * Sayım özeti, ürün başına. "Olması gereken" depo stoku = raflardaki güncel toplam + açık belgelerde
 * rafa kaldırılmayı bekleyen. Vega'ya yazılacak fark bunun Vega stokundan farkı.
 */
function sayimOzet(id, { dahilSayilmayan = false } = {}) {
  const s = db.get('SELECT * FROM count_session WHERE id=?', id);
  if (!s) return null;
  const satirlar = db.all('SELECT * FROM count_line WHERE session_id=? ORDER BY shelf, product_id', id);
  const raf = rafToplamlari();
  const bek = bekleyenKabul();
  const urunler = new Map();
  for (const l of satirlar) {
    if (!urunler.has(l.product_id)) urunler.set(l.product_id, { productId: l.product_id, sayilan: 0, onceki: 0, raflar: [] });
    const u = urunler.get(l.product_id);
    u.sayilan += l.counted;
    u.onceki += l.server_before;
    u.raflar.push(l.shelf);
  }
  if (dahilSayilmayan && goruntu) {
    for (const [pid, st] of goruntu.stockMap) {
      if (!urunler.has(pid) && Math.abs(Number(st)) > EPS) urunler.set(pid, { productId: pid, sayilan: 0, onceki: 0, raflar: [], sayilmadi: true });
    }
  }
  const sayilanRaflar = new Set(satirlar.map((l) => l.shelf));
  const liste = [...urunler.values()].map((u) => {
    const p = urun(u.productId);
    const rafToplam = raf.get(u.productId)?.q || 0;
    const b = bek.get(u.productId) || 0;
    const vs = vegaStok(u.productId);
    const hedef = yuvarla(rafToplam + b);
    return {
      ...u,
      sayilan: yuvarla(u.sayilan),
      onceki: yuvarla(u.onceki),
      code: p ? p.code : '?',
      name: p ? p.name : 'Vega\'da bulunamayan kart',
      unit: p ? p.unit : '',
      vegadaVar: Boolean(p),
      digerRaflar: yuvarla(rafToplam - (u.sayilmadi ? 0 : satirlarRafToplam(id, u.productId))),
      bekleyen: yuvarla(b),
      hedef,
      vegaStock: vs,
      fark: yuvarla(hedef - vs),
    };
  });
  liste.sort((a, b) => Math.abs(b.fark) - Math.abs(a.fark) || a.name.localeCompare(b.name, 'tr'));
  const satirDetay = satirlar.map((l) => ({ ...l, ...urunAdi(l.product_id), fark: yuvarla(l.counted - l.server_before) }));
  return {
    oturum: { ...s, vega_docs: s.vega_docs ? JSON.parse(s.vega_docs) : null },
    raflar: [...sayilanRaflar].sort(),
    satirlar: satirDetay,
    urunler: liste,
    toplam: {
      kalem: satirlar.length,
      rafFarkli: satirDetay.filter((l) => Math.abs(l.fark) > EPS).length,
      urun: liste.length,
      vegaFarkli: liste.filter((u) => Math.abs(u.fark) > EPS && u.vegadaVar).length,
    },
  };
}

function satirlarRafToplam(sessionId, productId) {
  // Sayılan raflardaki güncel miktar (sayım sonrası rafa kaldırma vb. olduysa onu da içerir).
  const r = db.get(
    `SELECT SUM(l.qty) AS q FROM location l WHERE l.product_id=? AND l.shelf IN (SELECT shelf FROM count_line WHERE session_id=? AND product_id=?)`,
    productId,
    sessionId,
    productId,
  );
  return Number(r?.q || 0);
}

async function sayimOnayla(id, { vegaYaz = false, stoknolar = null, dahilSayilmayan = false, kullanici = 'yönetici' } = {}) {
  const ozet = sayimOzet(id, { dahilSayilmayan });
  if (!ozet) throw new Error('Sayım bulunamadı');
  const s = ozet.oturum;
  if (s.status === 'APPROVED') throw new Error('Sayım zaten onaylandı');
  if (s.status === 'CANCELLED') throw new Error('İptal edilmiş sayım onaylanamaz');
  let sonuc = null;
  if (vegaYaz) {
    const secili = stoknolar ? new Set(stoknolar.map(String)) : null;
    const kalemler = ozet.urunler
      .filter((u) => u.vegadaVar && /^\d+$/.test(u.productId) && (!secili || secili.has(u.productId)))
      .map((u) => ({ stokno: Number(u.productId), hedef: u.hedef }));
    if (kalemler.length) {
      sonuc = await vega.sayimYaz(config.load(), kalemler, { aciklama: `Sayım ${s.no}` });
      log.bilgi(`Sayım ${s.no} Vega'ya yazıldı: ${sonuc.docs.map((d) => d.belgeNo).join(', ') || 'fark yok'}`);
    }
  }
  db.run(
    "UPDATE count_session SET status='APPROVED', closed_at=COALESCE(closed_at, ?), vega_docs=?, vega_written_at=?, note=TRIM(note || ' ' || ?) WHERE id=?",
    now(),
    sonuc ? JSON.stringify(sonuc) : null,
    sonuc ? now() : null,
    `Onaylayan: ${kullanici}`,
    id,
  );
  degisti();
  if (sonuc) vegaYenile().catch(() => {});
  return sonuc;
}

async function sayimGeriAl(id) {
  const s = db.get('SELECT * FROM count_session WHERE id=?', id);
  if (!s) throw new Error('Sayım bulunamadı');
  const docs = s.vega_docs ? JSON.parse(s.vega_docs).docs : [];
  if (docs.length) await vega.sayimGeriAl(config.load(), docs);
  db.run("UPDATE count_session SET status='CLOSED', vega_docs=NULL, vega_written_at=NULL, note=TRIM(note || ' · onay geri alındı') WHERE id=?", id);
  log.bilgi(`Sayım ${s.no} onayı geri alındı (${docs.map((d) => d.belgeNo).join(', ') || 'Vega fişi yoktu'})`);
  degisti();
  vegaYenile().catch(() => {});
}

module.exports = {
  _goruntuKur: goruntuKur,
  degisti,
  dinle,
  surum: () => surum,
  vegaDurum,
  vegaYenile,
  vegaZamanla,
  goruntuYukleOnbellek,
  goruntu: () => goruntu,
  urun,
  vegaStok,
  rafEkle,
  rafKodu,
  rafVarMi,
  miktar,
  miktarAyarla,
  islemler,
  belgeler,
  bekleyenKabul,
  master,
  urunListesi,
  urunDetay,
  raflar,
  rafDetay,
  urunAdi,
  sayimNo,
  sayimOzet,
  sayimOnayla,
  sayimGeriAl,
  Ret,
};
