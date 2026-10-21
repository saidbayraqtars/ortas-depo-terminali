// Depo iş mantığı: Vega görüntüsü + programın kendi tabloları. Terminal ve yönetici ekranı buradan beslenir.
// Çok depo: raf, raf stoku, hareket ve sayım bir Vega deposuna bağlıdır (depo = F{firma}TBLDEPOLAR.IND).
// Mal kabul belgesi kendi deposunu taşır; rafa kaldırma o depoda olur.
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
  // depo → (ürün → Vega stoku); toplam ürün başına.
  goruntu.stokDepo = new Map(Object.entries(g.stock || {}).map(([d, m]) => [Number(d), new Map(Object.entries(m))]));
  goruntu.stokToplam = new Map();
  for (const m of goruntu.stokDepo.values()) for (const [pid, q] of m) goruntu.stokToplam.set(pid, (goruntu.stokToplam.get(pid) || 0) + Number(q));
  goruntu.movedSet = new Set(g.moved || []);
  goruntu.depoAd = new Map((g.depolar || []).map((d) => [Number(d.ind), d.ad]));
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
    const g = JSON.parse(r.json);
    // Tek depolu eski önbellek kullanılmaz; ilk Vega okumasında yenisi gelir.
    if (g.surum !== 2) return;
    goruntuKur(g);
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

/** Vega stoku: depo verilirse o depoda, verilmezse bütün kullanılan depoların toplamı. */
function vegaStok(id, depo = null) {
  if (!goruntu) return 0;
  if (depo === null || depo === undefined) return Number(goruntu.stokToplam.get(String(id)) || 0);
  return Number(goruntu.stokDepo.get(Number(depo))?.get(String(id)) || 0);
}

// ---- Depolar -------------------------------------------------------------------------------

/** Kullanılan depolar: Vega'dan; Vega hiç okunmadıysa raflarda geçen depolar. */
function depolar() {
  if (goruntu && goruntu.depolar && goruntu.depolar.length) return goruntu.depolar.map((d) => ({ ind: Number(d.ind), ad: d.ad }));
  return db.all('SELECT DISTINCT depo FROM shelf ORDER BY depo').map((r) => ({ ind: r.depo, ad: String(r.depo) }));
}

function depoAdi(depo) {
  const d = Number(depo);
  return (goruntu && goruntu.depoAd.get(d)) || String(d);
}

function varsayilanDepo() {
  const cfg = config.load();
  const v = Number(cfg.vega.depo);
  const liste = depolar();
  if (Number.isInteger(v) && v > 0 && (!liste.length || liste.some((d) => d.ind === v))) return v;
  return liste[0] ? liste[0].ind : Number.isInteger(v) ? v : 0;
}

/** İstekten gelen depo; yoksa ya da geçersizse varsayılan. */
function depoCoz(x) {
  const n = Number(x);
  return Number.isInteger(n) && x !== null && x !== '' && x !== undefined ? n : varsayilanDepo();
}

/** Yönetim ekranı süzgeci: boş / "hepsi" → null (bütün depolar). */
function depoSuzgec(x) {
  if (x === undefined || x === null || x === '' || x === 'hepsi') return null;
  const n = Number(x);
  return Number.isInteger(n) ? n : null;
}

// ---- Raf stoku -----------------------------------------------------------------------------

// Terminal raf kodunu Kotlin uppercase() ile (dilden bağımsız) büyütür; sunucu da aynısını yapmalı, yoksa "i" farklı büyür.
function rafKodu(code) {
  return String(code || '').trim().toUpperCase();
}

function rafVarMi(depo, code) {
  return Boolean(db.get('SELECT 1 FROM shelf WHERE depo=? AND code=?', depo, rafKodu(code)));
}

function rafEkle(depo, code, { zone, note = '', source = 'ADMIN' } = {}) {
  const c = rafKodu(code);
  if (!c) throw new Error('Raf kodu boş');
  db.run(
    'INSERT INTO shelf(depo, code, zone, note, source, created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(depo, code) DO NOTHING',
    depo,
    c,
    zone ?? c.split(/[-./ ]/)[0],
    note,
    source,
    now(),
  );
  return c;
}

function miktar(depo, productId, shelf) {
  return Number(db.get('SELECT qty FROM location WHERE depo=? AND product_id=? AND shelf=?', depo, String(productId), shelf)?.qty || 0);
}

/** Raftaki miktarı verilen değere çeker ve hareketi yazar. Dönen: gerçek fark. */
function miktarAyarla(depo, productId, shelf, yeni, hareket) {
  const pid = String(productId);
  const once = miktar(depo, pid, shelf);
  const sonra = Math.max(0, yuvarla(yeni));
  if (sonra <= EPS) db.run('DELETE FROM location WHERE depo=? AND product_id=? AND shelf=?', depo, pid, shelf);
  else
    db.run(
      'INSERT INTO location(depo, product_id, shelf, qty, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(depo, product_id, shelf) DO UPDATE SET qty=excluded.qty, updated_at=excluded.updated_at',
      depo,
      pid,
      shelf,
      sonra,
      hareket.ts || now(),
    );
  const delta = yuvarla(sonra - once);
  if (Math.abs(delta) > EPS || hareket.kind === 'COUNT') {
    db.run(
      'INSERT INTO movement(ts, depo, product_id, shelf, delta, after, kind, ref, user, device, op_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      hareket.ts || now(),
      depo,
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

function miktarEkle(depo, productId, shelf, delta, hareket) {
  return miktarAyarla(depo, productId, shelf, miktar(depo, productId, shelf) + Number(delta), hareket);
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
      const shelf = rafKodu(p.shelf);
      if (!shelf) throw new Ret('Raf yok');
      // Belge depo bazlı: mal belgenin deposunda rafa kalkar.
      const belge = p.receiptId ? receiptById(String(p.receiptId)) : null;
      const depo = belge ? belge.depo : depoCoz(p.depot);
      // Mal fiziken rafa kondu; raf tanımı sonradan silinmiş olsa bile kayıt kaybolmasın.
      if (!rafVarMi(depo, shelf)) rafEkle(depo, shelf, { source: 'TERMINAL', note: 'Terminalden geldi' });
      miktarEkle(depo, pid, shelf, qty, { ...h, kind: 'PUTAWAY', ref: belge ? belge.docNo : p.receiptId || null });
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
      const depo = depoCoz(p.depot);
      if (from === to) throw new Ret('Kaynak ve hedef raf aynı');
      if (!rafVarMi(depo, to)) rafEkle(depo, to, { source: 'TERMINAL', note: 'Terminalden geldi' });
      // Sunucudaki miktar terminalin gördüğünden azsa eksiye düşmez; fazlası hareket kaydında görünür.
      miktarEkle(depo, pid, from, -qty, { ...h, kind: 'TRANSFER_OUT', ref: to });
      miktarEkle(depo, pid, to, qty, { ...h, kind: 'TRANSFER_IN', ref: from });
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
  const sid = String(p.sessionId || '');
  if (!sid) throw new Ret('Sayım kimliği yok');
  let s = db.get('SELECT * FROM count_session WHERE id=?', sid);
  if (!s) {
    if (!sid.startsWith('LOCAL-')) throw new Ret('Sayım sunucuda bulunamadı');
    // Terminalde başlatılmış serbest sayım: yönetici incelesin diye kapalı olarak açılır.
    db.run(
      `INSERT INTO count_session(id, no, title, blind, kind, status, source, note, created_at, closed_at, depo)
       VALUES(?,?,?,?, 'RAF', 'CLOSED', 'TERMINAL', ?, ?, ?, ?)`,
      sid,
      String(p.no || sid),
      String(p.title || 'Serbest sayım'),
      0,
      `${h.device} · ${h.user}`,
      olusturma,
      now(),
      depoCoz(p.depot),
    );
    s = db.get('SELECT * FROM count_session WHERE id=?', sid);
  }
  const depo = s.depo;
  const ref = s.no;
  const raflar = [...new Set((p.shelves || []).map(rafKodu).filter(Boolean))];
  // Vega'da olmayan ürün satırı (demo verisi) yok sayılır; sayımın geri kalanı geçerli.
  const satirlar = (Array.isArray(p.lines) ? p.lines : []).filter((l) => !goruntu || urun(String(l.productId)));
  for (const l of satirlar) {
    const raf = rafKodu(l.shelf);
    if (raf && !raflar.includes(raf)) raflar.push(raf);
  }
  for (const raf of raflar) {
    if (!rafVarMi(depo, raf)) rafEkle(depo, raf, { source: 'TERMINAL', note: 'Sayımdan geldi' });
    const sayilan = new Map();
    for (const l of satirlar.filter((x) => rafKodu(x.shelf) === raf)) {
      const pid = String(l.productId);
      sayilan.set(pid, { counted: Math.max(0, sayi(l.counted, 'Sayılan')), system: Number(l.system) || 0 });
    }
    // Rafta sunucuya göre olup terminalin bilmediği ürün: sayımdan önce yerleştiyse sayılmadı = 0 demektir;
    // sayımdan sonra yerleştiyse (başka terminal) dokunulmaz.
    for (const loc of db.all('SELECT product_id, qty, updated_at FROM location WHERE depo=? AND shelf=?', depo, raf)) {
      if (!sayilan.has(loc.product_id) && loc.updated_at <= olusturma) sayilan.set(loc.product_id, { counted: 0, system: 0 });
    }
    for (const [pid, x] of sayilan) {
      const once = miktar(depo, pid, raf);
      miktarAyarla(depo, pid, raf, x.counted, { ...h, kind: 'COUNT', ref });
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
    const id = String((op && op.id) || '');
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

/** Açık belgelerde rafa kaldırılmayı bekleyen miktar, ürün başına (depo verilirse o depoda). Vega stoku bunu içerir. */
function bekleyenKabul(depo = null) {
  const out = new Map();
  for (const r of belgeler()) {
    if (!r.acik || (depo !== null && r.depo !== depo)) continue;
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
  const locations = db.all('SELECT depo, product_id, shelf, qty FROM location WHERE qty > 0');
  const ref = new Set(locations.map((l) => l.product_id));
  for (const r of acik) for (const l of r.lines) ref.add(l.productId);

  const tum = cfg.urun.kapsam === 'tum';
  const products = [];
  for (const p of goruntu.products) {
    const toplam = goruntu.stokToplam.get(p.id);
    if (!tum && !ref.has(p.id) && !toplam && !goruntu.movedSet.has(p.id)) continue;
    const stocks = {};
    for (const [d, m] of goruntu.stokDepo) {
      const q = m.get(p.id);
      if (q) stocks[d] = Number(q);
    }
    products.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, vegaStock: Number(toplam || 0), stocks, barcodes: goruntu.barcodes[p.id] || [] });
  }
  const depoListe = depolar();
  const vars = varsayilanDepo();
  const counts = db
    .all("SELECT id, no, title, blind, depo FROM count_session WHERE status='OPEN' ORDER BY created_at")
    .map((c) => ({ id: c.id, no: c.no, title: c.title, blind: Boolean(c.blind), depot: c.depo }));
  const users = db
    .all('SELECT username, name, salt, pin_hash FROM app_user WHERE active=1 ORDER BY username')
    .map((u) => ({ username: u.username, name: u.name, salt: u.salt, pinHash: u.pin_hash }));

  const govde = {
    warehouse: depoAdi(vars),
    defaultDepot: vars,
    depots: depoListe.map((d) => ({ id: d.ind, name: d.ad })),
    products,
    shelves: db.all('SELECT depo, code, zone FROM shelf ORDER BY depo, code').map((s) => ({ depot: s.depo, code: s.code, zone: s.zone })),
    locations: locations.map((l) => ({ depot: l.depo, productId: l.product_id, shelf: l.shelf, qty: l.qty })),
    // Ürünün asıl rafı (Excel'den): rafta hiç yokken rafa kaldırmada önerilir.
    homes: db.all('SELECT depo, product_id, shelf FROM product_home').map((h) => ({ depot: h.depo, productId: h.product_id, shelf: h.shelf })),
    receipts: acik.map((r) => ({
      id: r.id,
      docNo: r.docNo,
      supplier: r.supplier,
      date: r.date,
      depot: r.depo,
      depotName: r.depoAd,
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

function rafToplamlari(depo = null) {
  const m = new Map();
  const rows =
    depo === null
      ? db.all('SELECT product_id, SUM(qty) AS q, COUNT(*) AS n FROM location WHERE qty>0 GROUP BY product_id')
      : db.all('SELECT product_id, SUM(qty) AS q, COUNT(*) AS n FROM location WHERE qty>0 AND depo=? GROUP BY product_id', depo);
  for (const r of rows) m.set(r.product_id, { q: r.q, n: r.n });
  return m;
}

/** Ürün listesi: Vega stoku, raflardaki toplam, bekleyen kabul ve yerleşmemiş fark (depo verilirse o depoda). */
function urunListesi({ q = '', filtre = 'hepsi', limit = 300, depo = null } = {}) {
  if (!goruntu) return { toplam: 0, liste: [] };
  const raf = rafToplamlari(depo);
  const bek = bekleyenKabul(depo);
  const ara = String(q || '').trim();
  const qt = fuzzy.tokens(ara);
  const compact = qt.join('');
  const bc = goruntu.barcodes;
  const out = [];
  let toplam = 0;
  for (const p of goruntu.products) {
    const vs = vegaStok(p.id, depo);
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
  const konumlar = db
    .all('SELECT depo, shelf, qty, updated_at FROM location WHERE product_id=? AND qty>0 ORDER BY depo, qty DESC', pid)
    .map((k) => ({ ...k, depoAd: depoAdi(k.depo) }));
  const hareketler = db
    .all('SELECT * FROM movement WHERE product_id=? ORDER BY ts DESC, id DESC LIMIT 200', pid)
    .map((h) => ({ ...h, depoAd: depoAdi(h.depo) }));
  const kabul = belgeler()
    .filter((r) => r.lines.some((l) => l.productId === pid))
    .slice(0, 30)
    .map((r) => {
      const l = r.lines.find((x) => x.productId === pid);
      return { id: r.id, docNo: r.docNo, tur: r.tur, date: r.date, supplier: r.supplier, depoAd: r.depoAd, accepted: l.accepted, shelved: l.shelved, acik: r.acik };
    });
  // Depo depo özet: Vega stoku, raflar, bekleyen, yerleşmemiş.
  const depoSet = new Set(konumlar.map((k) => k.depo));
  if (goruntu) for (const [d, m] of goruntu.stokDepo) if (m.get(pid)) depoSet.add(d);
  for (const r of kabul) if (r.acik) depoSet.add(belgeler().find((x) => x.id === r.id)?.depo);
  const depolarOzet = [...depoSet]
    .filter((d) => d !== undefined)
    .sort((a, b) => a - b)
    .map((d) => {
      const vs = vegaStok(pid, d);
      const raf = konumlar.filter((k) => k.depo === d).reduce((t, k) => t + k.qty, 0);
      const bek = bekleyenKabul(d).get(pid) || 0;
      return { depo: d, depoAd: depoAdi(d), vegaStock: vs, raf: yuvarla(raf), bekleyen: yuvarla(bek), fark: yuvarla(vs - raf - bek) };
    });
  const vs = vegaStok(pid);
  const raf = konumlar.reduce((t, k) => t + k.qty, 0);
  const bek = bekleyenKabul().get(pid) || 0;
  return {
    urun: p ? { ...p, barcodes: goruntu.barcodes[pid] || [] } : { id: pid, code: '?', name: "Vega'da bulunamayan kart", unit: '' },
    vegaStock: vs,
    raf: yuvarla(raf),
    bekleyen: yuvarla(bek),
    fark: yuvarla(vs - raf - bek),
    depolar: depolarOzet,
    asilRaflar: db.all('SELECT depo, shelf FROM product_home WHERE product_id=?', pid).map((h) => ({ ...h, depoAd: depoAdi(h.depo) })),
    konumlar,
    hareketler,
    kabul,
  };
}

function raflar(depo = null) {
  const ozet = new Map(
    db.all('SELECT depo, shelf, COUNT(*) AS n, SUM(qty) AS q, MAX(updated_at) AS u FROM location WHERE qty>0 GROUP BY depo, shelf').map((r) => [`${r.depo}|${r.shelf}`, r]),
  );
  const rows = depo === null ? db.all('SELECT * FROM shelf ORDER BY depo, code') : db.all('SELECT * FROM shelf WHERE depo=? ORDER BY code', depo);
  return rows.map((s) => {
    const o = ozet.get(`${s.depo}|${s.code}`);
    return { ...s, depoAd: depoAdi(s.depo), cesit: o ? o.n : 0, miktar: o ? yuvarla(o.q) : 0, sonHareket: o ? o.u : null };
  });
}

function rafDetay(depo, code) {
  const c = rafKodu(code);
  const s = db.get('SELECT * FROM shelf WHERE depo=? AND code=?', depo, c);
  const icerik = db.all('SELECT product_id, qty, updated_at FROM location WHERE depo=? AND shelf=? AND qty>0', depo, c).map((l) => {
    const p = urun(l.product_id);
    return { productId: l.product_id, code: p ? p.code : '?', name: p ? p.name : "Vega'da bulunamayan kart", unit: p ? p.unit : '', qty: l.qty, updated_at: l.updated_at };
  });
  icerik.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  const hareketler = db.all('SELECT * FROM movement WHERE depo=? AND shelf=? ORDER BY ts DESC, id DESC LIMIT 100', depo, c);
  return { raf: s ? { ...s, depoAd: depoAdi(s.depo) } : null, depo, depoAd: depoAdi(depo), icerik, hareketler: hareketler.map((h) => ({ ...h, ...urunAdi(h.product_id) })) };
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
 * Sayım özeti, ürün başına, sayımın deposunda. "Olması gereken" depo stoku = o depodaki raflarda güncel
 * toplam + açık belgelerde rafa kaldırılmayı bekleyen. Vega'ya yazılacak fark bunun Vega stokundan farkı.
 */
function sayimOzet(id, { dahilSayilmayan = false } = {}) {
  const s = db.get('SELECT * FROM count_session WHERE id=?', id);
  if (!s) return null;
  const depo = s.depo;
  const satirlar = db.all('SELECT * FROM count_line WHERE session_id=? ORDER BY shelf, product_id', id);
  const raf = rafToplamlari(depo);
  const bek = bekleyenKabul(depo);
  const urunler = new Map();
  for (const l of satirlar) {
    if (!urunler.has(l.product_id)) urunler.set(l.product_id, { productId: l.product_id, sayilan: 0, onceki: 0, raflar: [] });
    const u = urunler.get(l.product_id);
    u.sayilan += l.counted;
    u.onceki += l.server_before;
    u.raflar.push(l.shelf);
  }
  if (dahilSayilmayan && goruntu) {
    for (const [pid, st] of goruntu.stokDepo.get(depo) || []) {
      if (!urunler.has(pid) && Math.abs(Number(st)) > EPS) urunler.set(pid, { productId: pid, sayilan: 0, onceki: 0, raflar: [], sayilmadi: true });
    }
  }
  const sayilanRaflar = new Set(satirlar.map((l) => l.shelf));
  const liste = [...urunler.values()].map((u) => {
    const p = urun(u.productId);
    const rafToplam = raf.get(u.productId)?.q || 0;
    const b = bek.get(u.productId) || 0;
    const vs = vegaStok(u.productId, depo);
    const hedef = yuvarla(rafToplam + b);
    return {
      ...u,
      sayilan: yuvarla(u.sayilan),
      onceki: yuvarla(u.onceki),
      code: p ? p.code : '?',
      name: p ? p.name : "Vega'da bulunamayan kart",
      unit: p ? p.unit : '',
      vegadaVar: Boolean(p),
      digerRaflar: yuvarla(rafToplam - (u.sayilmadi ? 0 : satirlarRafToplam(depo, id, u.productId))),
      bekleyen: yuvarla(b),
      hedef,
      vegaStock: vs,
      fark: yuvarla(hedef - vs),
    };
  });
  liste.sort((a, b) => Math.abs(b.fark) - Math.abs(a.fark) || a.name.localeCompare(b.name, 'tr'));
  const satirDetay = satirlar.map((l) => ({ ...l, ...urunAdi(l.product_id), fark: yuvarla(l.counted - l.server_before) }));
  return {
    oturum: { ...s, depoAd: depoAdi(depo), vega_docs: s.vega_docs ? JSON.parse(s.vega_docs) : null },
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

function satirlarRafToplam(depo, sessionId, productId) {
  // Sayılan raflardaki güncel miktar (sayım sonrası rafa kaldırma vb. olduysa onu da içerir).
  const r = db.get(
    `SELECT SUM(l.qty) AS q FROM location l WHERE l.depo=? AND l.product_id=? AND l.shelf IN (SELECT shelf FROM count_line WHERE session_id=? AND product_id=?)`,
    depo,
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
      sonuc = await vega.sayimYaz(config.load(), kalemler, { aciklama: `Sayım ${s.no}`, depo: s.depo });
      log.bilgi(`Sayım ${s.no} (${s.depoAd}) Vega'ya yazıldı: ${sonuc.docs.map((d) => d.belgeNo).join(', ') || 'fark yok'}`);
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
  depolar,
  depoAdi,
  varsayilanDepo,
  depoCoz,
  depoSuzgec,
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
