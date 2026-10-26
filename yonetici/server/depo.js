// Depo iş mantığı: Vega görüntüsü + programın kendi tabloları. Terminal ve yönetici ekranı buradan beslenir.
// Çok depo: raf, raf stoku, hareket ve sayım bir Vega deposuna bağlıdır (depo = F{firma}TBLDEPOLAR.IND).
// Mal kabul belgesi kendi deposunu taşır; rafa kaldırma o depoda olur.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const vega = require('./vega');
const log = require('./log');
const fuzzy = require('./fuzzy');
const kapsam = require('./kapsam');

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
const vegaDurum = {
  ok: false, hata: null, at: null, sureMs: null, calisiyor: false,
  // Okuma günlüğü: son deneme (başarılı ya da değil), kim tetikledi, bir sonraki zamanlı okuma, üst üste hata sayısı.
  deneme: null, tetik: null, sonraki: null, ardisikHata: 0, sureler: null, degisiklik: null,
};
let sonGoruntuOzet = '';
let vegaTurNo = 0;
let vegaBasladi = 0;
// Okuma bu kadar sürede bitmediyse takılmış sayılır (ağ sessizce koptu); yeni okuma başlayabilir.
const VEGA_TAKILMA_MS = 10 * 60 * 1000;

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

const sn1 = (ms) => (ms / 1000).toFixed(1);

/**
 * Vega'yı okur. `tetik`: zamanlayıcı, elle, ayar, açılış, sayım (günlükte ve Özet'te görünür).
 * Her deneme günlüğe yazılır. Vega'daki içerik bir öncekiyle aynıysa ana veri yeniden kurulmaz ve terminaller
 * boş yere uyarılmaz (sürüm sayacı artmaz).
 */
async function vegaYenile(tetik = 'elle') {
  if (vegaDurum.calisiyor) {
    if (now() - vegaBasladi < VEGA_TAKILMA_MS) return vegaDurum;
    log.uyari(`Önceki Vega okuması ${Math.round((now() - vegaBasladi) / 1000)} sn'dir bitmedi; yenisi başlatılıyor`);
  }
  const cfg = config.load();
  if (!vega.hazirMi(cfg.vega)) {
    vegaDurum.ok = false;
    vegaDurum.hata = 'Vega bağlantısı ayarlanmadı';
    return vegaDurum;
  }
  const tur = ++vegaTurNo;
  vegaDurum.calisiyor = true;
  vegaDurum.tetik = tetik;
  vegaDurum.deneme = now();
  const bas = (vegaBasladi = now());
  try {
    const { sureler, ...g } = await vega.goruntu(cfg);
    // Takılmış eski okuma sonradan dönerse yenisinin durumunu ezmesin.
    if (tur !== vegaTurNo) return vegaDurum;
    const ozet0 = ozet(JSON.stringify({ ...g, at: 0 }));
    const ayni = Boolean(goruntu) && ozet0 === sonGoruntuOzet;
    if (!ayni) {
      goruntuKur(g);
      db.run(
        "INSERT INTO vega_cache(key, json, updated_at) VALUES('goruntu', ?, ?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
        JSON.stringify(g),
        g.at,
      );
      sonGoruntuOzet = ozet0;
    }
    // yaz açıksa program alanın sahibi: karttan okunmaz, zimmetler karta yazılır (Vega okumasını bekletmeden).
    let zimmetDegisti = false;
    if (cfg.rafAdresi?.yaz) rafYazTetikle(0);
    else {
      vegaDurum.rafAdresi = vegaZimmetEsitle(cfg);
      zimmetDegisti = Boolean(vegaDurum.rafAdresi.degisen);
    }
    const sureMs = now() - bas;
    if (vegaDurum.ardisikHata > 0) log.bilgi(`Vega yeniden okundu (${vegaDurum.ardisikHata} başarısız denemeden sonra)`);
    Object.assign(vegaDurum, { ok: true, hata: null, at: g.at, sureMs, onbellek: false, ardisikHata: 0, sureler, degisiklik: !ayni });
    const yavas = sureMs > 5000 ? ` [${Object.entries(sureler).map(([k, v]) => `${k} ${sn1(v)}`).join(', ')}]` : '';
    log.bilgi(`Vega okundu (${tetik}): ${g.products.length} kart, ${ayni ? 'değişiklik yok' : 'değişti'}, ${sn1(sureMs)} sn${yavas}`);
    if (!ayni || zimmetDegisti) degisti();
  } catch (e) {
    if (tur !== vegaTurNo) return vegaDurum;
    vegaDurum.ardisikHata++;
    Object.assign(vegaDurum, { ok: false, hata: e.message, sureMs: now() - bas, degisiklik: null });
    // İlk hata ayrıntılı (yığınla), tekrarları kısa: günlük şişmesin.
    if (vegaDurum.ardisikHata === 1) log.hata(`Vega okunamadı (${tetik})`, e);
    else log.uyari(`Vega hâlâ okunamıyor (${vegaDurum.ardisikHata}. deneme, ${tetik}): ${e.message}`);
  } finally {
    if (tur === vegaTurNo) vegaDurum.calisiyor = false;
  }
  return vegaDurum;
}

let zamanlayici = null;
function vegaZamanla() {
  clearInterval(zamanlayici);
  const sn = Math.max(15, Number(config.load().yenileme) || 60);
  vegaDurum.sonraki = now() + sn * 1000;
  zamanlayici = setInterval(() => {
    vegaDurum.sonraki = now() + sn * 1000;
    vegaYenile('zamanlayıcı').catch(() => {});
  }, sn * 1000);
  zamanlayici.unref?.();
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

const RAF_DESEN = /^[A-Z0-9ÇĞİÖŞÜ][A-Z0-9ÇĞİÖŞÜ\-./ ]{0,23}$/;
function rafKoduGecerli(code) {
  return RAF_DESEN.test(rafKodu(code));
}

function rafVarMi(depo, code) {
  return Boolean(db.get('SELECT 1 FROM shelf WHERE depo=? AND code=?', depo, rafKodu(code)));
}

/**
 * Yönetici ekranından toplu raf. `secim` depo numarası ya da "hepsi" (kullanılan her depo; terminal rafı yalnız
 * tanımlı olduğu depoda kabul eder). Bir kod uygun değilse hiçbiri açılmaz.
 */
function raflarAc(secim, kodlar, { zone, note = '' } = {}) {
  const k = kodlar.map(rafKodu).filter(Boolean);
  if (!k.length) throw new Ret('Raf kodu girin');
  if (k.length > 5000) throw new Ret('Bir seferde en çok 5000 raf');
  const bad = k.find((c) => !rafKoduGecerli(c));
  if (bad) throw new Ret(`Geçersiz raf kodu: ${bad}`);
  const ds = secim === 'hepsi' ? depolar().map((d) => d.ind) : [depoCoz(secim)];
  let eklenen = 0;
  db.tx(() => {
    for (const d of ds) {
      for (const c of k) {
        if (!rafVarMi(d, c)) eklenen++;
        rafEkle(d, c, { zone, note });
      }
    }
  });
  degisti();
  return { eklenen, toplam: k.length * ds.length };
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

// ---- Zimmet (ürünün asıl rafları) ------------------------------------------------------------
// Ürün bir depoda birden çok rafa zimmetli olabilir; rafta hiç yokken de o rafta "beklenen" görünür.
// Kaynak: IMPORT (Excel), VEGA (stok kartındaki raf adresi alanı), ADMIN (yönetici ekranı).
// VEGA kaynaklı zimmet her Vega okumasında karttan yeniden kurulur; programdan silinmez.

function zimmetler(depo, productId) {
  return db.all('SELECT shelf, source FROM product_home WHERE depo=? AND product_id=? ORDER BY shelf', depo, String(productId));
}

function zimmetEkle(depo, productId, shelf, source = 'ADMIN') {
  const c = rafKodu(shelf);
  db.run(
    'INSERT INTO product_home(depo, product_id, shelf, source, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(depo, product_id, shelf) DO UPDATE SET updated_at=excluded.updated_at',
    depo,
    String(productId),
    c,
    source,
    now(),
  );
  rafYazTetikle();
  return c;
}

function zimmetSil(depo, productId, shelf) {
  const c = rafKodu(shelf);
  const z = db.get('SELECT source FROM product_home WHERE depo=? AND product_id=? AND shelf=?', depo, String(productId), c);
  if (!z) return false;
  if (z.source === 'VEGA') throw new Ret(`${c} adresi Vega stok kartından geliyor; Vega'da karttaki raf adresinden silin`);
  db.run('DELETE FROM product_home WHERE depo=? AND product_id=? AND shelf=?', depo, String(productId), c);
  rafYazTetikle();
  return true;
}

/**
 * Terminalde ürün bir rafa konunca (rafa kaldırma, transfer hedefi, sayımda bulunma) o raf ürünün adresi olur ve
 * rafAdresi.yaz açıksa Vega kartının raf alanına (Ortaş KOD10) yazılır. Excel ve yönetici zimmetlerine dokunulmaz.
 */
function terminalZimmet(depo, productId, shelf) {
  zimmetEkle(depo, productId, shelf, 'TERMINAL');
}

/** Raf boşalınca yalnız terminalden gelen zimmet kalkar; Excel/yönetici/Vega zimmeti bilinçli bir karardır. */
function terminalZimmetBosalt(depo, productId, shelf) {
  const c = rafKodu(shelf);
  const z = db.get('SELECT source FROM product_home WHERE depo=? AND product_id=? AND shelf=?', depo, String(productId), c);
  if (!z || z.source !== 'TERMINAL') return;
  db.run('DELETE FROM product_home WHERE depo=? AND product_id=? AND shelf=?', depo, String(productId), c);
  rafYazTetikle();
}

/** Karttaki raf adresi metni → raf kodları. Virgül, noktalı virgül, | ya da satır sonu ayırır. */
function adresleriAyir(metin) {
  return [...new Set(String(metin || '').split(/[,;|\r\n]+/).map(rafKodu).filter(Boolean))];
}

let sonZimmetUyari = '';

/** Vega kartlarındaki raf adreslerini VEGA kaynaklı zimmetlere çevirir; kartta olmayan VEGA zimmeti silinir. */
function vegaZimmetEsitle(cfg = config.load()) {
  const alan = goruntu && goruntu.rafAlan;
  const d = Number(cfg.rafAdresi?.depo) || varsayilanDepo();
  // Alan başka bilgi için de kullanılmış olabilir (Ortaş KOD14: 4.131 kartta araç modeli). Varsayılan olarak yalnız
  // programda tanımlı raf kodları zimmet olur; yeniRafAc açıksa karttaki her uygun kod raf olarak açılır.
  const yeniRafAc = Boolean(cfg.rafAdresi?.yeniRafAc);
  const istenen = new Map();
  const gecersiz = [];
  const tanimsiz = new Map();
  if (alan) {
    for (const p of goruntu.products) {
      if (!p.raf) continue;
      for (const c of adresleriAyir(p.raf)) {
        if (!RAF_DESEN.test(c)) {
          if (gecersiz.length < 50) gecersiz.push({ code: p.code, adres: c });
          continue;
        }
        if (!yeniRafAc && !rafVarMi(d, c)) {
          tanimsiz.set(c, (tanimsiz.get(c) || 0) + 1);
          continue;
        }
        istenen.set(`${d}|${p.id}|${c}`, { depo: d, pid: p.id, shelf: c });
      }
    }
  }
  let eklenen = 0;
  let silinen = 0;
  let yeniRaf = 0;
  db.tx(() => {
    for (const z of db.all("SELECT depo, product_id, shelf FROM product_home WHERE source='VEGA'")) {
      if (istenen.delete(`${z.depo}|${z.product_id}|${z.shelf}`)) continue;
      db.run('DELETE FROM product_home WHERE depo=? AND product_id=? AND shelf=?', z.depo, z.product_id, z.shelf);
      silinen++;
    }
    for (const z of istenen.values()) {
      if (!rafVarMi(z.depo, z.shelf)) {
        rafEkle(z.depo, z.shelf, { source: 'VEGA', note: 'Vega stok kartından' });
        yeniRaf++;
      }
      // Excel ya da elle verilmiş aynı zimmet varsa kaynağı VEGA olur; artık kart yönetir.
      db.run(
        `INSERT INTO product_home(depo, product_id, shelf, source, updated_at) VALUES(?,?,?, 'VEGA', ?)
         ON CONFLICT(depo, product_id, shelf) DO UPDATE SET source='VEGA', updated_at=excluded.updated_at`,
        z.depo,
        z.pid,
        z.shelf,
        now(),
      );
      eklenen++;
    }
  });
  const toplam = db.get("SELECT COUNT(*) AS n, COUNT(DISTINCT product_id) AS u FROM product_home WHERE source='VEGA'");
  if (eklenen || silinen) log.bilgi(`Vega raf adresleri: ${eklenen} eklendi, ${silinen} silindi, ${yeniRaf} yeni raf`);
  // Uyarı her Vega okumasında değil, sayı değişince yazılır.
  const uyari = `${gecersiz.length}|${tanimsiz.size}`;
  if ((gecersiz.length || tanimsiz.size) && uyari !== sonZimmetUyari) {
    log.uyari(`Vega raf adresi: ${tanimsiz.size} tanımsız değer, ${gecersiz.length >= 50 ? '50+' : gecersiz.length} uygun olmayan (ör. ${gecersiz.slice(0, 3).map((g) => `${g.code}=${g.adres}`).join(', ')})`);
  }
  sonZimmetUyari = uyari;
  // Raf deposu "Kullanılan depolar"da değilse zimmetler terminale gitmez.
  const kullanilmiyor = Boolean(alan) && !depolar().some((x) => x.ind === d);
  if (kullanilmiyor) log.uyari(`Raf adresi deposu (${d}) kullanılan depolar arasında değil`);
  // Tanımsız adresler en sık geçenden: "PASSAT 61 kart" gibi raf olmayan bilgi buradan görülür.
  const tanimsizListe = [...tanimsiz.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([adres, kart]) => ({ adres, kart }));
  return { alan: alan || null, depo: d, adres: toplam.n, urun: toplam.u, yeniRaf, degisen: eklenen + silinen + yeniRaf, gecersiz, tanimsiz: tanimsiz.size, tanimsizListe, kullanilmiyor };
}

// ---- Zimmetleri Vega kartına yazma (rafAdresi.yaz) ------------------------------------------
// Ortaş kararı (2026-10-23): raf adresi KOD10'da; alandaki eski bilgi (MENŞEİ: ASYA, AVRUPA…) silinir, yalnız
// programın raf adresleri yazılır. Kartın ilk değeri vega_alan.eski'de kalır. Vega'da alan elle değiştirilirse
// sonraki yazmada programdaki zimmet geçerli olur (sayısı "elle" olarak bildirilir).

let rafYazZaman = null;
let rafYaziyor = null;
let rafYazTekrar = false;

/** Zimmet değişince kısa bir gecikmeyle karta yazar; art arda değişiklikler tek yazmada toplanır. */
function rafYazTetikle(ms = 3000) {
  if (!goruntu || !config.load().rafAdresi?.yaz) return;
  clearTimeout(rafYazZaman);
  rafYazZaman = setTimeout(() => {
    vegaRafYaz().catch((e) => {
      vegaDurum.rafAdresi = { ...vegaDurum.rafAdresi, yaz: true, hata: e.message };
      log.hata("Raf adresleri Vega'ya yazılamadı", e);
    });
  }, ms);
  rafYazZaman.unref?.();
}

/** Raf deposundaki zimmetleri kartların raf adresi alanına yazar; yalnız Vega'daki değeri farklı olan kartlar. */
async function vegaRafYaz(cfg = config.load()) {
  if (rafYaziyor) {
    rafYazTekrar = true;
    return rafYaziyor;
  }
  rafYaziyor = rafYazCalistir(cfg).finally(() => {
    rafYaziyor = null;
    if (rafYazTekrar) {
      rafYazTekrar = false;
      rafYazTetikle(0);
    }
  });
  return rafYaziyor;
}

async function rafYazCalistir(cfg) {
  const alan = goruntu && goruntu.rafAlan;
  if (!cfg.rafAdresi?.yaz) return null;
  if (!alan) {
    // Sessiz kalmasın: Ayarlar ve Özet'te görünür.
    const ad = String(cfg.rafAdresi?.alan || '').trim();
    const hata = ad ? `${ad} alanı Vega stok kartlarında bulunamadı` : 'Raf adresi yazılsın seçili ama stok kartı alanı boş (Ortaş: KOD10)';
    if (vegaDurum.rafAdresi?.hata !== hata) log.uyari(`Raf adresi Vega'ya yazılamıyor: ${hata}`);
    vegaDurum.rafAdresi = { alan: ad || null, yaz: true, hata, at: now() };
    return vegaDurum.rafAdresi;
  }
  const d = Number(cfg.rafAdresi?.depo) || varsayilanDepo();
  const bas = now();
  // Alanın sahibi artık program: önceden karttan okunmuş zimmetler programdan yönetilir.
  db.run("UPDATE product_home SET source='ADMIN' WHERE source='VEGA'");
  const uz = (await vega.kartAlanUzunluk(cfg, alan)) || 50;
  const raflar = new Map();
  for (const z of db.all('SELECT product_id, shelf FROM product_home WHERE depo=? ORDER BY shelf', d)) {
    if (!raflar.has(z.product_id)) raflar.set(z.product_id, []);
    raflar.get(z.product_id).push(z.shelf);
  }
  const kayit = new Map(db.all('SELECT product_id, yazilan FROM vega_alan WHERE alan=?', alan).map((r) => [r.product_id, r.yazilan]));
  const yazilacak = [];
  const sigmayan = [];
  let elle = 0;
  for (const p of goruntu.products) {
    let deger = '';
    for (const r of raflar.get(p.id) || []) {
      const s = deger ? `${deger}, ${r}` : r;
      if (s.length > uz) {
        sigmayan.push(p.code);
        break;
      }
      deger = s;
    }
    const mevcut = p.raf || '';
    if (mevcut === deger) continue;
    // Program yazdıktan sonra Vega'da değiştirilmiş.
    if (kayit.has(p.id) && kayit.get(p.id) !== null && kayit.get(p.id) !== mevcut) elle++;
    yazilacak.push({ id: p.id, deger, mevcut });
  }
  // Önce ilk değer saklanır; yazma yarıda kalsa da eski bilgi kaybolmaz.
  db.tx(() => {
    for (const s of yazilacak) {
      db.run('INSERT INTO vega_alan(alan, product_id, eski, yazilan, updated_at) VALUES(?,?,?,NULL,?) ON CONFLICT(alan, product_id) DO NOTHING', alan, s.id, s.mevcut, now());
    }
  });
  await vega.kartAlanYaz(cfg, alan, yazilacak, (parca) => {
    db.tx(() => {
      for (const s of parca) {
        db.run('UPDATE vega_alan SET yazilan=?, updated_at=? WHERE alan=? AND product_id=?', s.deger, now(), alan, s.id);
        const p = urunIndex.get(s.id);
        if (p) {
          if (s.deger) p.raf = s.deger;
          else delete p.raf;
        }
      }
    });
  });
  const toplam = db.get('SELECT COUNT(*) AS n, COUNT(DISTINCT product_id) AS u FROM product_home WHERE depo=?', d);
  if (yazilacak.length) log.bilgi(`Raf adresleri Vega'ya yazıldı (${alan}): ${yazilacak.length} kart${elle ? `, ${elle} kartta Vega'daki elle değişiklik ezildi` : ''}`);
  if (sigmayan.length) log.uyari(`${alan} alanına sığmayan raf adresi: ${sigmayan.length} kart (ör. ${sigmayan.slice(0, 3).join(', ')}); ilk raflar yazıldı`);
  const kullanilmiyor = !depolar().some((x) => x.ind === d);
  // Kartta tek alan var: yalnız raf deposunun zimmetleri yazılır. Başka depodaki zimmetler görünür olsun.
  const baska = db.get('SELECT COUNT(*) AS n, COUNT(DISTINCT product_id) AS u FROM product_home WHERE depo<>?', d);
  vegaDurum.rafAdresi = {
    alan,
    depo: d,
    depoAd: depoAdi(d),
    yaz: true,
    adres: toplam.n,
    urun: toplam.u,
    baskaDepo: baska.n,
    yazilan: yazilacak.length,
    elle,
    sigmayan: sigmayan.length,
    sigmayanListe: sigmayan.slice(0, 20),
    uzunluk: uz,
    at: now(),
    sureMs: now() - bas,
    kullanilmiyor,
  };
  if (yazilacak.length) degisti();
  return vegaDurum.rafAdresi;
}

/** Yönetici: ürünü bir raftan diğerine taşır (qty boşsa raftakinin hepsi); istenirse zimmet de taşınır. */
function tasi(depo, productId, from, to, qty = null, { zimmetTasi = false, kim = 'yönetici' } = {}) {
  const pid = String(productId);
  const a = rafKodu(from);
  const b = rafKodu(to);
  if (!a || !b) throw new Ret('Kaynak ve hedef raf gerekli');
  if (a === b) throw new Ret('Kaynak ve hedef raf aynı');
  if (!RAF_DESEN.test(b)) throw new Ret(`Raf kodu uygun değil: ${b}`);
  const mevcut = miktar(depo, pid, a);
  const q = qty === null || qty === undefined || qty === '' ? mevcut : Number(qty);
  if (!Number.isFinite(q) || q < 0) throw new Ret('Miktar geçersiz');
  if (q - mevcut > EPS) throw new Ret(`${a} rafında ${mevcut} var; ${q} taşınamaz`);
  const zimmet = db.get('SELECT source FROM product_home WHERE depo=? AND product_id=? AND shelf=?', depo, pid, a);
  if (q <= EPS && !(zimmetTasi && zimmet)) throw new Ret(`${a} rafında bu ürün yok`);
  const h = { ts: now(), user: kim, device: 'PC' };
  db.tx(() => {
    if (!rafVarMi(depo, b)) rafEkle(depo, b);
    if (q > EPS) {
      miktarEkle(depo, pid, a, -q, { ...h, kind: 'TRANSFER_OUT', ref: b });
      miktarEkle(depo, pid, b, q, { ...h, kind: 'TRANSFER_IN', ref: a });
    }
    // Vega'dan gelen zimmet kartta durduğu sürece kalır; yeni raf elle zimmetlenir.
    if (zimmetTasi && zimmet) {
      zimmetEkle(depo, pid, b, zimmet.source === 'VEGA' ? 'ADMIN' : zimmet.source);
      if (zimmet.source !== 'VEGA') zimmetSil(depo, pid, a);
    }
  });
  return { tasinan: yuvarla(q) };
}

/** Raftaki bütün ürünleri ve programdan verilmiş zimmetleri hedef rafa aktarır (raf silinmeden önce). */
function rafBosalt(depo, code, hedef) {
  const a = rafKodu(code);
  const b = rafKodu(hedef);
  if (!b) throw new Ret('Hedef raf gerekli');
  if (a === b) throw new Ret('Kaynak ve hedef raf aynı');
  let urun = 0;
  let zimmet = 0;
  db.tx(() => {
    const pids = new Set(db.all('SELECT product_id FROM location WHERE depo=? AND shelf=? AND qty>0', depo, a).map((r) => r.product_id));
    for (const r of db.all("SELECT product_id FROM product_home WHERE depo=? AND shelf=? AND source<>'VEGA'", depo, a)) pids.add(r.product_id);
    for (const pid of pids) {
      const z = Boolean(db.get("SELECT 1 FROM product_home WHERE depo=? AND product_id=? AND shelf=? AND source<>'VEGA'", depo, pid, a));
      if (miktar(depo, pid, a) > EPS) urun++;
      if (z) zimmet++;
      tasi(depo, pid, a, b, null, { zimmetTasi: z });
    }
  });
  return { urun, zimmet };
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
      terminalZimmet(depo, pid, shelf);
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
      if (miktar(depo, pid, from) <= EPS) terminalZimmetBosalt(depo, pid, from);
      terminalZimmet(depo, pid, to);
      return;
    }
    case 'COUNT_SUBMIT':
      sayimKaydet(op, p, { ...h, ts: now() }, ts);
      return;
    case 'SHELF_ADD': {
      // Terminalde okutulan tanımsız raf etiketi orada raf olarak eklenir.
      const kod = rafKodu(p.code);
      if (!rafKoduGecerli(kod)) throw new Ret(`Geçersiz raf kodu: ${kod}`);
      const d = depoCoz(p.depot);
      if (!rafVarMi(d, kod)) {
        rafEkle(d, kod, { source: 'TERMINAL', note: `${device} · ${user}` });
        log.bilgi(`Terminalden raf eklendi: ${kod} (${depoAdi(d)}) · ${device} · ${user}`);
      }
      return;
    }
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
  // Kapatılmış (onay bekleyen) sayıma geç gelen gönderim alınır; iptal ya da onaylanmış sayım raf miktarını değiştirmez.
  if (s.status === 'CANCELLED') throw new Ret(`${s.no} yönetici programında iptal edildi`);
  if (s.status === 'APPROVED') throw new Ret(`${s.no} onaylandı; artık sayım gönderilemez`);
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
    db.run(
      `INSERT INTO count_shelf(session_id, shelf, user, device, submitted_at) VALUES(?,?,?,?,?)
       ON CONFLICT(session_id, shelf) DO UPDATE SET user=excluded.user, device=excluded.device, submitted_at=excluded.submitted_at`,
      sid,
      raf,
      h.user,
      h.device,
      now(),
    );
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
      // Rafta bulunan ve hiçbir adresi olmayan ürünün adresi o raf olur; rafta olmadığı sayılan ürünün terminal adresi kalkar.
      if (x.counted > EPS) {
        if (!zimmetler(depo, pid).length) terminalZimmet(depo, pid, raf);
      } else terminalZimmetBosalt(depo, pid, raf);
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

/** Terminale giden ana verinin tamamı (nesne). `master()` tek parça, `masterParcalari()` kovalara bölünmüş verir. */
function masterGovde() {
  if (!goruntu) {
    const e = new Error('Vega verisi henüz alınamadı. Yönetici programında Vega bağlantısını kontrol edin.');
    e.status = 503;
    throw e;
  }
  const cfg = config.load();
  const acik = belgeler().filter((r) => r.acik);
  // Sıra sabit olmalı: Vega ürünleri her yenilemede farklı sırayla verebiliyor; sıra değişince ETag ve kova özetleri
  // de değişip terminaller (2 dakikada bir) değişmemiş veriyi baştan indiriyordu.
  const locations = db.all('SELECT depo, product_id, shelf, qty FROM location WHERE qty > 0 ORDER BY depo, product_id, shelf');
  const ref = new Set(locations.map((l) => l.product_id));
  for (const h of db.all('SELECT DISTINCT product_id FROM product_home')) ref.add(h.product_id);
  for (const r of acik) for (const l of r.lines) ref.add(l.productId);

  const tum = cfg.urun.kapsam === 'tum';
  // Pasif kart terminale gitmez; yalnız programda bir rafta duruyorsa (raf stoku görünsün, kaldırılabilsin) gider.
  const rafta = new Set(locations.map((l) => l.product_id));
  const products = [];
  const gonderilen = new Set();
  for (const p of goruntu.products) {
    const toplam = goruntu.stokToplam.get(p.id);
    if (p.pasif && !rafta.has(p.id)) continue;
    if (!tum && !ref.has(p.id) && !toplam && !goruntu.movedSet.has(p.id)) continue;
    gonderilen.add(p.id);
    const stocks = {};
    for (const [d, m] of goruntu.stokDepo) {
      const q = m.get(p.id);
      if (q) stocks[d] = Number(q);
    }
    products.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, vegaStock: Number(toplam || 0), stocks, barcodes: [...(goruntu.barcodes[p.id] || [])].sort() });
  }
  products.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const depoListe = depolar();
  const vars = varsayilanDepo();
  const counts = db
    .all("SELECT id, no, title, blind, depo, scope FROM count_session WHERE status='OPEN' ORDER BY created_at")
    .map((c) => ({ id: c.id, no: c.no, title: c.title, blind: Boolean(c.blind), depot: c.depo, scope: c.scope ? c.scope.split(',') : [] }));
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
    // Ürünün zimmetli rafları (Excel, Vega kartı, yönetici): rafa kaldırmada önerilir, sayımda rafta beklenir.
    homes: db
      .all('SELECT depo, product_id, shelf FROM product_home ORDER BY depo, product_id, shelf')
      .filter((h) => gonderilen.has(h.product_id))
      .map((h) => ({ depot: h.depo, productId: h.product_id, shelf: h.shelf })),
    receipts: acik
      .map((r) => ({
        id: r.id,
        docNo: r.docNo,
        supplier: r.supplier,
        date: r.date,
        depot: r.depo,
        depotName: r.depoAd,
        lines: r.lines
          .filter((l) => gonderilen.has(l.productId))
          .map((l) => ({ id: l.id, productId: l.productId, accepted: l.accepted, shelved: l.shelved }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }))
      .filter((r) => r.lines.length),
    counts,
    users,
  };
  const apk = require('./apk').bilgi();
  if (apk) govde.app = { versionName: apk.versionName, versionCode: apk.versionCode, path: '/apk' };
  return govde;
}

function ozet(json) {
  return crypto.createHash('sha1').update(json).digest('base64').slice(0, 27);
}

/** Eski terminaller (1.2.1 ve öncesi): bütün ana veri tek JSON. */
function master() {
  if (masterCache && masterCache.surum === surum) return masterCache;
  const json = JSON.stringify(masterGovde());
  masterCache = { surum, json, etag: '"' + ozet(json) + '"', boyut: json.length };
  return masterCache;
}

// ---- Ana veri, parça parça (1.3.0+) -----------------------------------------------------------
//
// 130 bin ürünlük liste her işlemden sonra baştan inince eski terminaller donuyordu. Ürünler kimliklerinin
// özetine göre sabit KOVA_SAYISI kovaya bölünür; ürünün stokları, barkodları, raf konumları ve zimmetleri kendi
// kovasındadır. Terminal elindeki parçaların özetini yollar, yalnız değişenler gelir (bir rafa kaldırma = bir kova)
// ve her parça terminalde ayrı kısa bir işlemle yazılır. "head" (depo, belge, sayım, kullanıcı) ve "shelves" ayrı parça.

const KOVA_SAYISI = 64;

/** FNV-1a 32 bit, UTF-16 kod birimleri üzerinden. Terminaldeki `Buckets.of` ile aynı olmalı. */
function kova(id) {
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % KOVA_SAYISI;
}

let parcaCache = null;

/**
 * Map: anahtar ("head", "shelves", "b0".."b63", v2'de ayrıca "q0".."q63") → { hash, json }. Sıra: head, shelves,
 * kovalar, stok parçaları.
 *
 * v2 (1.5.0+ terminal): Vega stoku (`vegaStock`, `stocks`) kovadan ayrılıp stok parçasına (q) konur. Vega'da satış
 * olunca stok her turda değişir; kovanın içinde olsa bütün kovalar (yüzlerce KB) yeniden inerdi. Artık kova yalnız
 * rafa kaldırma/transfer/zimmet ile değişir, stok parçası ~50 KB'dır. v1 (eski terminal) kovada stokla birlikte alır.
 */
function masterParcalari(v = 1) {
  if (!parcaCache || parcaCache.surum !== surum) parcaCache = { surum, v1: null, v2: null };
  const onbellek = v >= 2 ? 'v2' : 'v1';
  if (parcaCache[onbellek]) return parcaCache[onbellek];
  const g = masterGovde();
  const kovalar = Array.from({ length: KOVA_SAYISI }, () => ({ products: [], locations: [], homes: [] }));
  const stoklar = Array.from({ length: KOVA_SAYISI }, () => []);
  for (const p of g.products) {
    const k = kova(p.id);
    if (v >= 2) {
      const { vegaStock, stocks, ...govde } = p;
      kovalar[k].products.push(govde);
      if (vegaStock || Object.keys(stocks).length) stoklar[k].push({ id: p.id, vs: vegaStock, st: stocks });
    } else kovalar[k].products.push(p);
  }
  for (const l of g.locations) kovalar[kova(l.productId)].locations.push(l);
  for (const h of g.homes) kovalar[kova(h.productId)].homes.push(h);
  const { products, locations, homes, shelves, ...head } = g;
  const parcalar = new Map();
  const ekle = (k, x) => {
    const json = JSON.stringify(x);
    parcalar.set(k, { hash: ozet(json), json });
  };
  ekle('head', head);
  ekle('shelves', shelves);
  kovalar.forEach((x, i) => ekle('b' + i, x));
  if (v >= 2) stoklar.forEach((x, i) => ekle('q' + i, { items: x }));
  parcaCache[onbellek] = parcalar;
  return parcalar;
}

/**
 * Terminalin bilmediği ya da değişmiş parçalar, en çok `en` kova. head, shelves ve stok parçaları sınırdan sayılmaz.
 * Dönen JSON metni: { buckets, surum, parts: [{ key, hash, data }], remaining }. `surum`: bu verinin değişiklik sayacı
 * (terminal `GET /api/changes?since=` ile bunu bekler).
 *
 * v2'de stok parçası kovasına bağlıdır: kova bu cevapta geliyorsa (terminal kovayı yazarken stokunu siler) ya da
 * terminalde güncel kova varsa gönderilir; kovası eski kalan terminale stok parçası gönderilmez.
 */
function masterParcaCevabi(bilinen = {}, en = 8, v = 1) {
  const parcalar = masterParcalari(v);
  const giden = [];
  const gidenKova = new Set();
  let kalan = 0;
  for (const [k, p] of parcalar) {
    if (k[0] === 'q' && k !== 'q') continue; // stok parçaları aşağıda
    if (bilinen[k] === p.hash) continue;
    if (k[0] === 'b' && gidenKova.size >= en) {
      kalan++;
      continue;
    }
    if (k[0] === 'b') gidenKova.add(k);
    giden.push({ k, p });
  }
  if (v >= 2) {
    for (let i = 0; i < KOVA_SAYISI; i++) {
      const q = parcalar.get('q' + i);
      const b = parcalar.get('b' + i);
      const kovaGelir = gidenKova.has('b' + i);
      const kovaGuncel = bilinen['b' + i] === b.hash;
      if (!kovaGelir && !kovaGuncel) continue;
      if (!kovaGelir && bilinen['q' + i] === q.hash) continue;
      giden.push({ k: 'q' + i, p: q });
    }
  }
  const govde = giden.map(({ k, p }) => `{"key":${JSON.stringify(k)},"hash":${JSON.stringify(p.hash)},"data":${p.json}}`).join(',');
  return `{"buckets":${KOVA_SAYISI},"surum":${surum},"parts":[${govde}],"remaining":${kalan}}`;
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
  const zimmetli = new Set(
    (depo === null ? db.all('SELECT DISTINCT product_id FROM product_home') : db.all('SELECT DISTINCT product_id FROM product_home WHERE depo=?', depo)).map((r) => r.product_id),
  );
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
    if (filtre === 'adressiz' && !(vs > EPS && !r && !zimmetli.has(p.id))) continue;
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
    asilRaflar: db
      .all('SELECT depo, shelf, source FROM product_home WHERE product_id=? ORDER BY depo, shelf', pid)
      .map((h) => ({ ...h, depoAd: depoAdi(h.depo), qty: yuvarla(miktar(h.depo, pid, h.shelf)) })),
    rafAdresi: p && p.raf ? p.raf : '',
    konumlar,
    hareketler,
    kabul,
  };
}

function raflar(depo = null) {
  const ozet = new Map(
    db.all('SELECT depo, shelf, COUNT(*) AS n, SUM(qty) AS q, MAX(updated_at) AS u FROM location WHERE qty>0 GROUP BY depo, shelf').map((r) => [`${r.depo}|${r.shelf}`, r]),
  );
  // Zimmetli ürün sayısı ve bunlardan rafta hiç olmayanlar (sayılmayı bekleyen).
  const zim = new Map(
    db
      .all(
        `SELECT h.depo, h.shelf, COUNT(*) AS n, SUM(CASE WHEN l.qty IS NULL OR l.qty<=0 THEN 1 ELSE 0 END) AS bos
         FROM product_home h LEFT JOIN location l ON l.depo=h.depo AND l.product_id=h.product_id AND l.shelf=h.shelf
         GROUP BY h.depo, h.shelf`,
      )
      .map((r) => [`${r.depo}|${r.shelf}`, r]),
  );
  const rows = depo === null ? db.all('SELECT * FROM shelf ORDER BY depo, code') : db.all('SELECT * FROM shelf WHERE depo=? ORDER BY code', depo);
  return rows.map((s) => {
    const o = ozet.get(`${s.depo}|${s.code}`);
    const z = zim.get(`${s.depo}|${s.code}`);
    return { ...s, depoAd: depoAdi(s.depo), cesit: o ? o.n : 0, miktar: o ? yuvarla(o.q) : 0, sonHareket: o ? o.u : null, zimmet: z ? z.n : 0, bekleyen: z ? z.bos : 0 };
  });
}

function rafDetay(depo, code) {
  const c = rafKodu(code);
  const s = db.get('SELECT * FROM shelf WHERE depo=? AND code=?', depo, c);
  // Raftakiler + rafa zimmetli olup rafta olmayanlar (qty 0, sayılmayı bekliyor).
  const zim = new Map(db.all('SELECT product_id, source FROM product_home WHERE depo=? AND shelf=?', depo, c).map((z) => [z.product_id, z.source]));
  const satir = (pid, qty, updated_at) => {
    const p = urun(pid);
    return { productId: pid, code: p ? p.code : '?', name: p ? p.name : "Vega'da bulunamayan kart", unit: p ? p.unit : '', qty, updated_at, zimmet: zim.get(pid) || null };
  };
  const icerik = db.all('SELECT product_id, qty, updated_at FROM location WHERE depo=? AND shelf=? AND qty>0', depo, c).map((l) => satir(l.product_id, l.qty, l.updated_at));
  const rafta = new Set(icerik.map((x) => x.productId));
  for (const pid of zim.keys()) if (!rafta.has(pid)) icerik.push(satir(pid, 0, null));
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
  const sayilanRaflar = new Set([...satirlar.map((l) => l.shelf), ...db.all('SELECT shelf FROM count_shelf WHERE session_id=?', id).map((r) => r.shelf)]);
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
  const onekler = s.scope ? s.scope.split(',') : [];
  let kapsamOzet = null;
  if (onekler.length) {
    const raflarK = kapsamRaflari(depo, onekler);
    const kalan = raflarK.filter((r) => !sayilanRaflar.has(r));
    kapsamOzet = {
      onekler,
      raf: raflarK.length,
      sayilan: raflarK.length - kalan.length,
      kalan: kalan.slice(0, 2000),
      kalanAdet: kalan.length,
      disinda: [...sayilanRaflar].filter((r) => !kapsam.kapsamda(r, onekler)).sort(),
    };
  }
  return {
    oturum: { ...s, depoAd: depoAdi(depo), vega_docs: s.vega_docs ? JSON.parse(s.vega_docs) : null },
    kapsam: kapsamOzet,
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

/** Depoda kapsama uyan tanımlı raflar (terminal de yalnız tanımlı rafı kabul eder). */
function kapsamRaflari(depo, onekler) {
  return db
    .all('SELECT code FROM shelf WHERE depo=?', depo)
    .map((r) => r.code)
    .filter((c) => kapsam.kapsamda(c, onekler))
    .sort((a, b) => a.localeCompare(b, 'tr', { numeric: true }));
}

/**
 * Raf sayımında kapsam seçimi için depodaki raflar, Ortaş'ın adlandırmasına göre: ilk parça bölge (KAT, KO, KUTU,
 * DEPO, TK2…), ilk iki parça grup (KAT-1, KAT-B, KO-4). Üçten az rafı olan grup (yazım hatası, tek tük adres) listelenmez;
 * bölgenin tamamı seçilince onlar da sayılır.
 */
function rafGruplari(depo) {
  const bolgeler = new Map();
  for (const { code } of db.all('SELECT code FROM shelf WHERE depo=?', depo)) {
    const [b, g] = code.split('-');
    if (!bolgeler.has(b)) bolgeler.set(b, { onek: b, adet: 0, gruplar: new Map() });
    const x = bolgeler.get(b);
    x.adet++;
    if (g !== undefined && g !== '') {
      const k = `${b}-${g}`;
      x.gruplar.set(k, (x.gruplar.get(k) || 0) + 1);
    }
  }
  const sirala = (a, b) => a.localeCompare(b, 'tr', { numeric: true });
  return [...bolgeler.values()]
    .map((x) => ({
      onek: x.onek,
      adet: x.adet,
      gruplar: [...x.gruplar].filter(([, n]) => n >= 3).map(([onek, adet]) => ({ onek, adet })).sort((a, b) => sirala(a.onek, b.onek)),
    }))
    .sort((a, b) => b.adet - a.adet || sirala(a.onek, b.onek));
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
  if (sonuc) vegaYenile('sayım').catch(() => {});
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
  vegaYenile('sayım geri alındı').catch(() => {});
}

module.exports = {
  _goruntuKur: goruntuKur,
  degisti,
  dinle,
  surum: () => surum,
  masterParcaCevabi,
  kova,
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
  raflarAc,
  rafKodu,
  rafKoduGecerli,
  zimmetler,
  zimmetEkle,
  zimmetSil,
  adresleriAyir,
  vegaZimmetEsitle,
  vegaRafYaz,
  rafYazTetikle,
  tasi,
  rafBosalt,
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
  kapsamRaflari,
  rafGruplari,
  sayimOzet,
  sayimOnayla,
  sayimGeriAl,
  Ret,
};
