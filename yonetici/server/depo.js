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
const yetki = require('./yetki');
const bekleme = require('./bekleme');
const { tekSeferde, mesgul } = require('./tekseferde');

const EPS = 1e-9;
// Depo hareket fişinden gelen belge türleri (ayarda "D37" gibi seçilir); vega.js ile aynı.
const DEPO_BELGE_TIP = new Set([37, 128, 129]);
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
  // depo → (ürün → Vega stoku); toplam ürün başına. Sanal bekleme depoları hedef depoda toplanır, belgeleri hedefte görünür
  // (bekleme.js); ham liste g.receipts, g.depolar, stokHam olarak durur.
  const gor = bekleme.gorunum(g, bekleme.ayar());
  goruntu.belgeGorunum = gor.belgeler;
  goruntu.depoGorunum = gor.depolar;
  goruntu.stokDepo = gor.stokDepo;
  goruntu.stokHam = gor.stokHam;
  goruntu.stokToplam = new Map();
  for (const m of goruntu.stokDepo.values()) for (const [pid, q] of m) goruntu.stokToplam.set(pid, (goruntu.stokToplam.get(pid) || 0) + Number(q));
  goruntu.movedSet = new Set(g.moved || []);
  goruntu.depoAd = new Map((g.depolar || []).map((d) => [Number(d.ind), d.ad]));
  aramaIndex = null;
}

/** Ayar değişince (bekleme depoları) son Vega görüntüsü yeniden yorumlanır; Vega yeniden okunmaz. */
function yenidenKur() {
  if (goruntu) goruntuKur(goruntu);
  degisti();
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
    // Filigran her okumada değişebilir (başka depoda satış); içerik özetine girmez, yoksa terminaller boş yere uyarılırdı.
    const ozet0 = ozet(JSON.stringify({ ...g, at: 0, filigran: 0, filigranAt: 0 }));
    const ayni = Boolean(goruntu) && ozet0 === sonGoruntuOzet;
    if (!ayni) {
      // Önbelleğe ham görüntü yazılır; yorumlanmış hali her açılışta o anki ayarla yeniden kurulur.
      const json = JSON.stringify(g);
      goruntuKur(g);
      db.run(
        "INSERT INTO vega_cache(key, json, updated_at) VALUES('goruntu', ?, ?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
        json,
        g.at,
      );
      sonGoruntuOzet = ozet0;
    } else {
      // İçerik aynı: stok bu filigranda da aynıdır.
      goruntu.filigran = g.filigran;
      goruntu.filigranAt = g.filigranAt;
    }
    filigranKaydet(g);
    // Güncellemeyle gelen B2B raf listesi (varsa, bir kez): ürünlerin asıl rafları. Hata Vega okumasını bozmaz.
    try {
      require('./iceaktar').otomatik();
    } catch (e) {
      log.hata('Paketle gelen raf listesi aktarılamadı', e);
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
    // Açık gönderimler ayrı okunur (transfer.js); hata Vega okumasını bozmaz.
    require('./transfer').yenile().catch(() => {});
    // Canlı sayım: bu okumadan önce gönderilmiş sayımların Vega farkı dondurulur.
    sayimDondur().catch((e) => log.hata('Sayım farkı dondurulamadı', e));
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
  if (goruntu && goruntu.depoGorunum && goruntu.depoGorunum.length) return goruntu.depoGorunum.map((d) => ({ ind: Number(d.ind), ad: d.ad }));
  return db.all('SELECT DISTINCT depo FROM shelf ORDER BY depo').map((r) => ({ ind: r.depo, ad: String(r.depo) }));
}

function depoAdi(depo) {
  const d = Number(depo);
  return (goruntu && goruntu.depoAd.get(d)) || String(d);
}

function varsayilanDepo() {
  const cfg = config.load();
  const v = bekleme.fiziksel(cfg.vega.depo);
  const liste = depolar();
  if (Number.isInteger(v) && v > 0 && (!liste.length || liste.some((d) => d.ind === v))) return v;
  return liste[0] ? liste[0].ind : Number.isInteger(v) ? v : 0;
}

/** İstekten gelen depo; yoksa ya da geçersizse varsayılan. Sanal bekleme deposu malın durduğu depoya çevrilir (kuyruktaki eski işlem de). */
function depoCoz(x) {
  const n = Number(x);
  return Number.isInteger(n) && x !== null && x !== '' && x !== undefined ? bekleme.fiziksel(n) : varsayilanDepo();
}

/** Yönetim ekranı süzgeci: boş / "hepsi" → null (bütün depolar). */
function depoSuzgec(x) {
  if (x === undefined || x === null || x === '' || x === 'hepsi') return null;
  const n = Number(x);
  return Number.isInteger(n) ? bekleme.fiziksel(n) : null;
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

// ---- Özel raflar (config.ozelRaflar; Ortaş: SIPARIS SATIS) -----------------------------------
// Fiziksel raf değil: mal kabulden doğrudan sipariş hazırlığına giden mal "rafa kaldırıldı" sayılsın diye okutulan barkod.
// Rafa kaldırma hareketi yazılır (rafa bekleyen düşer, kim ne zaman kaldırdı görünür) ama rafta stok satırı oluşmaz, ürüne
// raf adresi (zimmet) verilmez, dolayısıyla Vega kartının raf alanına bir şey yazılmaz. Raf sınırı da bu rafa uygulanmaz.

function ozelRaflar() {
  const l = config.load().ozelRaflar;
  return Array.isArray(l) ? [...new Set(l.map(rafKodu).filter(Boolean))] : [];
}

function ozelRafMi(code) {
  const c = rafKodu(code);
  return Boolean(c) && ozelRaflar().includes(c);
}

/** Özel raf yalnız rafa kaldırmada kullanılır; raftan alma, transfer, sayım, raf düzenleme gibi stok gerektiren işlemde reddedilir. */
function ozelRafReddet(...kodlar) {
  const k = kodlar.map(rafKodu).find((c) => ozelRafMi(c));
  if (k) throw new Ret(`${k} özel raftır (stok tutulmaz); yalnız rafa kaldırmada kullanılır`);
}

/** Özel rafa hareket: stok satırına dokunmadan yalnız hareket kaydı (rafa bekleyen hesabı hareketlerden okunur). */
function ozelHareket(depo, productId, shelf, delta, hareket) {
  const d = yuvarla(delta);
  if (Math.abs(d) <= EPS) return 0;
  db.run(
    'INSERT INTO movement(ts, fiili_ts, depo, product_id, shelf, delta, after, kind, ref, user, device, op_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    hareket.ts || now(),
    hareket.fiili || hareket.ts || now(),
    depo,
    String(productId),
    shelf,
    d,
    0,
    hareket.kind,
    hareket.ref || null,
    hareket.user || null,
    hareket.device || null,
    hareket.opId || null,
  );
  return d;
}

/**
 * Bir kez (özel raf başına): özel raf olmadan önce o koda yazılmış stok ve terminal/Excel/yönetici adresleri silinir. Özel rafta stok
 * tutulmaz; eski adres kalırsa Vega kartının raf alanında "SIPARIS SATIS" görünmeye devam eder (adres yazımı açıksa bu çağrı karttan da kaldırır).
 */
function ozelRafTemizle() {
  let stok = 0;
  let adres = 0;
  db.tx(() => {
    for (const kod of ozelRaflar()) {
      const anahtar = `ozelRafTemizlik:${kod}`;
      if (db.meta(anahtar)) continue;
      stok += db.run('DELETE FROM location WHERE shelf=?', kod).changes;
      adres += db.run('DELETE FROM product_home WHERE shelf=?', kod).changes;
      db.set(anahtar, String(now()));
    }
  });
  if (stok || adres) {
    log.bilgi(`Özel raf temizliği: ${stok} stok satırı, ${adres} raf adresi silindi`);
    rafYazTetikle(0);
    degisti();
  }
  return { stok, adres };
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
      'INSERT INTO movement(ts, fiili_ts, depo, product_id, shelf, delta, after, kind, ref, user, device, op_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      hareket.ts || now(),
      hareket.fiili || hareket.ts || now(),
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

/** İşlem kalıcı reddedildi. `code` verilirse terminal nedene göre davranır (YETKI: ana veriyi baştan indirmez). */
class Ret extends Error {
  constructor(mesaj, code = null) {
    super(mesaj);
    this.code = code;
  }
}

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
 * Paketle gelen B2B raf listesi (IMPORT) depodan bağımsızdır ama kullanılan her depoya ayrı kopyalanır (iceaktar.otomatik):
 * Toybelen'in TK2-L15 adresi Merkez'de de adres olur. Bir depoda adres silinince öteki depolardaki aynı liste kopyası da kalkar
 * (o depoda o rafta mal yoksa); yoksa terminal "MERKEZ deposunda adresi" diye göstermeye, Vega kartının raf alanı da yazmaya
 * devam ederdi (Toybelen, 2026-11-05). Elle, terminalden ya da Vega'dan verilmiş adrese dokunulmaz.
 */
function importKopyalariSil(depo, productId, shelf) {
  const c = rafKodu(shelf);
  const pid = String(productId);
  let n = 0;
  for (const k of db.all("SELECT depo FROM product_home WHERE product_id=? AND shelf=? AND source='IMPORT' AND depo<>?", pid, c, depo)) {
    if (miktar(k.depo, pid, c) > EPS) continue;
    db.run('DELETE FROM product_home WHERE depo=? AND product_id=? AND shelf=?', k.depo, pid, c);
    n++;
  }
  if (n) rafYazTetikle();
  return n;
}

/** Terminalden ya da yönetici ekranından adres silme: bu depodaki adres + öteki depolardaki B2B liste kopyaları. */
function adresSil(depo, productId, shelf) {
  const ok = zimmetSil(depo, productId, shelf);
  return { ok, kopya: importKopyalariSil(depo, productId, shelf) };
}

/**
 * Bir kez (2.2.0 ilk açılışı): bugüne kadar terminalden silinmiş adreslerin öteki depolarda kalan B2B liste kopyaları silinir.
 * Adres o depoda sonradan yeniden verildiyse (rafa kaldırma vb.) dokunulmaz.
 */
function silinenAdresKopyalari() {
  if (db.meta('importKopyaTemizlik')) return 0;
  let n = 0;
  db.tx(() => {
    for (const o of db.all("SELECT payload FROM op WHERE type='HOME_REMOVE' AND ok=1 ORDER BY created_at")) {
      let p;
      try {
        p = JSON.parse(o.payload);
      } catch {
        continue;
      }
      const pid = String(p.productId || '');
      const shelf = rafKodu(p.shelf);
      if (!pid || !shelf) continue;
      let d;
      try {
        d = depoCoz(p.depot);
      } catch {
        continue;
      }
      if (db.get('SELECT 1 FROM product_home WHERE depo=? AND product_id=? AND shelf=?', d, pid, shelf)) continue;
      n += importKopyalariSil(d, pid, shelf);
    }
    db.set('importKopyaTemizlik', String(now()));
  });
  if (n) {
    log.bilgi(`Silinmiş raf adreslerinin öteki depolardaki B2B liste kopyaları temizlendi: ${n} adres`);
    degisti();
  }
  return n;
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
        // Özel raf (SIPARIS SATIS) ürünün adresi olamaz; kartta kalmışsa zimmet olmaz, yazımda karttan kalkar.
        if (ozelRafMi(c)) continue;
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
    const hata = ad ? `${ad} alanı Vega stok kartlarında bulunamadı` : 'Raf adresi yazılsın seçili ama stok kartı alanı boş. "Stok kartı alanı" kutusuna KOD10 yazıp Kaydet\'e basın (Ortaş: KOD10)';
    if (vegaDurum.rafAdresi?.hata !== hata) log.uyari(`Raf adresi Vega'ya yazılamıyor: ${hata}`);
    vegaDurum.rafAdresi = { alan: ad || null, yaz: true, hata, at: now() };
    return vegaDurum.rafAdresi;
  }
  const d = Number(cfg.rafAdresi?.depo) || varsayilanDepo();
  const bas = now();
  // Alanın sahibi artık program: önceden karttan okunmuş zimmetler programdan yönetilir.
  db.run("UPDATE product_home SET source='ADMIN' WHERE source='VEGA'");
  const uz = (await vega.kartAlanUzunluk(cfg, alan)) || 50;
  const tum = cfg.rafAdresi?.tumDepolar !== false;
  const raflar = new Map();
  const zimmetSatirlari = tum
    ? db.all('SELECT DISTINCT product_id, shelf FROM product_home ORDER BY shelf')
    : db.all('SELECT product_id, shelf FROM product_home WHERE depo=? ORDER BY shelf', d);
  for (const z of zimmetSatirlari) {
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
  const toplam = tum
    ? db.get('SELECT COUNT(DISTINCT product_id || shelf) AS n, COUNT(DISTINCT product_id) AS u FROM product_home')
    : db.get('SELECT COUNT(*) AS n, COUNT(DISTINCT product_id) AS u FROM product_home WHERE depo=?', d);
  if (yazilacak.length) log.bilgi(`Raf adresleri Vega'ya yazıldı (${alan}): ${yazilacak.length} kart${elle ? `, ${elle} kartta Vega'daki elle değişiklik ezildi` : ''}`);
  if (sigmayan.length) log.uyari(`${alan} alanına sığmayan raf adresi: ${sigmayan.length} kart (ör. ${sigmayan.slice(0, 3).join(', ')}); ilk raflar yazıldı`);
  const kullanilmiyor = !tum && !depolar().some((x) => x.ind === d);
  // tumDepolar kapalıysa kartta yalnız raf deposunun zimmetleri olur; başka depodakiler sayılıp görünür kılınır.
  const baska = tum ? { n: 0 } : db.get('SELECT COUNT(*) AS n, COUNT(DISTINCT product_id) AS u FROM product_home WHERE depo<>?', d);
  vegaDurum.rafAdresi = {
    alan,
    depo: d,
    depoAd: tum ? 'bütün depolar' : depoAdi(d),
    tumDepolar: tum,
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

/**
 * Yönetici: terminalden yapılan rafa kaldırmayı geri alır (yanlış raf, ürün ya da miktar). Raf stoku düşülür; belge satırına bağlıysa
 * belgede kalan miktar geri gelir (terminalde yeniden rafa kaldırılabilir); raf boşalırsa terminalden verilmiş raf adresi de kalkar.
 * Vega'ya yazılmış bir fiş olmadığından Vega'ya dokunulmaz (raf adresi yazımı açıksa kartın raf alanı güncellenir).
 * Rafta o miktar kalmadıysa (sonradan raftan alındı, taşındı) geri alınmaz. Her hareket bir kez geri alınır.
 */
function rafaKaldirmaGeriAl(hareketId, kim = 'yönetici', not = '') {
  const m = db.get('SELECT * FROM movement WHERE id=?', Number(hareketId));
  if (!m) throw new Ret('Hareket bulunamadı');
  if (m.kind !== 'PUTAWAY') throw new Ret('Yalnız rafa kaldırma geri alınabilir');
  if (m.geri_at) throw new Ret('Bu rafa kaldırma zaten geri alındı');
  const q = yuvarla(m.delta);
  if (q <= EPS) throw new Ret('Geri alınacak miktar yok');
  const kayit = m.op_id ? db.get('SELECT payload FROM op WHERE id=?', m.op_id) : null;
  let p = {};
  try {
    p = kayit ? JSON.parse(kayit.payload) : {};
  } catch {
    p = {};
  }
  const satirId = p.lineId ? String(p.lineId) : null;
  // Belgeye bağlı olup işlem kaydı kalmamış eski satır: raf düşülür ama belgede "rafa kalktı" görünür kalırdı.
  if (!kayit && m.ref) throw new Ret('Bu eski kayıt geri alınamaz (işlem kaydı yok); Raflar sayfasından düzeltin');
  // Sanal bekleme deposunda yapılmış eski kayıt: raf kaydı artık malın durduğu depoda.
  const d = depoCoz(m.depo);
  // Özel rafta (SIPARIS SATIS) stok tutulmaz: geri almada düşülecek raf stoku yoktur, yalnız hareket ve belge satırı geri alınır.
  const ozel = ozelRafMi(m.shelf);
  const mevcut = ozel ? q : miktar(d, m.product_id, m.shelf);
  if (q - mevcut > EPS) {
    throw new Ret(`${m.shelf} rafında şu an ${yuvarla(mevcut)} var; ${q} geri alınamaz (sonradan raftan alınmış, taşınmış ya da sayılmış). Önce Raflar sayfasından düzeltin`);
  }
  const notu = String(not || '').trim().slice(0, 300) || null;
  db.tx(() => {
    const geri = { ts: now(), user: kim, device: 'PC', kind: 'PUTAWAY_GERI', ref: m.ref || null };
    if (ozel) ozelHareket(d, m.product_id, m.shelf, -q, geri);
    else miktarEkle(d, m.product_id, m.shelf, -q, geri);
    if (satirId) {
      db.run('UPDATE receipt_shelved SET shelved = MAX(shelved - ?, 0), updated_at=? WHERE line_id=?', q, now(), satirId);
      bekleme.mahsupGeri(satirId, q);
    }
    if (!ozel && miktar(d, m.product_id, m.shelf) <= EPS) terminalZimmetBosalt(d, m.product_id, m.shelf);
    db.run('UPDATE movement SET geri_at=?, geri_user=?, geri_not=? WHERE id=?', now(), kim, notu, m.id);
  });
  log.bilgi(`Rafa kaldırma geri alındı: ${m.shelf} · ürün ${m.product_id} · ${q} (${depoAdi(d)}) · ${kim}${notu ? ` · ${notu}` : ''}`);
  degisti();
  // Gizlenen grup içi belge (bekleme.js) yeniden açılmaz; terminalde bekleyen bir satırı yok.
  return { geriAlinan: q, raf: m.shelf, belgeSatiri: Boolean(satirId && (!p.receiptId || receiptById(String(p.receiptId)))) };
}

/** İşlemi yapan kullanıcının yetki nesnesi; kayıtlı değilse (silinmiş, bilinmeyen ad) null = sınırsız. */
function yetkiBaglam(kullanici) {
  const ad = String(kullanici || '').trim().toLowerCase();
  if (!ad) return null;
  return yetki.baglam(db.get('SELECT username, perms, depots, shelves FROM app_user WHERE username=?', ad), depoAdi);
}

/**
 * Terminal saatindeki bir anı sunucu saatine çevirir. `saatFarki` = sunucu saati − terminal saati (gönderimdeki `sentAt`'ten);
 * bilinmiyorsa (eski terminal) null döner. Gelecekteki an sunucunun şimdisine kırpılır.
 */
function terminalAni(t, saatFarki) {
  const x = Number(t);
  if (saatFarki === null || saatFarki === undefined || !Number.isFinite(x) || x <= 0) return null;
  return Math.min(now(), Math.round(x + saatFarki));
}

function islemUygula(op, cihaz, kullanici, { saatFarki = null } = {}) {
  const p = op.payload || {};
  const user = String(p.user || kullanici || '');
  const device = String(p.device || cihaz || '');
  const ts = Number(op.createdAt) || now();
  // `fiili`: işin terminalde yapıldığı an (sunucu saatiyle). Terminal çevrimdışı kaldıysa iş sunucuya geç gelir; canlı sayım
  // "sayıldıktan sonra rafa ne oldu" sorusunu bu ana göre sorar. Saat farkı bilinmiyorsa işlendiği an.
  const h = { ts: now(), fiili: terminalAni(op.createdAt, saatFarki) ?? now(), user, device, opId: op.id, saatFarki };
  // Terminal ürünleri ana veriden alır; tanınmayan kimlik (demo verisi, başka kurulum) raf stokuna girmesin.
  const bilinen = (pid) => {
    if (goruntu && !urun(pid)) throw new Ret(`Ürün Vega'da bulunamadı (${pid})`);
  };
  // Kullanıcı yetkisi (yetki.js): izin, çalışabileceği depo ve raf sınırı. Kayıtlı olmayan kullanıcı sınırsız sayılır.
  const yk = yetkiBaglam(user);
  const yetkiDenetle = (izin, depoNo = null, raf = null) => {
    const m = yk && yk.denetle(izin, depoNo, raf);
    if (m) {
      log.uyari(`Yetkisiz işlem ${op.type} ${op.id}: ${m} · ${device}`);
      throw new Ret(m, 'YETKI');
    }
  };
  yetkiDenetle(yetki.ISLEM_IZNI[op.type] || null);

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
      // Ürün bazlı bekleyen listeden (BEK-) gelen kaldırma belgesiz kaydedilir; bekleyen miktar hareketlerden hesaplanır (bekleyenUrunler).
      const bekSatir = String(p.lineId || '').startsWith('BEK-') || String(p.receiptId || '').startsWith('BEK-');
      const belge = p.receiptId && !bekSatir ? receiptById(String(p.receiptId)) : null;
      // Terminal eşitlemeden önce gizlenmiş grup içi belge (bekleme.js): mal yine rafa kondu, miktar açık fatura satırına yazılır.
      const gizli = p.receiptId && !belge && !bekSatir && goruntu ? goruntu.receipts.find((r) => r.id === String(p.receiptId)) : null;
      const depo = belge ? belge.depo : depoCoz(p.depot);
      const ref = belge ? belge.docNo : gizli ? gizli.docNo : bekSatir ? null : p.receiptId || null;
      if (ozelRafMi(shelf)) {
        // Özel raf (SIPARIS SATIS): rafa bekleyen düşer; rafta stok yok, ürüne adres verilmez, Vega'ya bir şey yazılmaz. Raf sınırı uygulanmaz.
        yetkiDenetle(null, depo);
        ozelHareket(depo, pid, shelf, qty, { ...h, kind: 'PUTAWAY', ref });
      } else {
        yetkiDenetle(null, depo, shelf);
        // Mal fiziken rafa kondu; raf tanımı sonradan silinmiş olsa bile kayıt kaybolmasın.
        if (!rafVarMi(depo, shelf)) rafEkle(depo, shelf, { source: 'TERMINAL', note: 'Terminalden geldi' });
        miktarEkle(depo, pid, shelf, qty, { ...h, kind: 'PUTAWAY', ref });
        terminalZimmet(depo, pid, shelf);
      }
      if (p.lineId && !bekSatir) {
        db.run(
          `INSERT INTO receipt_shelved(line_id, receipt_id, product_id, shelved, updated_at) VALUES(?,?,?,?,?)
           ON CONFLICT(line_id) DO UPDATE SET shelved = shelved + excluded.shelved, updated_at = excluded.updated_at`,
          String(p.lineId),
          String(p.receiptId || ''),
          pid,
          qty,
          now(),
        );
        if (gizli) bekleme.gecikmisKayit(String(p.lineId), pid, qty);
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
      ozelRafReddet(from, to);
      bilinen(pid);
      const depo = depoCoz(p.depot);
      yetkiDenetle(null, depo, from);
      yetkiDenetle(null, depo, to);
      if (from === to) throw new Ret('Kaynak ve hedef raf aynı');
      if (!rafVarMi(depo, to)) rafEkle(depo, to, { source: 'TERMINAL', note: 'Terminalden geldi' });
      // Sunucudaki miktar terminalin gördüğünden azsa eksiye düşmez; fazlası hareket kaydında görünür.
      miktarEkle(depo, pid, from, -qty, { ...h, kind: 'TRANSFER_OUT', ref: to });
      miktarEkle(depo, pid, to, qty, { ...h, kind: 'TRANSFER_IN', ref: from });
      if (miktar(depo, pid, from) <= EPS) terminalZimmetBosalt(depo, pid, from);
      terminalZimmet(depo, pid, to);
      return;
    }
    case 'PICK': {
      // Raftan alma (sevkiyat, üretim, satış için çıkan mal): raf stoku azalır, Vega'ya bir şey yazılmaz.
      const qty = sayi(p.qty, 'Miktar');
      if (qty <= 0) throw new Ret('Miktar sıfırdan büyük olmalı');
      const pid = String(p.productId || '');
      const shelf = rafKodu(p.shelf);
      if (!pid || !shelf) throw new Ret('Eksik bilgi');
      ozelRafReddet(shelf);
      bilinen(pid);
      const depo = depoCoz(p.depot);
      yetkiDenetle(null, depo, shelf);
      // Sunucuda raftaki miktar terminalin gördüğünden azsa eksiye düşmez (miktarAyarla sıfırda keser).
      miktarEkle(depo, pid, shelf, -qty, { ...h, kind: 'PICK', ref: String(p.note || '').slice(0, 120) || null });
      if (miktar(depo, pid, shelf) <= EPS) terminalZimmetBosalt(depo, pid, shelf);
      return;
    }
    case 'HOME_REMOVE': {
      // Terminalden yalnız ürünün raf adresi (zimmet) silinir; raf ve raftaki miktar değişmez. Adres yoksa sessizce geçer.
      const pid = String(p.productId || '');
      const shelf = rafKodu(p.shelf);
      if (!pid || !shelf) throw new Ret('Eksik bilgi');
      bilinen(pid);
      const d = depoCoz(p.depot);
      yetkiDenetle(null, d, shelf);
      const s = adresSil(d, pid, shelf);
      if (s.ok || s.kopya) log.bilgi(`Raf adresi silindi: ${shelf} · ürün ${pid} (${depoAdi(d)}${s.kopya ? ` + ${s.kopya} depodaki liste kopyası` : ''}) · ${device} · ${user}`);
      return;
    }
    case 'COUNT_SUBMIT':
      // Terminalde kendiliğinden açılan serbest sayım ayrı izin ister (yönetici açtığı sayıma gönderim `count`).
      if (String(p.sessionId || '').startsWith('LOCAL-')) yetkiDenetle('count_free');
      sayimKaydet(op, p, { ...h, ts: now() }, ts, yetkiDenetle);
      return;
    case 'SHELF_ARRANGE':
      rafDuzenle(p, { ...h, ts: now() }, ts, yetkiDenetle);
      return;
    case 'SHELF_ADD': {
      // Terminalde okutulan tanımsız raf etiketi orada raf olarak eklenir.
      const kod = rafKodu(p.code);
      if (!rafKoduGecerli(kod)) throw new Ret(`Geçersiz raf kodu: ${kod}`);
      // Özel raf zaten her terminalde tanımlıdır (ana veride specialShelves); raf kaydı açılmaz.
      if (ozelRafMi(kod)) return;
      const d = depoCoz(p.depot);
      yetkiDenetle(null, d, kod);
      if (!rafVarMi(d, kod)) {
        rafEkle(d, kod, { source: 'TERMINAL', note: `${device} · ${user}` });
        log.bilgi(`Terminalden raf eklendi: ${kod} (${depoAdi(d)}) · ${device} · ${user}`);
      }
      return;
    }
    case 'TRANSFER_SEND':
    case 'TRANSFER_RECEIVE':
      // Depolar arası transfer: raf stoku burada, Vega'ya 128/129 fişi arka planda yazılır (transfer.js).
      // Gönderimde gönderen (çıkış) depo, kabulde alan depo kullanıcının çalışabileceği depo olmalı.
      require('./transfer').uygula(op, p, h, { Ret, bilinen, yetkiDenetle, rafIzinli: (raf) => !yk || yk.rafVar(raf) });
      return;
    default:
      throw new Ret(`Bilinmeyen işlem türü: ${op.type}`);
  }
}

function sayimKaydet(op, p, h, olusturma, yetkiDenetle = () => {}) {
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
  yetkiDenetle(null, depo);
  const ref = s.no;
  const { raflar, satirlar } = rafGonderimi(p);
  // Kullanıcının raf sınırı dışındaki raf gönderimde varsa hiçbiri uygulanmaz (işlem tek SQLite işleminde geri alınır).
  for (const raf of raflar) yetkiDenetle(null, depo, raf);
  // Canlı sayım (2.2.0+ terminal): rafın açıldığı ve ürünün son okutulduğu an. Yoksa (eski terminal) raf okutulana eşitlenir.
  const zaman = sayimZamanlari(p, satirlar, h.saatFarki);
  const gonderim = now();
  // Ürün başına sayımın fiziksel zaman aralığı: ilk = ürünün sayıldığı rafın en erken açılışı, son = en geç okutulduğu an.
  const urunAraligi = new Map();
  for (const raf of raflar) {
    if (!rafVarMi(depo, raf)) rafEkle(depo, raf, { source: 'TERMINAL', note: 'Sayımdan geldi' });
    db.run(
      `INSERT INTO count_shelf(session_id, shelf, user, device, submitted_at) VALUES(?,?,?,?,?)
       ON CONFLICT(session_id, shelf) DO UPDATE SET user=excluded.user, device=excluded.device, submitted_at=excluded.submitted_at`,
      sid,
      raf,
      h.user,
      h.device,
      gonderim,
    );
    const rz = zaman && zaman.raf.get(raf);
    const canli = rz ? { acilis: rz.start, satirAni: zaman.satir, opId: h.opId } : null;
    rafiOkutulanaCek(depo, raf, satirlar, olusturma, { ...h, kind: 'COUNT', ref }, (pid, x, once, k1) => {
      db.run(
        `INSERT INTO count_line(session_id, shelf, product_id, terminal_system, server_before, counted, user, device, submitted_at,
           ref_ts, hareket_sonra, hareket_arada)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, shelf, product_id) DO UPDATE SET terminal_system=excluded.terminal_system,
           server_before=excluded.server_before, counted=excluded.counted, user=excluded.user, device=excluded.device,
           submitted_at=excluded.submitted_at, ref_ts=excluded.ref_ts, hareket_sonra=excluded.hareket_sonra, hareket_arada=excluded.hareket_arada`,
        sid,
        raf,
        pid,
        x.system,
        once,
        x.counted,
        h.user,
        h.device,
        gonderim,
        k1 ? k1.ref : null,
        k1 ? k1.sonra : 0,
        k1 ? k1.arada : 0,
      );
      const a = urunAraligi.get(pid) || { ilk: Infinity, son: -Infinity, zamanli: true };
      if (k1) {
        a.ilk = Math.min(a.ilk, canli.acilis);
        a.son = Math.max(a.son, k1.ref);
      } else {
        a.zamanli = false;
        a.ilk = Math.min(a.ilk, gonderim);
        a.son = Math.max(a.son, gonderim);
      }
      urunAraligi.set(pid, a);
    }, { canli });
  }
  // Vega farkı sonraki Vega okumasında dondurulur (sayimDondur); ürün aynı sayımda yeniden gönderilirse aralık genişler.
  for (const [pid, a] of urunAraligi) {
    db.run(
      `INSERT INTO count_urun(session_id, product_id, ilk_ts, son_ts, gonderim_at, zamanli, durum) VALUES(?,?,?,?,?,?,'BEKLIYOR')
       ON CONFLICT(session_id, product_id) DO UPDATE SET ilk_ts=MIN(ilk_ts, excluded.ilk_ts), son_ts=MAX(son_ts, excluded.son_ts),
         gonderim_at=excluded.gonderim_at, zamanli=MIN(zamanli, excluded.zamanli), durum='BEKLIYOR'`,
      sid,
      pid,
      a.ilk,
      a.son,
      gonderim,
      a.zamanli ? 1 : 0,
    );
  }
  if (urunAraligi.size) sayimDondurmaIste();
}

/**
 * Terminalin gönderdiği sayım zamanları sunucu saatiyle: `raf` raf → { start, end } (rafın ilk açıldığı / son okutulduğu an),
 * `satir` "raf|ürün" → ürünün o rafta son okutulduğu an. Saat farkı ya da zaman bilgisi yoksa null (eski terminal).
 */
function sayimZamanlari(p, satirlar, saatFarki) {
  if (saatFarki === null || saatFarki === undefined || !Array.isArray(p.shelfTimes)) return null;
  const raf = new Map();
  for (const t of p.shelfTimes) {
    const kod = rafKodu(t && t.shelf);
    const start = terminalAni(t && t.start, saatFarki);
    if (!kod || start === null) continue;
    raf.set(kod, { start, end: terminalAni(t.end, saatFarki) ?? start });
  }
  const satir = new Map();
  for (const l of satirlar) {
    const at = terminalAni(l.at, saatFarki);
    if (at !== null) satir.set(`${rafKodu(l.shelf)}|${String(l.productId)}`, at);
  }
  // Satırı zamanlı olup açılışı gelmeyen raf: açılış en erken okutma; okutma açılıştan önce görünüyorsa açılış ona çekilir.
  for (const [k, at] of satir) {
    const r = k.slice(0, k.lastIndexOf('|'));
    const x = raf.get(r);
    if (!x) raf.set(r, { start: at, end: at });
    else if (at < x.start) x.start = at;
  }
  return raf.size ? { raf, satir } : null;
}

/**
 * Rafta `alt` anından sonra (ve verilirse `ust`e kadar) yapılan net hareket; sayım hareketleri ve bu işlemin kendi hareketi
 * hariç. Anlar fiili (terminalde yapıldığı) zamandır.
 */
function rafNetHareket(depo, raf, pid, alt, ust = null, opId = null) {
  const r = db.get(
    `SELECT SUM(delta) AS q FROM movement WHERE depo=? AND shelf=? AND product_id=? AND fiili_ts > ? AND (? IS NULL OR fiili_ts <= ?)
       AND kind <> 'COUNT' AND (? IS NULL OR op_id IS NULL OR op_id <> ?)`,
    depo,
    raf,
    String(pid),
    alt,
    ust,
    ust,
    opId,
    opId,
  );
  return yuvarla(r?.q || 0);
}

/**
 * Terminalin sayım / raf düzenleme gönderimindeki raflar ve satırlar. Vega'da olmayan ürün satırı (demo verisi) yok
 * sayılır; gönderimin geri kalanı geçerli. Satırı olup `shelves`'te yazmayan raf da gönderilmiş sayılır.
 */
function rafGonderimi(p) {
  const raflar = [...new Set((p.shelves || []).map(rafKodu).filter(Boolean))];
  const satirlar = (Array.isArray(p.lines) ? p.lines : []).filter((l) => !goruntu || urun(String(l.productId)));
  for (const l of satirlar) {
    const raf = rafKodu(l.shelf);
    if (raf && !raflar.includes(raf)) raflar.push(raf);
  }
  // Özel rafta stok tutulmadığından sayılamaz ve düzenlenemez.
  ozelRafReddet(...raflar);
  return { raflar, satirlar };
}

/**
 * Rafın içeriğini terminalde okutulan değere çeker (sayım ve raf düzenleme ortak). `kaydet(pid, {counted, system}, once)`
 * her ürün için çağrılır (sayım satır kaydını burada tutar).
 */
function rafiOkutulanaCek(depo, raf, satirlar, olusturma, hareket, kaydet = null, { okutulmayaniDokunma = false, farkEkle = false, canli = null, adresHep = false } = {}) {
  const sayilan = new Map();
  const rafSatirlari = satirlar.filter((x) => rafKodu(x.shelf) === raf);
  for (const l of rafSatirlari) {
    const pid = String(l.productId);
    sayilan.set(pid, { counted: Math.max(0, sayi(l.counted, 'Sayılan')), system: Number(l.system) || 0 });
  }
  // Rafta sunucuya göre olup terminalin bilmediği ürün: gönderimden önce yerleştiyse okutulmadı = 0 demektir;
  // sonra yerleştiyse (başka terminal) dokunulmaz. Raf düzenlemenin "okutulmayana dokunma" modunda okutulmayan ürün raftan
  // çıkmaz; yalnız rafı hiç ürün okutmadan "boş" bildirilmişse (satırı yok) bütün içerik çıkar.
  if (canli) {
    // Canlı sayım: rafta sunucuya göre olup okutulmayan her ürün 0 sayılmıştır; raf açıldıktan sonra rafa konan kısmı aşağıda geri eklenir.
    for (const loc of db.all('SELECT product_id FROM location WHERE depo=? AND shelf=?', depo, raf)) {
      if (!sayilan.has(loc.product_id)) sayilan.set(loc.product_id, { counted: 0, system: 0 });
    }
  } else if (!okutulmayaniDokunma || !rafSatirlari.length) {
    for (const loc of db.all('SELECT product_id, qty, updated_at FROM location WHERE depo=? AND shelf=?', depo, raf)) {
      if (!sayilan.has(loc.product_id) && loc.updated_at <= olusturma) sayilan.set(loc.product_id, { counted: 0, system: 0 });
    }
  }
  for (const [pid, x] of sayilan) {
    const once = miktar(depo, pid, raf);
    // `farkEkle` (Raf Düzenle, relative): terminal raftaki miktarı kendi görüntüsüne (`system`) göre yazdı; aynı raf aynı anda başka
    // bir terminalce düzenlenmiş ya da rafa kaldırılmış olabilir. Mutlak yazılırsa o değişiklik ezilir (12'yi gören iki terminal
    // +2 ve +3 eklerse 17 yerine 15 kalırdı): terminalin eklediği fark sunucudaki güncel miktara eklenir. 0 "rafta yok" demektir, mutlak kalır.
    let hedef = farkEkle && x.counted > EPS ? Math.max(0, once + x.counted - x.system) : x.counted;
    // Canlı sayım: ürün rafta son okutulduktan (okutulmadıysa raf açıldıktan) sonra rafa konan/alınan mal sayılana eklenir; sayarken
    // yapılan rafa kaldırma ya da raftan alma sayımca silinmez. Açılışla son okutma arasındaki hareket sayılanın içindedir (bilgi).
    let k1 = null;
    if (canli) {
      const ref = canli.satirAni.get(`${raf}|${pid}`) ?? canli.acilis;
      const sonra = rafNetHareket(depo, raf, pid, ref, null, canli.opId);
      const arada = ref > canli.acilis ? rafNetHareket(depo, raf, pid, canli.acilis, ref, canli.opId) : 0;
      hedef = Math.max(0, x.counted + sonra);
      k1 = { ref, sonra, arada };
    }
    miktarAyarla(depo, pid, raf, hedef, hareket);
    // Rafta bulunan ve hiçbir adresi olmayan ürünün adresi o raf olur; rafta olmadığı bildirilen ürünün terminal adresi kalkar.
    // `adresHep` (Raf Düzenle): rafı tanımlanan ürünün adresi, başka adresi olsa da o raf olur (rafa kaldırma gibi) ve Vega kartına yazılır.
    if ((canli ? hedef : x.counted) > EPS) {
      if (adresHep || !zimmetler(depo, pid).length) terminalZimmet(depo, pid, raf);
    } else terminalZimmetBosalt(depo, pid, raf);
    if (kaydet) kaydet(pid, x, once, k1);
  }
}

/**
 * Raf düzenleme (terminalde "Raf Düzenle"): firma sıfırdan başlamıyor, rafta duran mal rafa tanımlanır. Raf stoku okutulan
 * değere çekilir (rafta olup okutulmayan ürün raftan çıkar), adresi olmayan ürünün adresi o raf olur. Sayımdan farkı: sayım
 * oturumu açılmaz, yönetici onayı beklenmez, Vega'ya hiçbir şey yazılmaz (yalnız raf stoku ve KOD10 raf adresi).
 */
function rafDuzenle(p, h, olusturma, yetkiDenetle) {
  const depo = depoCoz(p.depot);
  yetkiDenetle(null, depo);
  const { raflar, satirlar } = rafGonderimi(p);
  if (!raflar.length) throw new Ret('Düzenlenecek raf yok');
  const gecersiz = raflar.find((r) => !rafKoduGecerli(r));
  if (gecersiz) throw new Ret(`Geçersiz raf kodu: ${gecersiz}`);
  for (const raf of raflar) yetkiDenetle(null, depo, raf);
  const ref = String(p.no || 'Raf düzenleme').slice(0, 60);
  // `keepOthers` (1.12.0+ terminal): okutulmayan ürüne dokunulmaz. Alan yoksa (eski terminal) raf okutulana eşitlenir.
  const dokunma = p.keepOthers === true || p.keepOthers === 1 || p.keepOthers === 'true';
  // `relative` (2.1.3+ terminal, yalnız okutulmayana dokunma kipinde): satırdaki `system` terminalin gördüğü miktardır, fark eklenir.
  const goreli = p.relative === true || p.relative === 1 || p.relative === 'true';
  for (const raf of raflar) {
    if (!rafVarMi(depo, raf)) rafEkle(depo, raf, { source: 'TERMINAL', note: 'Raf düzenlemeden geldi' });
    rafiOkutulanaCek(depo, raf, satirlar, olusturma, { ...h, kind: 'ARRANGE', ref }, null, { okutulmayaniDokunma: dokunma, farkEkle: dokunma && goreli, adresHep: true });
  }
}

/**
 * Bir kez (2.2.2 ilk açılışı): Raf Düzenle eskiden ürünün başka adresi varsa rafı adres yapmıyordu (Toybelen'de B2B liste kopyası
 * her ürüne adres verdiği için hiç yapmıyordu) ve Vega kartının raf alanına yazılmıyordu. Düzenlenip hâlâ rafta duran ve adresi
 * olmayan ürünler adreslenir. Aynı ürün-rafta terminalden adres silinmişse (HOME_REMOVE) bilinçli karar sayılır, dokunulmaz.
 */
function rafDuzenleAdresleri() {
  if (db.meta('rafDuzenleAdres')) return 0;
  let n = 0;
  db.tx(() => {
    const silinen = new Set();
    for (const o of db.all("SELECT payload FROM op WHERE type='HOME_REMOVE' AND ok=1")) {
      try {
        const p = JSON.parse(o.payload);
        const s = rafKodu(p.shelf);
        if (p.productId && s) silinen.add(`${String(p.productId)}|${s}`);
      } catch {
        // bozuk kayıt: yok say
      }
    }
    const adaylar = db.all(
      `SELECT DISTINCT m.depo, m.product_id, m.shelf FROM movement m
       JOIN location l ON l.depo=m.depo AND l.product_id=m.product_id AND l.shelf=m.shelf AND l.qty > ?
       WHERE m.kind='ARRANGE'
         AND NOT EXISTS (SELECT 1 FROM product_home h WHERE h.depo=m.depo AND h.product_id=m.product_id AND h.shelf=m.shelf)`,
      EPS,
    );
    for (const a of adaylar) {
      if (silinen.has(`${a.product_id}|${a.shelf}`)) continue;
      terminalZimmet(a.depo, a.product_id, a.shelf);
      n++;
    }
    db.set('rafDuzenleAdres', String(now()));
  });
  if (n) {
    log.bilgi(`Raf Düzenle ile rafa konan ürünlere raf adresi verildi: ${n} adres`);
    degisti();
  }
  return n;
}

/** Terminalden gelen işlemler. Aynı kimlik ikinci kez gelirse yeniden işlenmez (bkz. docs/API.md). */
/**
 * Terminalden gelen işlemler. `sentAt`: terminalin gönderdiği andaki saati (2.2.0+); saat farkı buradan bulunur. Ağ gecikmesi
 * (en çok birkaç saniye) farka girer; çok sapmış değer (saat ayarsız terminal değil, bozuk değer) yok sayılır.
 */
function islemler(cihaz, kullanici, ops, { sentAt = null } = {}) {
  const gonderim = Number(sentAt);
  const fark = Number.isFinite(gonderim) && gonderim > 0 ? now() - gonderim : null;
  const saatFarki = fark !== null && Math.abs(fark) < 400 * 86400000 ? fark : null;
  const sonuc = [];
  let degisiklik = false;
  let transferVar = false;
  for (const op of Array.isArray(ops) ? ops : []) {
    const id = String((op && op.id) || '');
    if (!id) continue;
    const eski = db.get('SELECT ok, error, code FROM op WHERE id=?', id);
    if (eski) {
      sonuc.push({ id, ok: Boolean(eski.ok), ...(eski.ok ? {} : { error: eski.error, ...(eski.code ? { code: eski.code } : {}) }) });
      continue;
    }
    const kayit = (ok, error, code = null) =>
      db.run(
        'INSERT INTO op(id, type, payload, device, user, created_at, received_at, ok, error, code) VALUES(?,?,?,?,?,?,?,?,?,?)',
        id,
        String(op.type || ''),
        JSON.stringify(op.payload || {}),
        String(op.payload?.device || cihaz || ''),
        String(op.payload?.user || kullanici || ''),
        Number(op.createdAt) || now(),
        now(),
        ok ? 1 : 0,
        error || null,
        code,
      );
    try {
      db.tx(() => {
        islemUygula(op, cihaz, kullanici, { saatFarki });
        kayit(true, null);
      });
      sonuc.push({ id, ok: true });
      degisiklik = true;
      if (op.type === 'TRANSFER_SEND' || op.type === 'TRANSFER_RECEIVE') transferVar = true;
    } catch (e) {
      if (e instanceof Ret) {
        kayit(false, e.message, e.code);
        sonuc.push({ id, ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) });
        log.uyari(`İşlem reddedildi ${op.type} ${id}: ${e.message}`);
      } else {
        // Beklenmeyen hata kalıcı ret değildir; cevapta yer almayan işlem terminalde bekler, sonra yeniden gelir.
        log.hata(`İşlem işlenemedi ${op.type} ${id}`, e);
      }
    }
  }
  if (degisiklik) degisti();
  // Kabul edilen transfer işlemleri Vega'ya yazılmak üzere kuyrukta (transfer tablosu); yazıcı hemen çalışsın.
  if (transferVar) require('./transfer').yaziciTetikle();
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
  // Terminalden kabul edilip program tarafından yazılan 129 fişi (transfer.js): mal kabulde ikinci kez çıkmaz.
  const programKabul = require('./transfer').programKabulBelgeleri();
  // Terminalden kabul edilen transferler rafa kaldırılacak belge olarak da gelir (raf belirtmeden alınan mal burada bekler).
  const tumu = [...goruntu.belgeGorunum, ...require('./transfer').programKabulFisleri()].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tumu.map((r) => {
    const lines = r.lines.map((l) => ({ ...l, shelved: Number(shelved.get(l.id) || 0) }));
    const kalan = lines.reduce((t, l) => t + Math.max(0, l.accepted - l.shelved), 0);
    const st = kapali.get(r.id);
    const elleKapali = Boolean((st && st.closed) || programKabul.has(r.id));
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

/** Belgesiz (BEK- satırından ya da belge numarasız) rafa kaldırmalar, milattan beri: [{ depo, pid, q }]. */
function belgesizRafa() {
  const bas = new Date(`${config.kabulBaslangic(config.load())}T00:00:00`).getTime();
  return db.all(
    `SELECT m.depo AS depo, m.product_id AS pid, SUM(m.delta) AS q
       FROM movement m LEFT JOIN op o ON o.id = m.op_id
      WHERE m.kind = 'PUTAWAY' AND m.geri_at IS NULL AND m.ts >= ?
        AND ((o.payload IS NULL AND m.ref IS NULL)
          OR (o.payload IS NOT NULL AND (json_extract(o.payload, '$.lineId') IS NULL OR json_extract(o.payload, '$.lineId') LIKE 'BEK-%')))
      GROUP BY m.depo, m.product_id`,
    bas,
  );
}

/**
 * Mal kabul belge listesi (yönetici ekranı): `belgeler()` + ürün bazlı rafa kaldırmalar en eski belgeden başlayarak
 * belge satırlarına dağıtılır. Terminal artık belgesiz (BEK-) kaldırdığı için bu olmadan hiçbir belge "rafa kalktı" olmaz.
 * Toplam kalan, bekleyenUrunler ile aynıdır.
 */
function belgelerDagitimli() {
  const liste = belgeler().map((r) => ({ ...r, lines: r.lines.map((l) => ({ ...l })) }));
  const kalanRafa = new Map(belgesizRafa().map((b) => [`${depoCoz(b.depo)}|${b.pid}`, Number(b.q)]));
  // En eskiden yeniye: liste ts'ye göre yeniden eskiye sıralı geldiği için tersten gidilir.
  for (let i = liste.length - 1; i >= 0; i--) {
    const r = liste[i];
    if (r.elleKapali) continue;
    let degisti = false;
    for (const l of r.lines) {
      const k = `${r.depo}|${l.productId}`;
      const var_ = kalanRafa.get(k) || 0;
      const acik = l.accepted - l.shelved;
      if (var_ <= EPS || acik <= EPS) continue;
      const x = Math.min(var_, acik);
      l.shelved = yuvarla(l.shelved + x);
      kalanRafa.set(k, var_ - x);
      degisti = true;
    }
    if (!degisti) continue;
    const kalan = r.lines.reduce((t, l) => t + Math.max(0, l.accepted - l.shelved), 0);
    r.biten = r.lines.filter((l) => l.shelved >= l.accepted - EPS).length;
    r.kalan = yuvarla(kalan);
    r.acik = kalan > EPS;
  }
  return liste;
}

/**
 * Rafa bekleyen mal, ürün bazlı: belge eşleşmesi aranmaz (Ortaş malı belgeye göre ayırmıyor).
 * Depo + ürün başına:
 *   gelen    = milattan (Ayarlar › Mal kabul) beri Vega'da kabul edilen miktar; elle kapatılan belgeler sayılmaz
 *   rafa     = aynı ürün için rafa kaldırılan miktar: belge satırlarına yazılanlar + belgesiz rafa kaldırmalar (geri alınanlar hariç)
 *   bekleyen = max(0, gelen - rafa)
 * Önce raf sonra fatura gelse de, mal hangi belgenin adına kalkmış olursa olsun toplam doğru çıkar.
 */
function bekleyenUrunler() {
  const out = new Map();
  const anahtar = (d, pid) => `${d}|${pid}`;
  // Terminalin çalışabildiği depolar dışındaki belgeler (listede olmayan depo) rafa bekleyen sayılmaz.
  const kullanilan = new Set(depolar().map((d) => d.ind));
  for (const r of belgeler()) {
    if (r.elleKapali || (kullanilan.size && !kullanilan.has(r.depo))) continue;
    for (const l of r.lines) {
      const k = anahtar(r.depo, l.productId);
      let x = out.get(k);
      if (!x) out.set(k, (x = { depo: r.depo, productId: l.productId, gelen: 0, rafa: 0, enEski: r.ts, belgeler: new Set() }));
      x.gelen += l.accepted;
      x.rafa += l.shelved;
      x.enEski = Math.min(x.enEski, r.ts);
      x.belgeler.add(r.id);
    }
  }
  // Belgesiz rafa kaldırmalar (ve eski terminalin belge numarası olmayan kayıtları): ürün başına gelenden düşer.
  for (const b of belgesizRafa()) {
    const x = out.get(anahtar(depoCoz(b.depo), String(b.pid)));
    if (x) x.rafa += Number(b.q);
  }
  for (const x of out.values()) {
    x.gelen = yuvarla(x.gelen);
    x.rafa = yuvarla(x.rafa);
    x.bekleyen = yuvarla(Math.max(0, x.gelen - x.rafa));
  }
  return out;
}

/**
 * Yönetici ekranı: rafa bekleyen ürünler. `depoNo` ve `metin` (stok kodu, ad, barkod) süzer; ozet süzgeçten bağımsız depo bazında toplamdır.
 * Dönen: { urunler: [{ depo, depoAd, productId, urunKod, urunAd, birim, gelen, rafa, bekleyen, enEski, belgeSayisi }], ozet: { urun, adet, depolar } }.
 */
function bekleyenListe({ depoNo = null, metin = '', limit = 1000 } = {}) {
  const tum = [...bekleyenUrunler().values()].filter((x) => x.bekleyen > EPS);
  const depolar = new Map();
  for (const x of tum) {
    const d = depolar.get(x.depo) || { depo: x.depo, depoAd: depoAdi(x.depo), urun: 0, adet: 0 };
    d.urun++;
    d.adet = yuvarla(d.adet + x.bekleyen);
    depolar.set(x.depo, d);
  }
  const q = String(metin || '').trim().toLocaleLowerCase('tr');
  const liste = tum
    .filter((x) => depoNo === null || x.depo === depoNo)
    .map((x) => ({ x, p: urun(x.productId) }))
    .filter(({ x, p }) => !q || [p?.code, p?.name, x.productId, ...(goruntu?.barcodes[x.productId] || [])].some((s) => String(s || '').toLocaleLowerCase('tr').includes(q)))
    .sort((a, b) => a.x.enEski - b.x.enEski || String(a.p?.code || '').localeCompare(String(b.p?.code || '')))
    .slice(0, limit)
    .map(({ x, p }) => ({
      depo: x.depo, depoAd: depoAdi(x.depo), productId: x.productId, urunKod: p ? p.code : x.productId, urunAd: p ? p.name : '', birim: p?.unit || '',
      gelen: x.gelen, rafa: x.rafa, bekleyen: x.bekleyen, enEski: x.enEski, belgeSayisi: x.belgeler.size,
    }));
  return {
    urunler: liste,
    ozet: { urun: tum.length, adet: yuvarla(tum.reduce((t, x) => t + x.bekleyen, 0)), depolar: [...depolar.values()].sort((a, b) => a.depo - b.depo) },
  };
}

function receiptById(id) {
  if (!goruntu) return null;
  return goruntu.belgeGorunum.find((r) => r.id === id) || require('./transfer').programKabulFisleri().find((r) => r.id === id) || null;
}

/** Rafa kaldırılmayı bekleyen miktar, ürün başına (depo verilirse o depoda). Vega stoku bunu içerir. */
function bekleyenKabul(depo = null) {
  const out = new Map();
  for (const x of bekleyenUrunler().values()) {
    if (x.bekleyen <= EPS || (depo !== null && x.depo !== depo)) continue;
    out.set(x.productId, (out.get(x.productId) || 0) + x.bekleyen);
  }
  return out;
}

// ---- Ana veri (terminale) --------------------------------------------------------------------

/** Bekleyen ürünler, terminalin belge listesi biçiminde: depo başına tek belge, satır kimliği `BEK-<depo>-<ürün>` (PUTAWAY'de belgesiz sayılır). */
function bekleyenBelgeleri(bekleyenler, gonderilen) {
  const gruplar = new Map();
  for (const x of bekleyenler) {
    if (!gonderilen.has(x.productId)) continue;
    if (!gruplar.has(x.depo)) gruplar.set(x.depo, []);
    gruplar.get(x.depo).push({ id: `BEK-${x.depo}-${x.productId}`, productId: x.productId, accepted: x.bekleyen, shelved: 0 });
  }
  return [...gruplar.entries()]
    .sort((p, q) => p[0] - q[0])
    .map(([d, lines]) => ({
      id: `BEK-${d}`,
      docNo: 'Rafa bekleyen ürünler',
      supplier: '',
      date: '',
      depot: d,
      depotName: depoAdi(d),
      lines: lines.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)),
    }));
}

/** Terminale giden ana verinin tamamı (nesne). `master()` tek parça, `masterParcalari()` kovalara bölünmüş verir. */
function masterGovde() {
  if (!goruntu) {
    const e = new Error('Vega verisi henüz alınamadı. Yönetici programında Vega bağlantısını kontrol edin.');
    e.status = 503;
    throw e;
  }
  const cfg = config.load();
  // Terminale belge değil ürün bazlı bekleyen liste gider: depo başına tek "Rafa bekleyen ürünler" belgesi (satır = ürün).
  const bekleyenler = [...bekleyenUrunler().values()].filter((x) => x.bekleyen > EPS);
  // Sıra sabit olmalı: Vega ürünleri her yenilemede farklı sırayla verebiliyor; sıra değişince ETag ve kova özetleri
  // de değişip terminaller (2 dakikada bir) değişmemiş veriyi baştan indiriyordu.
  const locations = db.all('SELECT depo, product_id, shelf, qty FROM location WHERE qty > 0 ORDER BY depo, product_id, shelf');
  const ref = new Set(locations.map((l) => l.product_id));
  for (const h of db.all('SELECT DISTINCT product_id FROM product_home')) ref.add(h.product_id);
  for (const x of bekleyenler) ref.add(x.productId);

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
  // Yetki (yetki.js): perms / depots / shelves null = sınırsız. Eski terminal bu alanları yok sayar; asıl denetim sunucuda.
  const users = db
    .all('SELECT username, name, salt, pin_hash, role, perms, depots, shelves FROM app_user WHERE active=1 ORDER BY username')
    .map((u) => ({ username: u.username, name: u.name, salt: u.salt, pinHash: u.pin_hash, ...yetki.terminalGorunumu(u) }));

  const govde = {
    warehouse: depoAdi(vars),
    defaultDepot: vars,
    depots: depoListe.map((d) => ({ id: d.ind, name: d.ad })),
    products,
    shelves: db.all('SELECT depo, code, zone FROM shelf ORDER BY depo, code').map((s) => ({ depot: s.depo, code: s.code, zone: s.zone })),
    // Özel raflar (SIPARIS SATIS): terminal bunları her depoda tanımlı sayar; stok tutulmaz, öneri/uyarı/raf sınırı uygulanmaz.
    specialShelves: ozelRaflar(),
    locations: locations.map((l) => ({ depot: l.depo, productId: l.product_id, shelf: l.shelf, qty: l.qty })),
    // Ürünün zimmetli rafları (Excel, Vega kartı, yönetici): rafa kaldırmada önerilir, sayımda rafta beklenir.
    homes: db
      .all('SELECT depo, product_id, shelf FROM product_home ORDER BY depo, product_id, shelf')
      .filter((h) => gonderilen.has(h.product_id))
      .map((h) => ({ depot: h.depo, productId: h.product_id, shelf: h.shelf })),
    receipts: bekleyenBelgeleri(bekleyenler, gonderilen),
    counts,
    users,
    // Depolar arası transfer: açık gönderimler ve hedef depo listesi (kapalıyken { on: false }).
    transfer: require('./transfer').terminalGorunumu(),
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
  const kabul = belgelerDagitimli()
    .filter((r) => r.lines.some((l) => l.productId === pid))
    .slice(0, 30)
    .map((r) => {
      const l = r.lines.find((x) => x.productId === pid);
      return { id: r.id, docNo: r.docNo, tur: r.tur, date: r.date, supplier: r.supplier, depo: r.depo, depoAd: r.depoAd, accepted: l.accepted, shelved: l.shelved, acik: r.acik };
    });
  // Depo depo özet: Vega stoku, raflar, bekleyen, yerleşmemiş.
  const depoSet = new Set(konumlar.map((k) => k.depo));
  if (goruntu) for (const [d, m] of goruntu.stokDepo) if (m.get(pid)) depoSet.add(d);
  for (const r of kabul) if (r.acik) depoSet.add(r.depo);
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

/**
 * "Vega'da var, terminalde neden yok?": kartın Vega'daki (canlı okunan) depo envanteri belge belge ve her girişin
 * terminaldeki durumu. Belgeye girmeyen stok ("belgesiz") terminalde Rafa Kaldır › ürün okutarak kaldırılır.
 */
async function stokTani(ara) {
  const cfg = config.load();
  const v = await vega.stokTani(cfg, ara);
  // Sanal bekleme depoları da kullanılan depodur; yalnız terminalde ayrı depo olarak görünmez.
  const kullanilan = new Set([...depolar().map((d) => d.ind), ...(goruntu?.depolar || []).map((d) => Number(d.ind))]);
  const bek0 = bekleme.ayar();
  const secili = new Set((cfg.kabul.izahat || []).map(String));
  const bas = cfg.kabul.baslangic || '';
  const blg = new Map(belgelerDagitimli().map((r) => [r.id, r]));
  const vegaDepoAd = new Map(v.depolar.map((d) => [Number(d.ind), d.ad]));
  const ad = (d) => vegaDepoAd.get(d) || depoAdi(d);
  const kartlar = v.kartlar.map((k) => {
    const p = urun(k.id);
    const rafta = db.all('SELECT depo, SUM(qty) AS q FROM location WHERE product_id=? AND qty>0 GROUP BY depo', k.id);
    const rafQ = new Map(rafta.map((r) => [r.depo, r.q]));
    const kartNeden = k.suzgec.length ? k.suzgec.join(', ') : !p ? "Program bu kartı Vega görüntüsünde bulamadı (Vega'yı yenileyin)" : k.pasifAd && !rafQ.size ? 'Kart adında PASİF var: terminale yalnız bir rafta duruyorsa gider' : null;
    const girisler = k.girisler.map((g) => {
      const anahtar = DEPO_BELGE_TIP.has(g.tip) ? `D${g.tip}` : String(g.tip);
      const sonuc = (durum, neden) => ({ ...g, depoAd: ad(g.depo), anahtar, durum, neden });
      if (kartNeden) return sonuc('yok', kartNeden);
      if (!kullanilan.has(g.depo)) return sonuc('yok', 'Depo kullanılan depolar arasında değil (Ayarlar › Vega)');
      if (g.tip === 93) return sonuc('bilgi', 'Sayım fişi: sayılan mal zaten rafta sayılmıştır');
      if (!secili.has(anahtar)) return sonuc('yok', `Belge türü seçili değil (Ayarlar › Mal kabul: ${anahtar})`);
      if (bas && g.gun && g.gun < bas) return sonuc('yok', `Mal kabul başlangıç tarihinden (${bas}) eski`);
      if (g.iade) return sonuc('yok', 'İade satırı');
      if (g.iptal) return sonuc('yok', 'Belge iptal');
      const r = blg.get(`${anahtar}-${g.belgeInd}-${g.depo}`);
      if (!r) {
        const ham = bek0 && goruntu?.receipts.find((x) => x.id === `${anahtar}-${g.belgeInd}-${g.depo}`);
        if (ham && bekleme.grupIci(ham, bek0)) return sonuc('bilgi', 'Bekleme deposundan geçiş: mal yer değiştirmedi, fatura belgesinden rafa kalkar');
        return sonuc('yok', "Programdaki Vega görüntüsünde yok (Vega'yı yenileyin; yenilendiyse bildirin)");
      }
      if (r.elleKapali) return sonuc('tamam', 'Belge yönetici programında elle kapatıldı');
      const l = r.lines.find((x) => x.productId === k.id);
      if (!l) return sonuc('yok', 'Belgede bu kalem yok');
      if (l.shelved >= l.accepted - EPS) return sonuc('tamam', `Rafa kaldırıldı (${yuvarla(l.shelved)}/${yuvarla(l.accepted)})`);
      return sonuc('terminalde', `Terminalde açık: ${r.docNo}, ${yuvarla(l.accepted - l.shelved)} rafa kaldırılacak`);
    });
    const stokGrup = bekleme.birlestir(k.stok, bek0);
    const depoSet = new Set([...Object.keys(stokGrup).map(Number), ...rafQ.keys()]);
    const depoOzet = [...depoSet].sort((a, b) => a - b).map((d) => {
      const vs = Number(stokGrup[String(d)] || 0);
      const raf = Number(rafQ.get(d) || 0);
      const bek = kullanilan.has(d) ? bekleyenKabul(d).get(k.id) || 0 : 0;
      return { depo: d, depoAd: ad(d), kullaniliyor: kullanilan.has(d), vegaStock: yuvarla(vs), raf: yuvarla(raf), bekleyen: yuvarla(bek), belgesiz: yuvarla(vs - raf - bek) };
    });
    return { id: k.id, kod: k.kod, ad: k.ad, kartNeden, depolar: depoOzet, girisler, cikislar: k.cikislar.map((c) => ({ ...c, depoAd: ad(c.depo) })) };
  });
  return { ara: String(ara || '').trim(), baslangic: bas, kartlar };
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
    return { ...s, ozel: ozelRafMi(s.code), depoAd: depoAdi(s.depo), cesit: o ? o.n : 0, miktar: o ? yuvarla(o.q) : 0, sonHareket: o ? o.u : null, zimmet: z ? z.n : 0, bekleyen: z ? z.bos : 0 };
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

// ---- Canlı sayım: Vega farkının dondurulması ----------------------------------------------------
// Ortaş sayımı satış durmadan yapıyor. Onay anındaki Vega stoğuyla hesaplanan fark, sayım ile onay arasındaki satışı da
// içerirdi (satılan 3 adet raf kaydında kalır → +3 sayım giriş fişi). Bu yüzden ürün başına fark sayım gönderildikten sonraki
// ilk Vega okumasında hesaplanıp saklanır ve onayda o yazılır.
//
//   q = raf toplamı + rafa bekleyen − Vega stoku (o okumadaki tutarlı durum)
// Rafa kaldırma (bekleyen↔raf) ve mal kabul (Vega↔bekleyen) q'yu değiştirmez. Değiştiren: raf kaydına işlemeyen Vega hareketi
// (raftan alınmadan kesilen satış) ve Vega'ya işlemeyen raf hareketi. Ürünün son sayıldığı andan sonraki bu hareketler q'dan
// geri alınır (düzeltme): fark = q + (sonraki Vega hareketi − sonraki raf hareketi). Vega'da saat yok; an → envanter IND'i
// eşlemesi her Vega okumasında kaydedilen filigranla yapılır (vega_filigran).
// Ürün birden çok rafta farklı saatlerde sayıldıysa arada olan böyle bir hareketin hangi raftan olduğu bilinemez: "belirsiz",
// yönetici bakar (yeniden saydırır ya da bilerek yazar).

const FILIGRAN_ESKI_MS = 10 * 60 * 1000;
const NOTR_RAF = new Set(['PUTAWAY', 'PUTAWAY_GERI', 'COUNT']);

function filigranKaydet(g) {
  if (!g || !Number(g.filigran) || !Number(g.filigranAt)) return;
  db.run('INSERT OR REPLACE INTO vega_filigran(at, ind) VALUES(?,?)', Number(g.filigranAt), Number(g.filigran));
  if (Math.random() < 0.01) db.run('DELETE FROM vega_filigran WHERE at < ?', now() - 120 * 86400000);
}

/** `t` anında Vega envanterinde hangi kayda kadar vardı: o andan önceki son okumanın filigranı (çok eskiyse null). */
function filigranAni(t) {
  const r = db.get('SELECT at, ind FROM vega_filigran WHERE at <= ? ORDER BY at DESC LIMIT 1', t);
  if (!r || t - r.at > FILIGRAN_ESKI_MS) return null;
  return r;
}

/** Mal kabul olarak rafa bekleyene giren Vega belge türleri (artı satırları q'yu değiştirmez). */
function notrVegaTurleri() {
  const t = new Set();
  for (const x of config.load().kabul?.izahat || ['20', '26']) {
    const k = String(x);
    if (/^\d+$/.test(k)) t.add(Number(k));
    else if (k === 'D37') t.add(37);
  }
  return t;
}

function rafHareketToplam(depo, pid, alt, ust) {
  const r = db.get(
    `SELECT SUM(delta) AS q FROM movement WHERE depo=? AND product_id=? AND fiili_ts > ? AND fiili_ts <= ?
       AND kind NOT IN (${[...NOTR_RAF].map((k) => `'${k}'`).join(',')})`,
    depo,
    String(pid),
    alt,
    ust,
  );
  return yuvarla(r?.q || 0);
}

let dondurmaZaman = null;
/** Sayım gönderildi: Vega kısa süre sonra okunsun, fark dondurulsun (zamanlayıcıyı beklemeden). */
function sayimDondurmaIste() {
  if (dondurmaZaman) return;
  dondurmaZaman = setTimeout(() => {
    dondurmaZaman = null;
    vegaYenile('sayım').catch(() => {});
  }, 1500);
  dondurmaZaman.unref?.();
}

let donduruluyor = null;
/**
 * Bekleyen (BEKLIYOR) sayım ürünlerinin farkını dondurur. Yalnız gönderimden sonra okunmuş Vega görüntüsüyle çalışır.
 * Vega hareketleri okunamazsa satırlar beklemede kalır, sonraki okumada yeniden denenir.
 */
async function sayimDondur() {
  if (donduruluyor) return donduruluyor;
  donduruluyor = sayimDondurAsil().finally(() => {
    donduruluyor = null;
  });
  return donduruluyor;
}

async function sayimDondurAsil() {
  if (!goruntu || !Number(goruntu.filigran) || !Number(goruntu.filigranAt)) return 0;
  const ust = Number(goruntu.filigran);
  const ustAt = Number(goruntu.filigranAt);
  const satirlar = db.all("SELECT * FROM count_urun WHERE durum='BEKLIYOR' AND gonderim_at <= ?", ustAt);
  if (!satirlar.length) {
    // Okuma gönderimden önce başlamıştı: bir okuma daha.
    if (db.get("SELECT 1 FROM count_urun WHERE durum='BEKLIYOR' LIMIT 1")) sayimDondurmaIste();
    return 0;
  }
  const oturumlar = new Map();
  for (const r of satirlar) {
    if (!oturumlar.has(r.session_id)) oturumlar.set(r.session_id, []);
    oturumlar.get(r.session_id).push(r);
  }
  const notr = notrVegaTurleri();
  let n = 0;
  for (const [sid, liste] of oturumlar) {
    const s = db.get('SELECT * FROM count_session WHERE id=?', sid);
    if (!s || s.status === 'CANCELLED' || s.status === 'APPROVED') {
      db.run("UPDATE count_urun SET durum='ATLANDI' WHERE session_id=? AND durum='BEKLIYOR'", sid);
      continue;
    }
    const depo = s.depo;
    // q, Vega okumasıyla aynı anda (await öncesi) hesaplanır: raf, bekleyen ve Vega aynı durumu göstersin.
    const qAt = now();
    const bek = bekleyenKabul(depo);
    const hesap = [];
    for (const r of liste) {
      if (!urun(r.product_id) || !/^\d+$/.test(r.product_id)) {
        db.run("UPDATE count_urun SET durum='YOK', dondu_at=? WHERE session_id=? AND product_id=?", qAt, sid, r.product_id);
        continue;
      }
      const raf = Number(db.get('SELECT SUM(qty) AS q FROM location WHERE depo=? AND product_id=? AND qty>0', depo, r.product_id)?.q || 0);
      const vs = vegaStok(r.product_id, depo);
      const b = bek.get(r.product_id) || 0;
      const zamanli = Boolean(r.zamanli);
      const wSon = filigranAni(r.son_ts);
      const wIlk = zamanli ? filigranAni(r.ilk_ts) : wSon;
      hesap.push({ r, q: yuvarla(raf + b - vs), raf, vs, b, zamanli, wIlk, wSon, imza: `${r.ilk_ts}|${r.son_ts}|${r.gonderim_at}` });
    }
    const altlar = hesap.map((x) => (x.wIlk || x.wSon)?.ind).filter((x) => Number.isFinite(x));
    let vegaSatir = [];
    if (altlar.length) {
      vegaSatir = await vega.sayimHareketleri(config.load(), {
        depo: bekleme.grupDepolari(depo),
        stoknolar: [...new Set(hesap.filter((x) => x.wSon).map((x) => x.r.product_id))],
        altInd: Math.min(...altlar),
        ustInd: ust,
      });
    }
    const vegaUrun = new Map();
    for (const v of vegaSatir) {
      if (!vegaUrun.has(v.stokno)) vegaUrun.set(v.stokno, []);
      vegaUrun.get(v.stokno).push(v);
    }
    db.tx(() => {
      for (const x of hesap) {
        // Await sırasında aynı ürün yeniden gönderildiyse bu hesap eskidir; satır beklemede kalır.
        const guncel = db.get('SELECT ilk_ts, son_ts, gonderim_at, durum FROM count_urun WHERE session_id=? AND product_id=?', sid, x.r.product_id);
        if (!guncel || guncel.durum !== 'BEKLIYOR' || `${guncel.ilk_ts}|${guncel.son_ts}|${guncel.gonderim_at}` !== x.imza) continue;
        const pid = x.r.product_id;
        const tur = { arada: {}, sonra: {} };
        let vegaArada = 0;
        let vegaSonra = 0;
        for (const v of vegaUrun.get(pid) || []) {
          if (v.miktar > 0 && notr.has(v.tip)) continue;
          if (x.wSon && v.ind > x.wSon.ind) {
            vegaSonra += v.miktar;
            tur.sonra[v.tip] = yuvarla((tur.sonra[v.tip] || 0) + v.miktar);
          } else if (x.wIlk && x.wSon && v.ind > x.wIlk.ind) {
            vegaArada += v.miktar;
            tur.arada[v.tip] = yuvarla((tur.arada[v.tip] || 0) + v.miktar);
          }
        }
        const rafSonra = rafHareketToplam(depo, pid, x.r.son_ts, qAt);
        const rafArada = x.zamanli && x.r.ilk_ts < x.r.son_ts ? rafHareketToplam(depo, pid, x.r.ilk_ts, x.r.son_ts) : 0;
        // Sayım anına ait Vega kaydı yoksa (o saatte Vega okunamıyordu) düzeltme yapılamaz; yönetici bakar.
        const duzeltme = x.wSon ? yuvarla(vegaSonra - rafSonra) : 0;
        const belirsiz = !x.zamanli ? 0 : x.wIlk && x.wSon ? yuvarla(vegaArada - rafArada) : null;
        const detay = {
          raf: yuvarla(x.raf), bekleyen: yuvarla(x.b), vega: yuvarla(x.vs), qAt, filigran: ust,
          vegaSonra: yuvarla(vegaSonra), rafSonra, vegaArada: yuvarla(vegaArada), rafArada, tur,
          ...(x.wSon ? {} : { neden: 'Sayım saatine ait Vega okuması yok (Vega o sırada okunamıyordu)' }),
        };
        db.run(
          "UPDATE count_urun SET durum='TAMAM', q=?, duzeltme=?, belirsiz=?, fark=?, detay=?, dondu_at=? WHERE session_id=? AND product_id=?",
          x.q,
          duzeltme,
          belirsiz,
          yuvarla(x.q + duzeltme),
          JSON.stringify(detay),
          now(),
          sid,
          pid,
        );
        n++;
      }
    });
  }
  if (n) degisti();
  return n;
}

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
  const donuk = new Map(db.all('SELECT * FROM count_urun WHERE session_id=?', id).map((r) => [r.product_id, r]));
  const urunler = new Map();
  for (const l of satirlar) {
    if (!urunler.has(l.product_id)) urunler.set(l.product_id, { productId: l.product_id, sayilan: 0, onceki: 0, raflar: [], hareketSonra: 0, hareketArada: 0 });
    const u = urunler.get(l.product_id);
    u.sayilan += l.counted;
    // Canlı sayımda "önceki" sayıldığı andaki raf kaydıdır (sonradan rafa konan/alınan, sayılana eklendi; bkz. rafiOkutulanaCek).
    u.onceki += l.server_before - (l.hareket_sonra || 0);
    u.hareketSonra += l.hareket_sonra || 0;
    u.hareketArada += l.hareket_arada || 0;
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
    const farkSimdi = yuvarla(hedef - vs);
    // Dondurulmuş fark (canlı sayım): sayım anındaki Vega farkı. Yoksa (Vega henüz okunmadı, eski sayım) onay anındaki fark.
    const d = donuk.get(u.productId);
    const donmus = Boolean(d && d.durum === 'TAMAM' && d.fark !== null);
    let detay = null;
    try {
      detay = d && d.detay ? JSON.parse(d.detay) : null;
    } catch {}
    const belirsiz = donmus ? (d.belirsiz === null ? null : yuvarla(d.belirsiz)) : null;
    return {
      ...u,
      sayilan: yuvarla(u.sayilan),
      onceki: yuvarla(u.onceki),
      hareketSonra: yuvarla(u.hareketSonra),
      hareketArada: yuvarla(u.hareketArada),
      donmus,
      dondurma: d ? d.durum : null,
      farkSimdi,
      duzeltme: donmus ? yuvarla(d.duzeltme || 0) : null,
      belirsiz,
      zamansiz: Boolean(d && !d.zamanli),
      // Elle bakılmalı: farklı saatlerde sayılan raflar arasında raf kaydına işlemeyen Vega hareketi var (hangi raftan bilinmiyor)
      // ya da sayım anına ait Vega kaydı yok.
      kontrol: donmus && (belirsiz === null || Math.abs(belirsiz) > EPS),
      donmaDetay: detay,
      code: p ? p.code : '?',
      name: p ? p.name : "Vega'da bulunamayan kart",
      unit: p ? p.unit : '',
      vegadaVar: Boolean(p),
      digerRaflar: yuvarla(rafToplam - (u.sayilmadi ? 0 : satirlarRafToplam(depo, id, u.productId))),
      bekleyen: yuvarla(b),
      hedef,
      vegaStock: vs,
      fark: donmus ? yuvarla(d.fark) : farkSimdi,
    };
  });
  liste.sort((a, b) => Math.abs(b.fark) - Math.abs(a.fark) || a.name.localeCompare(b.name, 'tr'));
  // `catisma`: sayım gönderilirken sunucudaki raf miktarı terminalin gördüğünden farklıydı (terminal henüz eşitlenmemişken başka bir
  // terminal rafa kaldırdı/aldı/düzenledi). Sayım mutlak yazar; o hareket ezilmiş olabilir, yönetici bakıp onaylasın.
  // Canlı sayımda (ref_ts dolu) sayarken rafa yapılan hareket sayılana eklendi: fark sayıldığı andaki raf kaydına göredir, çatışma yoktur.
  const satirDetay = satirlar.map((l) => {
    const canli = l.ref_ts !== null && l.ref_ts !== undefined;
    const sistem = yuvarla(l.server_before - (l.hareket_sonra || 0));
    return {
      ...l,
      ...urunAdi(l.product_id),
      canli,
      sistemAnda: sistem,
      fark: yuvarla(l.counted - sistem),
      catisma: canli ? 0 : yuvarla(l.server_before - l.terminal_system),
    };
  });
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
      kontrol: liste.filter((u) => u.kontrol).length,
      donmayi: liste.filter((u) => u.dondurma === 'BEKLIYOR').length,
      canli: satirlar.some((l) => l.ref_ts !== null && l.ref_ts !== undefined),
    },
  };
}

/** Depoda kapsama uyan tanımlı raflar (terminal de yalnız tanımlı rafı kabul eder). */
function kapsamRaflari(depo, onekler) {
  return db
    .all('SELECT code FROM shelf WHERE depo=?', depo)
    .map((r) => r.code)
    .filter((c) => !ozelRafMi(c) && kapsam.kapsamda(c, onekler))
    .sort((a, b) => a.localeCompare(b, 'tr', { numeric: true }));
}

/**
 * Ürün sayımı: stok kodlarından (satır, virgül ya da noktalı virgülle ayrılmış; barkod da olur) ürünleri bulur ve o ürünlerin
 * depodaki raflarını çıkarır. Sayım yine raf sayımıdır; kapsam bu raflar olur (raftaki başka ürünler de sayılır).
 * Dönen: { bulunan: [{ kod, ad, raflar }], bulunamayan: [girdi], rafsiz: [kod] (bulundu ama bu depoda rafı yok), raflar }.
 */
function urunRaflari(depoNo, metin) {
  const girdi = [...new Set(String(Array.isArray(metin) ? metin.join('\n') : metin || '').split(/[,;\n\r\t]+/).map((x) => x.trim()).filter(Boolean))];
  const bulunan = [];
  const bulunamayan = [];
  const rafsiz = [];
  const tum = new Set();
  if (!goruntu) return { bulunan, bulunamayan: girdi, rafsiz, raflar: [] };
  const kodlu = new Map(goruntu.products.map((p) => [String(p.code).toLocaleUpperCase('tr-TR'), p]));
  const barkodlu = new Map();
  for (const [pid, liste] of Object.entries(goruntu.barcodes || {})) for (const b of liste) barkodlu.set(String(b), pid);
  const kimlik = new Map(goruntu.products.map((p) => [String(p.id), p]));
  for (const g of girdi) {
    const p = kodlu.get(g.toLocaleUpperCase('tr-TR')) || kimlik.get(barkodlu.get(g));
    if (!p) { bulunamayan.push(g); continue; }
    if (bulunan.some((b) => b.id === String(p.id))) continue;
    const raflar = db.all('SELECT shelf FROM location WHERE depo=? AND product_id=? AND qty>0 ORDER BY shelf', depoNo, String(p.id)).map((r) => r.shelf);
    if (!raflar.length) { rafsiz.push(p.code); continue; }
    raflar.forEach((r) => tum.add(r));
    bulunan.push({ id: String(p.id), kod: p.code, ad: p.name, raflar });
  }
  return { bulunan, bulunamayan, rafsiz, raflar: [...tum].sort((a, b) => a.localeCompare(b, 'tr', { numeric: true })) };
}

/**
 * Raf sayımında kapsam seçimi için depodaki raflar, Ortaş'ın adlandırmasına göre: ilk parça bölge (KAT, KO, KUTU,
 * DEPO, TK2…), ilk iki parça grup (KAT-1, KAT-B, KO-4). Üçten az rafı olan grup (yazım hatası, tek tük adres) listelenmez;
 * bölgenin tamamı seçilince onlar da sayılır.
 */
function rafGruplari(depo) {
  const bolgeler = new Map();
  for (const { code } of db.all('SELECT code FROM shelf WHERE depo=?', depo)) {
    if (ozelRafMi(code)) continue;
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

async function sayimOnayla(id, secenekler = {}) {
  // Vega'ya yazarken (await) aynı sayım ikinci kez onaylanmasın: ikinci cevap boş gelir ve ilk fişin numaralarını ezerdi.
  return tekSeferde(`sayim:${id}`, () => sayimOnaylaAsil(id, secenekler), 'Bu sayım şu an onaylanıyor; bitince durumuna bakın');
}

async function sayimOnaylaAsil(id, { vegaYaz = false, stoknolar = null, dahilSayilmayan = false, kullanici = 'yönetici' } = {}) {
  // Vega'ya yazmadan önce bekleyen dondurma varsa (son okuma gönderimden sonra) tamamlansın; olmazsa onay anındaki farkla yazılır.
  if (vegaYaz) await sayimDondur().catch((e) => log.uyari(`Sayım farkı dondurulamadı: ${e.message}`));
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
      // Dondurulmuş fark doğrudan yazılır (sayımdan sonraki satış fişe karışmaz); dondurulmamışsa olması gereken stok (hedef).
      .map((u) => (u.donmus ? { stokno: Number(u.productId), fark: u.fark } : { stokno: Number(u.productId), hedef: u.hedef }));
    if (kalemler.length) {
      // Sanal bekleme deposu varsa hedef grup toplamıyla karşılaştırılır (raftaki mal 109'da da olabilir); fiş yine sayımın deposuna.
      sonuc = await vega.sayimYaz(config.load(), kalemler, { aciklama: `Sayım ${s.no}`, depo: s.depo, stokDepolari: bekleme.grupDepolari(s.depo) });
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
  return tekSeferde(`sayim:${id}`, () => sayimGeriAlAsil(id), 'Bu sayım şu an işleniyor; bitince durumuna bakın');
}

async function sayimGeriAlAsil(id) {
  const s = db.get('SELECT * FROM count_session WHERE id=?', id);
  if (!s) throw new Error('Sayım bulunamadı');
  // Yalnız onaylanmış sayım geri alınır: iptal edilmiş ya da açık sayım "onay bekliyor"a döndürülmesin.
  if (s.status !== 'APPROVED') throw new Error('Sayım onaylanmış durumda değil; geri alınacak onay yok');
  const docs = s.vega_docs ? JSON.parse(s.vega_docs).docs : [];
  if (docs.length) await vega.sayimGeriAl(config.load(), docs);
  db.run("UPDATE count_session SET status='CLOSED', vega_docs=NULL, vega_written_at=NULL, note=TRIM(note || ' · onay geri alındı') WHERE id=?", id);
  log.bilgi(`Sayım ${s.no} onayı geri alındı (${docs.map((d) => d.belgeNo).join(', ') || 'Vega fişi yoktu'})`);
  degisti();
  vegaYenile('sayım geri alındı').catch(() => {});
}

module.exports = {
  sayimMesgul: (id) => mesgul(`sayim:${id}`),
  _goruntuKur: goruntuKur,
  yenidenKur,
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
  ozelRaflar,
  ozelRafMi,
  ozelRafTemizle,
  zimmetler,
  zimmetEkle,
  zimmetSil,
  adresSil,
  silinenAdresKopyalari,
  rafDuzenleAdresleri,
  adresleriAyir,
  vegaZimmetEsitle,
  vegaRafYaz,
  rafYazTetikle,
  tasi,
  rafBosalt,
  rafVarMi,
  miktar,
  miktarAyarla,
  miktarEkle,
  terminalZimmet,
  terminalZimmetBosalt,
  islemler,
  belgeler,
  belgelerDagitimli,
  bekleyenUrunler,
  bekleyenListe,
  bekleyenKabul,
  master,
  urunListesi,
  urunDetay,
  stokTani,
  raflar,
  rafDetay,
  urunAdi,
  sayimNo,
  kapsamRaflari,
  urunRaflari,
  rafGruplari,
  sayimOzet,
  sayimDondur,
  sayimOnayla,
  sayimGeriAl,
  rafaKaldirmaGeriAl,
  Ret,
};
