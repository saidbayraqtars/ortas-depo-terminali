// Ortaş Depo — sunucu. Tek port (varsayılan 5480), yerel ağa açık:
//   /api/*           terminal sözleşmesi (docs/API.md), X-Device-Key ile
//   /yonetim/api/*   yönetici ekranı; bu bilgisayardan ya da yönetici parolasıyla ağdan
//   /apk, /kur       terminale uygulama indirme
//   /                yönetici arayüzü (client/dist)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const QRCode = require('qrcode');

const config = require('./config');
const db = require('./db');
const log = require('./log');
const vega = require('./vega');
const depo = require('./depo');
const apk = require('./apk');
const etiket = require('./etiket');
const iceaktar = require('./iceaktar');
const rapor = require('./rapor');
const kapsam = require('./kapsam');
const transfer = require('./transfer');
const kilit = require('./kilit');
const yetki = require('./yetki');
const bekleme = require('./bekleme');

const SURUM = require('../package.json').version;
let yedekYedekKlasor = null; // ayardaki klasör kullanılamazsa
let masaustu = {};
let sunucu = null;

// ---- Yardımcılar -----------------------------------------------------------------------------

function yerelMi(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function adresler() {
  const out = [];
  for (const [ad, liste] of Object.entries(os.networkInterfaces())) {
    for (const x of liste || []) {
      if (x.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.')) out.push({ ad, ip: x.address });
    }
  }
  return out;
}

function csv(res, ad, basliklar, satirlar) {
  const hucre = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    const s = String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const metin = '﻿' + [basliklar, ...satirlar].map((r) => r.map(hucre).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(ad)}`);
  res.send(metin);
}

const tarihSaat = (ts) => (ts ? new Date(ts).toLocaleString('tr-TR') : '');

function hata(res, status, mesaj) {
  res.status(status).json({ error: mesaj });
}

const sar = (fn) => async (req, res) => {
  try {
    const r = await fn(req, res);
    if (r !== undefined && !res.headersSent) res.json(r);
  } catch (e) {
    const status = e.status || (e instanceof depo.Ret ? 400 : 500);
    if (status >= 500) log.hata(`${req.method} ${req.originalUrl}`, e);
    if (!res.headersSent) hata(res, status, e.message || 'Hata');
  }
};

function pinOzeti(salt, pin) {
  return crypto.createHash('sha256').update(salt + pin, 'utf8').digest('hex');
}

// ---- Yedek -----------------------------------------------------------------------------------

/**
 * Yedek klasörü: ayardaki (varsayılan C:/ortaşdepo-yedekler). Klasör açılamıyor ya da yazılamıyorsa veri klasörüne düşülür:
 * izin sorunu yüzünden yedek hiç alınmamaktansa programın yanında alınsın; günlüğe yazılır.
 */
function yedekKlasoru() {
  const k = String(config.load().yedek?.klasor || '').trim();
  try {
    if (!k) throw new Error('Yedek klasörü ayarlanmadı');
    fs.mkdirSync(k, { recursive: true });
    fs.accessSync(k, fs.constants.W_OK);
    return k;
  } catch (e) {
    log.uyari(`Yedek klasörü kullanılamıyor (${k}): ${e.message}; ${yedekYedekKlasor} kullanılıyor`);
    fs.mkdirSync(yedekYedekKlasor, { recursive: true });
    return yedekYedekKlasor;
  }
}

function yedekAl(etiket = 'otomatik') {
  const an = new Date();
  const ad = `depo-${an.getFullYear()}${String(an.getMonth() + 1).padStart(2, '0')}${String(an.getDate()).padStart(2, '0')}-${String(an.getHours()).padStart(2, '0')}${String(an.getMinutes()).padStart(2, '0')}-${etiket}.db`;
  const klasor = yedekKlasoru();
  const hedef = path.join(klasor, ad);
  db.backup(hedef);
  // Yeni yedek alındıktan sonra en eskiler silinir; yalnız programın kendi yedekleri, klasördeki başka dosyaya dokunulmaz.
  const sinir = Math.max(1, Number(config.load().yedek?.adet) || 5);
  for (const f of yedekListe(klasor).slice(sinir)) fs.unlinkSync(path.join(klasor, f.ad));
  db.set('sonYedek', Date.now());
  log.bilgi(`Yedek alındı: ${ad}`);
  return ad;
}

/** Programın yedekleri, en yeni önce. Aynı dakikada alınanlar da sırasını şaşırmasın diye dosya zamanına göre. */
function yedekListe(klasor) {
  if (!fs.existsSync(klasor)) return [];
  return fs
    .readdirSync(klasor)
    .filter((f) => /^depo-\d{8}-\d{4}-.+\.db$/.test(f))
    .map((f) => {
      const d = fs.statSync(path.join(klasor, f));
      return { ad: f, boyut: d.size, zaman: d.mtimeMs };
    })
    .sort((a, b) => b.zaman - a.zaman || (a.ad < b.ad ? 1 : -1));
}

function yedekZamanla() {
  const kontrol = () => {
    const son = Number(db.meta('sonYedek', 0));
    if (Date.now() - son > 20 * 3600 * 1000) {
      try {
        yedekAl();
      } catch (e) {
        log.hata('Otomatik yedek alınamadı', e);
      }
    }
  };
  setTimeout(kontrol, 60 * 1000).unref?.();
  setInterval(kontrol, 3600 * 1000).unref?.();
}

// ---- Etiket -------------------------------------------------------------------------------------

/** Etikete girecek raflar ya da ürünler. */
/**
 * Etikete girecek raflar ya da ürünler. Raf: `kodlar` "depo|kod" ya da yalnız kod (o zaman `depo`).
 * Ürün etiketindeki raf, verilen depoda (yoksa herhangi bir depoda) en çok bulunduğu raf.
 */
function etiketOgeleri(tur, { kodlar = [], urunler = [], depo: d }) {
  const varsDepo = depo.depoCoz(d);
  if (tur === 'raf') {
    return kodlar
      .map((k) => {
        const [a, b] = String(k).includes('|') ? String(k).split('|') : [varsDepo, k];
        return { depo: depo.depoCoz(a), code: depo.rafKodu(b) };
      })
      .filter((x) => x.code)
      .map((x) => {
        const s = db.get('SELECT code, zone FROM shelf WHERE depo=? AND code=?', x.depo, x.code) || { code: x.code, zone: '' };
        return { ...s, depoAd: depo.depolar().length > 1 ? depo.depoAdi(x.depo) : '' };
      });
  }
  const g = depo.goruntu();
  const rafGoster = config.load().etiket?.rafGoster !== false;
  return urunler.map(String).map((id) => {
    const u = depo.urun(id);
    if (!u) throw Object.assign(new Error(`Ürün bulunamadı (${id})`), { status: 404 });
    const raf = rafGoster
      ? (d !== undefined && d !== null && d !== ''
          ? db.get('SELECT shelf FROM location WHERE depo=? AND product_id=? AND qty>0 ORDER BY qty DESC LIMIT 1', varsDepo, id)
          : db.get('SELECT shelf FROM location WHERE product_id=? AND qty>0 ORDER BY qty DESC LIMIT 1', id))?.shelf
      : null;
    return { ...u, barcodes: (g && g.barcodes[id]) || [], raf };
  });
}

function etiketHazirla(b, port) {
  const tur = b.tur === 'urun' ? 'urun' : 'raf';
  const ayar = config.load().etiket || {};
  const ogeler = etiketOgeleri(tur, b);
  if (!ogeler.length) throw Object.assign(new Error('Etiket için raf ya da ürün seçin'), { status: 400 });
  const bicim = b.bicim || (tur === 'urun' ? ayar.urunBicim : ayar.rafBicim);
  return { tur, ...etiket.sayfa({ tur, ogeler, bicim, adet: b.adet, fontUrl: `http://127.0.0.1:${port}` }) };
}

async function etiketBas(b, port, kim) {
  if (!masaustu.yazdir) throw Object.assign(new Error('Bu sunucuda yazıcıya erişim yok (program masaüstünde çalışmıyor)'), { status: 503 });
  const h = etiketHazirla(b, port);
  if (h.etiket > 500) throw Object.assign(new Error('Bir seferde en çok 500 etiket'), { status: 400 });
  const yazici = b.yazici ?? config.load().etiket?.yazici ?? '';
  await masaustu.yazdir(h.html, h.sayfa, { yazici });
  log.bilgi(`Etiket basıldı: ${h.etiket} ${h.tur === 'urun' ? 'ürün' : 'raf'} etiketi · ${yazici || 'varsayılan yazıcı'} · ${kim}`);
  return { etiket: h.etiket, yazici: yazici || 'varsayılan yazıcı' };
}

// ---- Terminal API ----------------------------------------------------------------------------

function cihazDogrula(req, res, next) {
  const key = String(req.get('X-Device-Key') || '').trim();
  const c = key ? db.get('SELECT * FROM device WHERE key=?', key) : null;
  if (!c || !c.active) {
    log.uyari(`Yetkisiz cihaz denemesi ${req.socket.remoteAddress} (${req.get('X-Device-Name') || '?'})`);
    return hata(res, 401, 'Cihaz yetkili değil');
  }
  req.cihaz = c;
  db.run(
    'UPDATE device SET last_seen=?, last_ip=?, last_name=?, app_version=COALESCE(?, app_version) WHERE id=?',
    Date.now(),
    // Köprü arkasındaki terminalin gerçek adresi X-Forwarded-For'un ilk değeridir (yalnız görüntü için).
    (req.get('X-Kopru') && String(req.get('X-Forwarded-For') || '').split(',')[0].trim()) || String(req.socket.remoteAddress || '').replace('::ffff:', ''),
    String(req.get('X-Device-Name') || c.name).slice(0, 60),
    req.get('X-App-Version') || null,
    c.id,
  );
  next();
}

// Toybelen köprüsü (kopru.js) kendini X-Kopru başlığıyla tanıtır: ping ve iletilen her istekte gelir. Özet'te "bağlı / son görülme"
// ve cihaz QR'ında adres seçimi için son görülme bellekte (ve açılışta gösterilsin diye veritabanında) tutulur.
const kopruler = new Map(); // ad → { ad, ip, adresler, surum, son }

function kopruGor(req) {
  const ad = String(req.get('X-Kopru') || '').trim().slice(0, 40);
  if (!ad) return;
  const adresler = String(req.get('X-Kopru-Adresler') || '').split(',').map((x) => x.trim()).filter((x) => /^https?:\/\/[\w.\-:]+$/.test(x)).slice(0, 8);
  const eski = kopruler.get(ad) || {};
  const k = {
    ad,
    ip: String(req.socket.remoteAddress || '').replace('::ffff:', ''),
    adresler: adresler.length ? adresler : eski.adresler || [],
    surum: req.get('X-Kopru-Surum') || eski.surum || '',
    son: Date.now(),
  };
  kopruler.set(ad, k);
  // Veritabanına en çok dakikada bir (her istekte yazılmasın).
  if (!eski.kayit || k.son - eski.kayit > 60000) {
    k.kayit = k.son;
    try { db.set(`kopru:${ad}`, JSON.stringify({ ip: k.ip, adresler: k.adresler, surum: k.surum, son: k.son })); } catch { /* kapanırken */ }
  }
}

function kopruListesi() {
  const kayitli = new Map(kopruler);
  try {
    for (const m of db.all("SELECT key, value FROM meta WHERE key LIKE 'kopru:%'")) {
      const ad = m.key.slice(6);
      if (!kayitli.has(ad)) kayitli.set(ad, { ad, ...JSON.parse(m.value) });
    }
  } catch { /* bozuk kayıt */ }
  return [...kayitli.values()].map((k) => ({ ad: k.ad, ip: k.ip, adresler: k.adresler || [], surum: k.surum || '', son: k.son, bagli: Date.now() - k.son < 45000 })).sort((a, b) => b.son - a.son);
}

function terminalApi() {
  const r = express.Router();
  r.use((req, res, next) => {
    kopruGor(req);
    next();
  });
  // Kimlik gerektirmeyen sağlık denetimi: köprünün "Merkez'e ulaşılıyor mu, gecikme kaç ms" sınaması.
  r.get('/ping', (req, res) => res.json({ ok: true, surum: SURUM, zaman: Date.now() }));
  r.use(cihazDogrula);
  r.get(
    '/master',
    sar((req, res) => {
      const m = depo.master();
      res.setHeader('ETag', m.etag);
      res.setHeader('Cache-Control', 'no-cache');
      if (req.get('If-None-Match') === m.etag) return void res.status(304).end();
      res.type('application/json').send(m.json);
    }),
  );
  // 1.3.0+ terminal: { known: { anahtar: özet }, max } → yalnız değişen parçalar (depo.js "Ana veri, parça parça").
  r.post(
    '/master/parts',
    sar((req, res) => {
      const b = req.body || {};
      const en = Math.max(1, Math.min(64, Number(b.max) || 8));
      res.setHeader('Cache-Control', 'no-cache');
      res.type('application/json').send(depo.masterParcaCevabi(b.known && typeof b.known === 'object' ? b.known : {}, en, Number(b.v) || 1));
    }),
  );
  // 1.5.0+ terminal: ana veri ya da bir işlem sunucuda değişene kadar (en çok `wait` sn) bekler, sonra yeni sayacı verir.
  // Terminal dakikada bir yoklamak yerine bunu dinler; yönetici ya da başka terminal bir şey değiştirince saniyeler içinde haberi olur.
  r.get('/changes', (req, res) => {
    const since = Number(req.query.since);
    const bekle = Math.max(1, Math.min(30, Number(req.query.wait) || 25));
    res.setHeader('Cache-Control', 'no-store');
    if (depo.surum() !== since) return void res.json({ surum: depo.surum() });
    let bitti = false;
    let birak = () => {};
    const bitir = () => {
      if (bitti) return;
      bitti = true;
      clearTimeout(zaman);
      birak();
      if (!res.headersSent) res.json({ surum: depo.surum() });
    };
    const zaman = setTimeout(bitir, bekle * 1000);
    birak = depo.dinle(bitir);
    req.on('close', () => {
      bitti = true;
      clearTimeout(zaman);
      birak();
    });
  });
  // 1.8.0+ terminal: belge kilidi (kilit.js). Arayüz koruması; işlemleri reddetmez.
  const kilitKimlik = (req) => ({ user: String(req.body?.user || ''), device: String(req.body?.device || req.cihaz.name) });
  r.post('/lock', sar((req) => kilit.al({ ...kilitKimlik(req), belgeId: req.body?.docId, tur: req.body?.kind, belgeNo: req.body?.docNo })));
  r.post('/lock/ping', sar((req) => kilit.nabiz({ belgeId: req.body?.docId, token: req.body?.token })));
  r.post('/lock/release', sar((req) => kilit.birak({ belgeId: req.body?.docId, token: req.body?.token })));
  r.get('/locks', sar(() => ({ locks: kilit.liste() })));
  // Terminalin çökme/donma raporu (Diag.kt): günlüğe yazılır, destek sunucusuna iletilir.
  r.post(
    '/rapor',
    sar((req) => {
      rapor.terminalden(req.body, req.cihaz);
      return { ok: true };
    }),
  );
  r.post(
    '/ops',
    sar((req) => {
      const b = req.body || {};
      if (b.user) db.run('UPDATE device SET last_user=? WHERE id=?', String(b.user), req.cihaz.id);
      return { results: depo.islemler(String(b.device || req.cihaz.name), String(b.user || ''), b.ops) };
    }),
  );
  // Terminalden etiket: { type: "PRODUCT"|"SHELF", productId | shelf, copies } → sunucu bilgisayarındaki etiket yazıcısı.
  r.post(
    '/label',
    sar(async (req) => {
      const b = req.body || {};
      // Etiket de kullanıcı yetkisine tabidir (kayıtlı olmayan kullanıcı sınırsız, bkz. yetki.js).
      const ad = String(b.user || '').trim().toLowerCase();
      const yk = ad ? yetki.baglam(db.get('SELECT username, perms, depots, shelves FROM app_user WHERE username=?', ad), depo.depoAdi) : null;
      // Raf etiketi raf sınırı olan kullanıcının görmediği raf için basılamaz.
      const red = yk && yk.denetle('label', b.depot === undefined || b.depot === null || b.depot === '' ? null : depo.depoCoz(b.depot), b.type === 'SHELF' ? depo.rafKodu(b.shelf) : null);
      if (red) throw Object.assign(new Error(red), { status: 403, kod: 'YETKI' });
      const adet = Math.max(1, Math.min(100, Number(b.copies) || 1));
      const govde = b.type === 'SHELF' ? { tur: 'raf', kodlar: [b.shelf], depo: b.depot, adet } : { tur: 'urun', urunler: [b.productId], depo: b.depot, adet };
      return await etiketBas(govde, sunucu.address().port, `${req.cihaz.name} · ${b.user || ''}`);
    }),
  );
  return r;
}

// ---- Yönetici API ----------------------------------------------------------------------------

const oturumlar = new Map(); // belirteç → son kullanma

function yoneticiDogrula(req, res, next) {
  if (req.path === '/oturum') return next();
  const cfg = config.load();
  if (!cfg.yoneticiParola) {
    if (yerelMi(req)) return next();
    return hata(res, 403, 'Ağdan yönetim için önce bu bilgisayarda yönetici parolası belirleyin');
  }
  const t = String(req.get('X-Yonetici') || '');
  const son = oturumlar.get(t);
  if (!son || son < Date.now()) return hata(res, 401, 'Oturum gerekli');
  oturumlar.set(t, Date.now() + 12 * 3600 * 1000);
  next();
}

function yoneticiApi() {
  const r = express.Router();
  r.use(yoneticiDogrula);

  r.get('/oturum', (req, res) => {
    const cfg = config.load();
    const t = String(req.get('X-Yonetici') || '');
    const gerekli = Boolean(cfg.yoneticiParola) || !yerelMi(req);
    res.json({ gerekli, girildi: !gerekli || (oturumlar.get(t) || 0) > Date.now(), parolaVar: Boolean(cfg.yoneticiParola) });
  });
  r.post('/oturum', (req, res) => {
    const cfg = config.load();
    if (!cfg.yoneticiParola) return hata(res, 400, 'Yönetici parolası belirlenmemiş');
    if (!config.parolaDogru(String(req.body?.parola || ''))) {
      log.uyari(`Hatalı yönetici parolası (${req.socket.remoteAddress})`);
      return hata(res, 401, 'Parola yanlış');
    }
    const t = crypto.randomBytes(24).toString('hex');
    oturumlar.set(t, Date.now() + 12 * 3600 * 1000);
    res.json({ belirtec: t });
  });
  r.delete('/oturum', (req, res) => {
    oturumlar.delete(String(req.get('X-Yonetici') || ''));
    res.json({ ok: true });
  });

  // Özet
  r.get(
    '/durum',
    sar(() => {
      const cfg = config.load();
      const g = depo.goruntu();
      const bugun = new Date();
      bugun.setHours(0, 0, 0, 0);
      const bel = depo.belgeler();
      const cihazlar = db.all('SELECT id, name, active, last_seen, last_ip, last_name, last_user, app_version FROM device ORDER BY name');
      const islem = db.all(
        'SELECT type, COUNT(*) AS n, SUM(ok) AS ok FROM op WHERE received_at >= ? GROUP BY type',
        bugun.getTime(),
      );
      const ap = apk.bilgi();
      return {
        surum: SURUM,
        degisiklik: depo.surum(),
        port: cfg.port,
        adresler: adresler(),
        vega: {
          ...depo.vegaDurum,
          hazir: vega.hazirMi(cfg.vega),
          firma: g?.firma,
          donem: g?.donem,
          depoAd: depo.depoAdi(depo.varsayilanDepo()),
          urun: g?.products.length || 0,
        },
        depolar: depo.depolar(),
        varsayilanDepo: depo.varsayilanDepo(),
        sayilar: {
          raf: db.get('SELECT COUNT(*) AS n FROM shelf').n,
          doluRaf: db.get('SELECT COUNT(*) AS n FROM (SELECT DISTINCT depo, shelf FROM location WHERE qty>0)').n,
          rafUrun: db.get('SELECT COUNT(DISTINCT product_id) AS n FROM location WHERE qty>0').n,
          acikBelge: bel.filter((b) => b.acik).length,
          bekleyenKalem: bel.filter((b) => b.acik).reduce((t, b) => t + (b.kalemSayisi - b.biten), 0),
          acikSayim: db.get("SELECT COUNT(*) AS n FROM count_session WHERE status='OPEN'").n,
          onayBekleyen: db.get("SELECT COUNT(*) AS n FROM count_session WHERE status='CLOSED'").n,
          kullanici: db.get('SELECT COUNT(*) AS n FROM app_user WHERE active=1').n,
          hataliIslem: db.get('SELECT COUNT(*) AS n FROM op WHERE ok=0 AND received_at >= ?', bugun.getTime()).n,
          transferDikkat: db.get("SELECT (SELECT COUNT(*) FROM transfer_fark WHERE durum='ACIK') + (SELECT COUNT(*) FROM transfer WHERE durum='HATA') AS n").n,
        },
        bugun: islem,
        cihazlar,
        sonHareketler: db
          .all('SELECT * FROM movement ORDER BY ts DESC, id DESC LIMIT 12')
          .map((h) => ({ ...h, depoAd: depo.depoAdi(h.depo), ...depo.urunAdi(h.product_id) })),
        apk: ap ? { versionName: ap.versionName, versionCode: ap.versionCode, boyut: ap.boyut } : null,
        sonYedek: Number(db.meta('sonYedek', 0)) || null,
        masaustu: Boolean(masaustu.klasorAc),
        kopruler: kopruListesi(),
      };
    }),
  );

  // Ayarlar
  r.get('/ayarlar', (req, res) => res.json({ ...config.publicView(), dosyalar: { veri: db.file(), yedek: yedekKlasoru(), gunluk: log.klasor() } }));
  r.put(
    '/ayarlar',
    sar(async (req) => {
      const b = req.body || {};
      const cfg = config.load();
      const yeni = JSON.parse(JSON.stringify(cfg));
      if (b.vega) {
        for (const k of ['server', 'port', 'database', 'user', 'firma', 'donem', 'depo']) if (k in b.vega) yeni.vega[k] = b.vega[k];
        if (Array.isArray(b.vega.depolar)) yeni.vega.depolar = b.vega.depolar.map(Number).filter(Number.isInteger);
        if (typeof b.vega.password === 'string' && b.vega.password) yeni.vega.password = b.vega.password;
      }
      if (b.kabul) {
        // Sayı: stok hareketi IZAHAT'ı; D + sayı: depo hareket fişi türü (D37 transfer, D129 gönderim kabulü).
        if (Array.isArray(b.kabul.izahat)) yeni.kabul.izahat = b.kabul.izahat.map(String).filter((x) => /^D?\d+$/.test(x));
        if (b.kabul.baslangic && /^\d{4}-\d{2}-\d{2}$/.test(b.kabul.baslangic)) yeni.kabul.baslangic = b.kabul.baslangic;
      }
      if (b.rafAdresi) {
        if ('alan' in b.rafAdresi) {
          const a = String(b.rafAdresi.alan || '').trim().toUpperCase();
          if (a && !/^[A-Z][A-Z0-9_]{0,30}$/.test(a)) throw Object.assign(new Error('Geçersiz alan adı'), { status: 400 });
          yeni.rafAdresi.alan = a;
        }
        if ('yeniRafAc' in b.rafAdresi) yeni.rafAdresi.yeniRafAc = Boolean(b.rafAdresi.yeniRafAc);
        if ('yaz' in b.rafAdresi) yeni.rafAdresi.yaz = Boolean(b.rafAdresi.yaz);
        if ('tumDepolar' in b.rafAdresi) yeni.rafAdresi.tumDepolar = Boolean(b.rafAdresi.tumDepolar);
        if ('depo' in b.rafAdresi) yeni.rafAdresi.depo = b.rafAdresi.depo === '' || b.rafAdresi.depo === null ? null : Number(b.rafAdresi.depo);
        if (yeni.rafAdresi.yaz && !yeni.rafAdresi.alan) throw Object.assign(new Error('"Program bu alana yazsın" için stok kartı alanı gerekli (Ortaş: KOD10)'), { status: 400 });
      }
      if (b.transfer) {
        const t = yeni.transfer || (yeni.transfer = {});
        if ('aktif' in b.transfer) t.aktif = Boolean(b.transfer.aktif);
        // 0 da "ayarlanmadı" demektir (eski arayüz boş alanı null yerine 0 gönderiyordu).
        const sayiyaCevir = (x) => (x === '' || x === null || x === undefined || Number(x) === 0 ? null : Number(x));
        if ('yoldaDepo' in b.transfer) {
          const n = sayiyaCevir(b.transfer.yoldaDepo);
          if (n !== null && !(Number.isInteger(n) && n > 0)) throw Object.assign(new Error('Yoldaki depo geçersiz'), { status: 400 });
          t.yoldaDepo = n;
        }
        if ('userno' in b.transfer) {
          const n = sayiyaCevir(b.transfer.userno);
          if (n !== null && !(Number.isInteger(n) && n > 0)) throw Object.assign(new Error('Vega kullanıcı numarası geçersiz'), { status: 400 });
          t.userno = n;
        }
        if ('onek' in b.transfer) {
          const o = String(b.transfer.onek || '').trim().toUpperCase();
          if (!/^[A-Z]{1,3}$/.test(o)) throw Object.assign(new Error('Belge numarası öneki 1-3 harf olmalı'), { status: 400 });
          t.onek = o;
        }
        if ('gun' in b.transfer) t.gun = Math.max(1, Math.min(365, Number(b.transfer.gun) || 45));
        if ('cift' in b.transfer) {
          const c = Array.isArray(b.transfer.cift) ? b.transfer.cift.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
          if (c.length && (c.length !== 2 || c[0] === c[1])) throw Object.assign(new Error('Transfer için birbirinden farklı iki depo seçin'), { status: 400 });
          t.cift = c;
        }
        if (t.aktif && t.cift?.length === 2 && t.cift.includes(Number(t.yoldaDepo))) throw Object.assign(new Error('Yoldaki depo transfer yapılacak depolardan biri olamaz'), { status: 400 });
      }
      if (b.urun) {
        if (['aktif', 'tum'].includes(b.urun.kapsam)) yeni.urun.kapsam = b.urun.kapsam;
        if (b.urun.gun) yeni.urun.gun = Math.max(1, Math.min(3650, Number(b.urun.gun) || 365));
      }
      if (b.sayim) {
        if (typeof b.sayim.onek === 'string') yeni.sayim.onek = b.sayim.onek.trim().toUpperCase().slice(0, 3) || 'T';
        for (const k of ['ozelkod1', 'ozelkod2']) if (k in b.sayim) yeni.sayim[k] = b.sayim[k] === '' || b.sayim[k] === null ? null : String(b.sayim[k]);
        if ('userno' in b.sayim) yeni.sayim.userno = b.sayim.userno === '' || b.sayim.userno === null ? null : Number(b.sayim.userno);
      }
      if (b.etiket) {
        if (typeof b.etiket.yazici === 'string') yeni.etiket.yazici = b.etiket.yazici;
        for (const k of ['urunBicim', 'rafBicim']) if (b.etiket[k] && etiket.BICIM[b.etiket[k]]) yeni.etiket[k] = b.etiket[k];
        if ('rafGoster' in b.etiket) yeni.etiket.rafGoster = Boolean(b.etiket.rafGoster);
      }
      if (b.yedek) {
        const y = yeni.yedek || (yeni.yedek = {});
        if ('klasor' in b.yedek) {
          const k = String(b.yedek.klasor || '').trim();
          if (!path.isAbsolute(k)) throw Object.assign(new Error('Yedek klasörü tam yol olmalı (örnek C:/ortaşdepo-yedekler)'), { status: 400 });
          y.klasor = k;
        }
        if ('adet' in b.yedek) {
          const n = Number(b.yedek.adet);
          if (!Number.isInteger(n) || n < 1 || n > 60) throw Object.assign(new Error('Yedek sayısı 1-60 arasında olmalı'), { status: 400 });
          y.adet = n;
        }
      }
      if (b.yenileme) yeni.yenileme = Math.max(20, Math.min(3600, Number(b.yenileme) || 60));
      if (b.port) yeni.port = Math.max(1024, Math.min(65535, Number(b.port) || 5480));
      if ('yoneticiParola' in b) {
        if (b.yoneticiParola) {
          if (String(b.yoneticiParola).length < 4) throw Object.assign(new Error('Parola en az 4 karakter olmalı'), { status: 400 });
          yeni.yoneticiParola = config.parolaOzeti(b.yoneticiParola);
        } else if (!yerelMi(req)) throw Object.assign(new Error('Parola yalnız sunucu bilgisayarından kaldırılabilir'), { status: 403 });
        else yeni.yoneticiParola = '';
      }
      config.save(yeni);
      log.bilgi('Ayarlar kaydedildi');
      depo.vegaZamanla();
      const vegaDegisti = ['vega', 'kabul', 'rafAdresi', 'transfer'].some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(yeni[k]));
      if (vegaDegisti) await depo.vegaYenile('ayar');
      else depo.degisti();
      return { ...config.publicView(), portDegisti: yeni.port !== cfg.port };
    }),
  );

  const vegaAyari = (b) => {
    const c = config.load().vega;
    const v = { ...c, ...(b || {}) };
    if (!b || !b.password) v.password = c.password;
    return v;
  };
  r.post('/vega/dene', sar(async (req) => {
    const v = vegaAyari(req.body);
    await vega.dene(v);
    return { ok: true, firmalar: await vega.firmalar(v) };
  }));
  r.post('/vega/firmalar', sar(async (req) => vega.firmalar(vegaAyari(req.body))));
  r.post('/vega/donemler', sar(async (req) => vega.donemler(vegaAyari(req.body), Number(req.body.firma))));
  r.post('/vega/depolar', sar(async (req) => vega.depolar(vegaAyari(req.body), Number(req.body.firma))));
  r.post('/vega/yenile', sar(async () => depo.vegaYenile('elle')));
  r.get('/vega/fis-varsayilan', sar(async () => vega.fisVarsayilanlari(config.load())));

  // Ürünler
  r.get('/urunler', sar((req) => depo.urunListesi({ q: req.query.q, filtre: req.query.filtre || 'hepsi', depo: depo.depoSuzgec(req.query.depo), limit: Math.min(2000, Number(req.query.limit) || 300) })));
  r.get('/urunler.csv', sar((req, res) => {
    const { liste } = depo.urunListesi({ q: req.query.q, filtre: req.query.filtre || 'hepsi', depo: depo.depoSuzgec(req.query.depo), limit: 1e9 });
    csv(res, 'urunler.csv', ['Kod', 'Ad', 'Birim', 'Vega stok', 'Rafta', 'Raf sayısı', 'Rafa kaldırılacak', 'Yerleşmemiş'], liste.map((u) => [u.code, u.name, u.unit, u.vegaStock, u.raf, u.rafSayisi, u.bekleyen, u.fark]));
  }));
  r.get('/urun/:id', sar((req) => depo.urunDetay(req.params.id)));
  // Tanı: kartın Vega envanteri belge belge, neden terminale gitmediğiyle (Vega'dan canlı, salt okunur).
  r.get('/tani/stok', sar(async (req) => depo.stokTani(req.query.q)));
  r.post('/konum', sar((req) => {
    const b = req.body || {};
    const shelf = depo.rafKodu(b.shelf);
    const d = depo.depoCoz(b.depo);
    const qty = Number(b.qty);
    if (!b.productId || !shelf || !Number.isFinite(qty) || qty < 0) throw Object.assign(new Error('Ürün, raf ve miktar gerekli'), { status: 400 });
    if (!depo.rafVarMi(d, shelf)) throw Object.assign(new Error(`${shelf}, ${depo.depoAdi(d)} deposunda tanımlı bir raf değil`), { status: 400 });
    db.tx(() => depo.miktarAyarla(d, String(b.productId), shelf, qty, { kind: 'ADJUST', ref: String(b.not || 'Yönetici düzeltmesi').slice(0, 100), user: 'yönetici', device: 'PC' }));
    depo.degisti();
    return { ok: true };
  }));

  // Raflar
  r.get('/raflar', sar((req) => depo.raflar(depo.depoSuzgec(req.query.depo))));
  r.get('/raflar.csv', sar((req, res) => {
    csv(res, 'raflar.csv', ['Depo', 'Raf', 'Bölge', 'Ürün çeşidi', 'Toplam miktar', 'Not'], depo.raflar(depo.depoSuzgec(req.query.depo)).map((s) => [s.depoAd, s.code, s.zone, s.cesit, s.miktar, s.note]));
  }));
  r.get('/raf/:depo/:code', sar((req) => depo.rafDetay(depo.depoCoz(req.params.depo), req.params.code)));
  r.post('/raflar', sar((req) => {
    const kodlar = Array.isArray(req.body.kodlar) ? req.body.kodlar : [req.body.kod];
    return depo.raflarAc(req.body.depo, kodlar, { zone: req.body.zone || undefined, note: String(req.body.note || '') });
  }));
  r.put('/raf/:depo/:code', sar((req) => {
    const c = depo.rafKodu(req.params.code);
    const d = depo.depoCoz(req.params.depo);
    db.run('UPDATE shelf SET zone=COALESCE(?, zone), note=COALESCE(?, note) WHERE depo=? AND code=?', req.body.zone ?? null, req.body.note ?? null, d, c);
    depo.degisti();
    return { ok: true };
  }));
  r.delete('/raf/:depo/:code', sar((req) => {
    const c = depo.rafKodu(req.params.code);
    const d = depo.depoCoz(req.params.depo);
    const dolu = db.get('SELECT COUNT(*) AS n FROM location WHERE depo=? AND shelf=? AND qty>0', d, c).n;
    if (dolu) throw Object.assign(new Error(`${c} rafında ${dolu} ürün var; önce başka rafa aktarın`), { status: 400 });
    const vegadan = db.get("SELECT COUNT(*) AS n FROM product_home WHERE depo=? AND shelf=? AND source='VEGA'", d, c).n;
    if (vegadan) throw Object.assign(new Error(`${vegadan} ürünün Vega kartında raf adresi ${c}; önce Vega'da kartlardan silin`), { status: 400 });
    db.tx(() => {
      db.run('DELETE FROM product_home WHERE depo=? AND shelf=?', d, c);
      db.run('DELETE FROM shelf WHERE depo=? AND code=?', d, c);
    });
    depo.rafYazTetikle();
    depo.degisti();
    return { ok: true };
  }));
  // Raftaki her şeyi (ürünler ve zimmetler) başka rafa aktarır; ardından raf silinebilir.
  r.post('/raf/:depo/:code/bosalt', sar((req) => {
    const s = depo.rafBosalt(depo.depoCoz(req.params.depo), req.params.code, (req.body || {}).hedef);
    depo.degisti();
    return s;
  }));

  // Zimmet: ürünün asıl rafları
  r.post('/zimmet', sar((req) => {
    const b = req.body || {};
    const d = depo.depoCoz(b.depo);
    const shelf = depo.rafKodu(b.shelf);
    if (!b.productId || !shelf) throw Object.assign(new Error('Ürün ve raf gerekli'), { status: 400 });
    if (!depo.rafKoduGecerli(shelf)) throw Object.assign(new Error(`Geçersiz raf kodu: ${shelf}`), { status: 400 });
    db.tx(() => {
      if (!depo.rafVarMi(d, shelf)) depo.rafEkle(d, shelf);
      depo.zimmetEkle(d, String(b.productId), shelf, 'ADMIN');
    });
    depo.degisti();
    return { ok: true };
  }));
  r.delete('/zimmet', sar((req) => {
    const b = req.body || {};
    const ok = depo.zimmetSil(depo.depoCoz(b.depo), String(b.productId || ''), b.shelf);
    depo.degisti();
    return { ok };
  }));
  // Yönetici: ürünü raftan rafa taşı (miktar boşsa hepsi).
  r.post('/tasi', sar((req) => {
    const b = req.body || {};
    if (!b.productId) throw Object.assign(new Error('Ürün gerekli'), { status: 400 });
    const s = depo.tasi(depo.depoCoz(b.depo), String(b.productId), b.from, b.to, b.qty ?? null, { zimmetTasi: Boolean(b.zimmetTasi) });
    depo.degisti();
    return s;
  }));

  // Depolar arası transfer (transfer.js)
  r.get('/transfer', sar(() => transfer.liste()));
  r.post('/transfer/yenile', sar(async () => {
    await transfer.yenile();
    return transfer.liste();
  }));
  r.post('/transfer/:id/yeniden', sar((req) => {
    if (!transfer.yenidenDene(req.params.id)) throw Object.assign(new Error('Kayıt bulunamadı ya da zaten yazıldı'), { status: 404 });
    return { ok: true };
  }));
  // Yönetici: terminalden gelen transferi geri alır (Vega fişi silinir, raf stoku eski haline döner). Ayrıntı: transfer.geriAl.
  r.post('/transfer/:id/geri-al', sar(async (req) => ({ ok: true, ...(await transfer.geriAl(req.params.id, 'yönetici', req.body?.not)) })));
  // Yönetici: terminalden yapılan rafa kaldırmayı geri alır (raf stoku düşer, belgede kalan geri gelir). Ayrıntı: depo.rafaKaldirmaGeriAl.
  r.post('/hareket/:id/geri-al', sar((req) => ({ ok: true, ...depo.rafaKaldirmaGeriAl(req.params.id, 'yönetici', req.body?.not) })));

  // Sanal bekleme depoları (106, 109 → Merkez). Açmak raf kayıtlarını taşıdığı için önce yedek alınır.
  r.get('/bekleme', sar(() => bekleme.rapor()));
  r.post('/bekleme/onizle', sar((req) => bekleme.onizle(req.body || {})));
  r.post('/bekleme/ac', sar((req) => {
    const b = req.body || {};
    const o = bekleme.onizle(b);
    if (o.engeller.length) throw Object.assign(new Error(o.engeller[0]), { status: 400 });
    yedekAl('bekleme');
    return bekleme.ac({ depolar: b.depolar, hedef: b.hedef, kim: 'yönetici' });
  }));
  r.post('/bekleme/kapat', sar(() => bekleme.kapat('yönetici')));
  // Programın Vega'ya yazdığı fişler tek listede (sayım fişleri + depo transferleri); "Vega'ya yazılanlar" sayfası.
  r.get('/vega-yazimlari', sar(() => {
    const ad = (d) => depo.depoAdi(d);
    const transferler = db
      .all("SELECT * FROM transfer WHERE durum IN ('YAZILDI','GERI','BEKLIYOR','HATA') AND (vega_ind IS NOT NULL OR durum<>'YAZILDI' OR geri_at IS NOT NULL) ORDER BY created_at DESC LIMIT 300")
      .map((t) => {
        const satir = db.all('SELECT product_id, SUM(qty) AS q FROM transfer_line WHERE transfer_id=? GROUP BY product_id', t.id);
        return {
          tur: t.kind === 'SEND' ? 'TRANSFER_GONDERIM' : 'TRANSFER_KABUL',
          tanim: t.kind === 'SEND' ? 'Depo gönderim fişi (128)' : 'Gönderim kabul fişi (129)',
          id: t.id,
          belgeNo: t.belge_no || t.sevk_no || '',
          durum: t.durum,
          hata: t.hata,
          zaman: t.yazildi_at || t.created_at,
          depo: t.kind === 'SEND' ? `${ad(t.from_depo)} → ${ad(t.to_depo)}` : `${ad(t.from_depo)} → ${ad(t.to_depo)} (kabul)`,
          kullanici: t.user,
          cihaz: t.device,
          kalem: satir.length,
          adet: Math.round(satir.reduce((a, b) => a + b.q, 0) * 10000) / 10000,
          geriAt: t.geri_at,
          geriKullanici: t.geri_user,
          geriNot: t.geri_not,
        };
      });
    const sayimlar = db.all("SELECT * FROM count_session WHERE vega_docs IS NOT NULL OR vega_written_at IS NOT NULL ORDER BY vega_written_at DESC LIMIT 200").map((s) => {
      const docs = s.vega_docs ? JSON.parse(s.vega_docs).docs || [] : [];
      return {
        tur: 'SAYIM',
        tanim: 'Sayım fişi (fark)',
        id: s.id,
        belgeNo: docs.map((d) => d.belgeNo).join(', ') || s.no,
        durum: s.status === 'APPROVED' ? 'YAZILDI' : s.status,
        zaman: s.vega_written_at,
        depo: ad(s.depo),
        sayimNo: s.no,
        kalem: docs.length,
      };
    });
    return { liste: [...transferler, ...sayimlar].sort((a, b) => (b.zaman || 0) - (a.zaman || 0)) };
  }));
  r.post('/transfer/acik/:ind/kapat', sar((req) => {
    if (!transfer.acikKapat(req.params.ind, 'yönetici')) throw Object.assign(new Error('Gönderim açık görünmüyor'), { status: 404 });
    return { ok: true };
  }));
  r.post('/transfer/fark/:id/coz', sar((req) => {
    if (!transfer.farkCoz(req.params.id, String(req.body?.cozum || ''), req.body?.not, 'yönetici')) throw Object.assign(new Error('Fark kaydı bulunamadı'), { status: 404 });
    return { ok: true };
  }));
  r.post('/transfer/fark/:id/ac', sar((req) => {
    if (!transfer.farkAc(req.params.id)) throw Object.assign(new Error('Fark kaydı bulunamadı'), { status: 404 });
    return { ok: true };
  }));

  // Belge kilitleri (kilit.js): açık belgeler tablosu, tek kilidi aç, hepsini sıfırla
  r.get('/kilitler', sar(() => {
    const belgeler = new Map(depo.belgeler().map((b) => [b.id, b]));
    return {
      sureSn: kilit.SURE / 1000,
      liste: kilit.yoneticiListesi((k) => {
        const b = belgeler.get(k.id);
        return { firma: b?.supplier || '', depoAd: b?.depoAd || '', belgeNo: b?.docNo || k.no || k.id };
      }),
    };
  }));
  r.post('/kilitler/ac', sar((req) => {
    if (!kilit.yoneticiAc(req.body?.belgeId, 'yönetici')) throw Object.assign(new Error('Kilit bulunamadı (süresi dolmuş ya da bırakılmış olabilir)'), { status: 404 });
    return { ok: true };
  }));
  r.post('/kilitler/sifirla', sar(() => ({ ok: true, sifirlanan: kilit.yoneticiSifirla('yönetici') })));

  // Mal kabul
  r.get('/kabul', sar((req) => {
    const d = req.query.durum || 'acik';
    const dp = depo.depoSuzgec(req.query.depo);
    return depo
      .belgeler()
      .filter((b) => (d === 'acik' ? b.acik : d === 'kapali' ? !b.acik : true) && (dp === null || b.depo === dp))
      .map(({ lines, ...b }) => b);
  }));
  r.get('/kabul/:id', sar((req) => {
    const b = depo.belgeler().find((x) => x.id === req.params.id);
    if (!b) throw Object.assign(new Error('Belge bulunamadı'), { status: 404 });
    const hareket = db.all("SELECT * FROM movement WHERE kind='PUTAWAY' AND ref=? ORDER BY ts DESC", b.docNo);
    return {
      ...b,
      lines: b.lines.map((l) => ({ ...l, ...depo.urunAdi(l.productId), unit: depo.urun(l.productId)?.unit || '' })),
      hareketler: hareket.map((h) => ({ ...h, ...depo.urunAdi(h.product_id) })),
    };
  }));
  r.post('/kabul/:id/kapat', sar((req) => {
    db.run(
      'INSERT INTO receipt_state(receipt_id, closed, closed_at, note) VALUES(?,1,?,?) ON CONFLICT(receipt_id) DO UPDATE SET closed=1, closed_at=excluded.closed_at, note=excluded.note',
      req.params.id,
      Date.now(),
      String(req.body?.not || ''),
    );
    depo.degisti();
    return { ok: true };
  }));
  r.post('/kabul/:id/ac', sar((req) => {
    db.run('UPDATE receipt_state SET closed=0 WHERE receipt_id=?', req.params.id);
    depo.degisti();
    return { ok: true };
  }));

  // Sayım
  r.get('/sayimlar', sar(() => {
    const satir = new Map(db.all('SELECT session_id, COUNT(*) AS n, SUM(CASE WHEN ABS(counted-server_before)>0.000001 THEN 1 ELSE 0 END) AS fark FROM count_line GROUP BY session_id').map((x) => [x.session_id, x]));
    const raf = new Map(db.all('SELECT session_id, COUNT(*) AS n FROM count_shelf GROUP BY session_id').map((x) => [x.session_id, x.n]));
    return db.all('SELECT * FROM count_session ORDER BY created_at DESC LIMIT 500').map((s) => ({
      ...s,
      depoAd: depo.depoAdi(s.depo),
      vega_docs: s.vega_docs ? JSON.parse(s.vega_docs).docs : null,
      kalem: satir.get(s.id)?.n || 0,
      raf: raf.get(s.id) || 0,
      rafFarkli: satir.get(s.id)?.fark || 0,
    }));
  }));
  r.get('/raf-gruplari', sar((req) => depo.rafGruplari(depo.depoCoz(req.query.depo))));
  // Raf sayımı kapsamının önizlemesi: öneklere uyan raf sayısı ve ilk birkaçı.
  r.get('/sayim-kapsam', sar((req) => {
    const onekler = kapsam.coz(req.query.kapsam);
    const d = depo.depoCoz(req.query.depo);
    const raflar = onekler.length ? depo.kapsamRaflari(d, onekler) : [];
    // "A-0" A-01'i kapsamaz; düz önek ("A-0*") daha çok raf bulursa kullanıcıya önerilir.
    const duz = onekler.map((o) => (o.endsWith('*') ? o : o + '*'));
    const duzAdet = onekler.length ? depo.kapsamRaflari(d, duz).length : 0;
    return { onekler, adet: raflar.length, ornek: raflar.slice(0, 12), oneri: duzAdet > raflar.length ? { kapsam: duz.join(', '), adet: duzAdet } : null };
  }));
  r.post('/sayimlar', sar((req) => {
    const b = req.body || {};
    const kind = b.kind === 'GENEL' ? 'GENEL' : 'RAF';
    const d = depo.depoCoz(b.depo);
    // Genel sayım bütün depoyu sayar; kapsam yalnız raf sayımında.
    const onekler = kind === 'RAF' ? kapsam.coz(b.scope) : [];
    if (onekler.length && !depo.kapsamRaflari(d, onekler).length) {
      throw Object.assign(new Error(`Kapsama uyan raf yok (${onekler.join(', ')})`), { status: 400 });
    }
    const id = 'C' + crypto.randomBytes(5).toString('hex');
    const no = depo.sayimNo();
    db.run(
      'INSERT INTO count_session(id, no, title, blind, kind, status, source, note, created_at, depo, scope) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id,
      no,
      String(b.title || 'Sayım').trim().slice(0, 60) || 'Sayım',
      b.blind === false ? 0 : 1,
      kind,
      'OPEN',
      'ADMIN',
      String(b.note || '').slice(0, 300),
      Date.now(),
      d,
      onekler.join(','),
    );
    depo.degisti();
    log.bilgi(`Sayım açıldı: ${no}`);
    return { id, no };
  }));
  r.get('/sayim/:id', sar((req) => {
    const o = depo.sayimOzet(req.params.id, { dahilSayilmayan: req.query.dahil === '1' });
    if (!o) throw Object.assign(new Error('Sayım bulunamadı'), { status: 404 });
    return o;
  }));
  r.get('/sayim/:id/csv', sar((req, res) => {
    const o = depo.sayimOzet(req.params.id, { dahilSayilmayan: req.query.dahil === '1' });
    if (!o) throw Object.assign(new Error('Sayım bulunamadı'), { status: 404 });
    if (req.query.tur === 'raf') {
      return csv(res, `${o.oturum.no}-raflar.csv`, ['Raf', 'Kod', 'Ad', 'Önceki', 'Sayılan', 'Fark', 'Sayan', 'Cihaz', 'Zaman'],
        o.satirlar.map((l) => [l.shelf, l.urunKod, l.urunAd, l.server_before, l.counted, l.fark, l.user, l.device, tarihSaat(l.submitted_at)]));
    }
    csv(res, `${o.oturum.no}-urunler.csv`, ['Kod', 'Ad', 'Birim', 'Sayılan', 'Diğer raflar', 'Rafa kaldırılacak', 'Olması gereken', 'Vega stok', 'Fark'],
      o.urunler.map((u) => [u.code, u.name, u.unit, u.sayilan, u.digerRaflar, u.bekleyen, u.hedef, u.vegaStock, u.fark]));
  }));
  r.put('/sayim/:id', sar((req) => {
    const b = req.body || {};
    db.run('UPDATE count_session SET title=COALESCE(?, title), blind=COALESCE(?, blind), kind=COALESCE(?, kind), note=COALESCE(?, note) WHERE id=?',
      b.title ?? null, b.blind === undefined ? null : b.blind ? 1 : 0, b.kind === 'GENEL' || b.kind === 'RAF' ? b.kind : null, b.note ?? null, req.params.id);
    db.run("UPDATE count_session SET scope='' WHERE id=? AND kind='GENEL'", req.params.id);
    depo.degisti();
    return { ok: true };
  }));
  const durumYap = (durum, izinli) => sar((req) => {
    const s = db.get('SELECT status FROM count_session WHERE id=?', req.params.id);
    if (!s) throw Object.assign(new Error('Sayım bulunamadı'), { status: 404 });
    if (!izinli.includes(s.status)) throw Object.assign(new Error('Bu durumdaki sayımda yapılamaz'), { status: 400 });
    db.run('UPDATE count_session SET status=?, closed_at=CASE WHEN ?=\'OPEN\' THEN NULL ELSE ? END WHERE id=?', durum, durum, Date.now(), req.params.id);
    depo.degisti();
    return { ok: true };
  });
  r.post('/sayim/:id/kapat', durumYap('CLOSED', ['OPEN']));
  r.post('/sayim/:id/ac', durumYap('OPEN', ['CLOSED']));
  r.post('/sayim/:id/iptal', durumYap('CANCELLED', ['OPEN', 'CLOSED']));
  r.post('/sayim/:id/onayla', sar(async (req) => {
    const b = req.body || {};
    const sonuc = await depo.sayimOnayla(req.params.id, {
      vegaYaz: Boolean(b.vegaYaz),
      stoknolar: Array.isArray(b.stoknolar) ? b.stoknolar : null,
      dahilSayilmayan: Boolean(b.dahilSayilmayan),
    });
    return { ok: true, sonuc };
  }));
  r.post('/sayim/:id/geri-al', sar(async (req) => {
    await depo.sayimGeriAl(req.params.id);
    return { ok: true };
  }));

  // Hareketler ve işlem günlüğü
  const hareketSorgu = (q) => {
    const w = [];
    const a = [];
    if (q.bas) { w.push('ts >= ?'); a.push(new Date(`${q.bas}T00:00:00`).getTime()); }
    if (q.bit) { w.push('ts < ?'); a.push(new Date(`${q.bit}T00:00:00`).getTime() + 86400000); }
    if (q.tur) { w.push('kind IN (' + String(q.tur).split(',').map(() => '?').join(',') + ')'); a.push(...String(q.tur).split(',')); }
    if (q.kullanici) { w.push('user = ?'); a.push(q.kullanici); }
    if (q.cihaz) { w.push('device = ?'); a.push(q.cihaz); }
    if (q.raf) { w.push('shelf = ?'); a.push(depo.rafKodu(q.raf)); }
    if (depo.depoSuzgec(q.depo) !== null) { w.push('depo = ?'); a.push(depo.depoSuzgec(q.depo)); }
    if (q.urun) { w.push('product_id = ?'); a.push(String(q.urun)); }
    return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a };
  };
  r.get('/hareketler', sar((req) => {
    const { where, args } = hareketSorgu(req.query);
    const limit = Math.min(5000, Number(req.query.limit) || 500);
    const liste = db.all(`SELECT * FROM movement ${where} ORDER BY ts DESC, id DESC LIMIT ${limit}`, ...args).map((h) => ({ ...h, depoAd: depo.depoAdi(h.depo), ...depo.urunAdi(h.product_id) }));
    const toplam = db.get(`SELECT COUNT(*) AS n FROM movement ${where}`, ...args).n;
    const kisiler = db.all('SELECT DISTINCT user FROM movement WHERE user IS NOT NULL ORDER BY user').map((x) => x.user);
    const cihazlar = db.all('SELECT DISTINCT device FROM movement WHERE device IS NOT NULL ORDER BY device').map((x) => x.device);
    return { toplam, liste, kisiler, cihazlar };
  }));
  r.get('/hareketler.csv', sar((req, res) => {
    const { where, args } = hareketSorgu(req.query);
    const liste = db.all(`SELECT * FROM movement ${where} ORDER BY ts DESC, id DESC LIMIT 200000`, ...args);
    csv(res, 'hareketler.csv', ['Zaman', 'Tür', 'Depo', 'Raf', 'Kod', 'Ad', 'Miktar', 'Sonra', 'Belge/Not', 'Kullanıcı', 'Cihaz'],
      liste.map((h) => { const u = depo.urunAdi(h.product_id); return [tarihSaat(h.ts), h.kind, depo.depoAdi(h.depo), h.shelf, u.urunKod, u.urunAd, h.delta, h.after, h.ref, h.user, h.device]; }));
  }));
  r.get('/islemler', sar((req) => {
    const w = req.query.hatali === '1' ? 'WHERE ok=0' : '';
    return db.all(`SELECT * FROM op ${w} ORDER BY received_at DESC LIMIT 300`).map((o) => ({ ...o, payload: JSON.parse(o.payload) }));
  }));

  // Kullanıcılar
  // Yetki kataloğu (yetki.js): izinler, hazır şablonlar ve seçilebilir depolar. Kullanıcılar sayfasındaki form bunu kullanır.
  r.get('/izinler', sar(() => ({ izinler: yetki.IZINLER, sablonlar: yetki.SABLONLAR, depolar: depo.depolar().map((d) => ({ ind: d.ind, ad: d.ad })) })));
  const kullaniciListesi = () =>
    db.all('SELECT username, name, active, created_at, role, perms, depots, shelves FROM app_user ORDER BY username').map((u) => ({
      ...u,
      perms: u.perms === '*' ? null : u.perms.split(',').filter(Boolean),
      depots: u.depots === '*' ? null : u.depots.split(',').filter(Boolean).map(Number),
      shelves: u.shelves === '*' ? null : u.shelves.split(',').filter(Boolean),
    }));
  r.get('/kullanicilar', sar(() => kullaniciListesi()));
  r.post('/kullanicilar', sar((req) => {
    const b = req.body || {};
    const u = String(b.username || '').trim().toLowerCase();
    const pin = String(b.pin || '');
    if (!/^[a-z0-9._ğüşıöç-]{2,24}$/.test(u)) throw Object.assign(new Error('Kullanıcı adı 2-24 karakter: harf, rakam, nokta, tire'), { status: 400 });
    if (!/^\d{4,8}$/.test(pin)) throw Object.assign(new Error('Şifre 4-8 haneli rakam olmalı'), { status: 400 });
    if (db.get('SELECT 1 FROM app_user WHERE username=?', u)) throw Object.assign(new Error('Bu kullanıcı adı var'), { status: 400 });
    // Yetki verilmezse tam yetkili açılır (eski davranış); yönetici formda daraltır.
    const perms = b.perms === undefined ? '*' : yetki.izinlerDogrula(b.perms);
    const depots = b.depots === undefined ? '*' : yetki.depolariDogrula(b.depots);
    const shelves = b.shelves === undefined ? '*' : yetki.raflariDogrula(b.shelves);
    const salt = crypto.randomBytes(12).toString('hex');
    db.run(
      'INSERT INTO app_user(username, name, salt, pin_hash, active, created_at, role, perms, depots, shelves) VALUES(?,?,?,?,1,?,?,?,?,?)',
      u, String(b.name || u).trim().slice(0, 40), salt, pinOzeti(salt, pin), Date.now(), perms === '*' ? 'tam' : yetki.rolDogrula(b.role), perms, depots, shelves,
    );
    depo.degisti();
    return { ok: true };
  }));
  r.put('/kullanici/:u', sar((req) => {
    const b = req.body || {};
    const u = String(req.params.u || '').trim().toLowerCase();
    if (!db.get('SELECT 1 FROM app_user WHERE username=?', u)) throw Object.assign(new Error('Kullanıcı yok'), { status: 404 });
    if (b.pin) {
      if (!/^\d{4,8}$/.test(String(b.pin))) throw Object.assign(new Error('Şifre 4-8 haneli rakam olmalı'), { status: 400 });
      const salt = crypto.randomBytes(12).toString('hex');
      db.run('UPDATE app_user SET salt=?, pin_hash=? WHERE username=?', salt, pinOzeti(salt, String(b.pin)), u);
    }
    if (b.name !== undefined) db.run('UPDATE app_user SET name=? WHERE username=?', String(b.name).trim().slice(0, 40) || u, u);
    if (b.active !== undefined) db.run('UPDATE app_user SET active=? WHERE username=?', b.active ? 1 : 0, u);
    if (b.perms !== undefined) {
      const perms = yetki.izinlerDogrula(b.perms);
      db.run('UPDATE app_user SET perms=?, role=? WHERE username=?', perms, perms === '*' ? 'tam' : yetki.rolDogrula(b.role), u);
    }
    if (b.depots !== undefined) db.run('UPDATE app_user SET depots=? WHERE username=?', yetki.depolariDogrula(b.depots), u);
    if (b.shelves !== undefined) db.run('UPDATE app_user SET shelves=? WHERE username=?', yetki.raflariDogrula(b.shelves), u);
    depo.degisti();
    return { ok: true };
  }));
  r.delete('/kullanici/:u', sar((req) => {
    db.run('DELETE FROM app_user WHERE username=?', String(req.params.u || '').trim().toLowerCase());
    depo.degisti();
    return { ok: true };
  }));

  // Cihazlar
  r.get('/cihazlar', sar(() => db.all('SELECT * FROM device ORDER BY name')));
  r.post('/cihazlar', sar((req) => {
    const ad = String(req.body?.name || '').trim().slice(0, 30);
    if (!ad) throw Object.assign(new Error('Cihaz adı girin (örnek TRM-01)'), { status: 400 });
    const key = crypto.randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 12);
    const fmt = key.match(/.{4}/g).join('-');
    const r2 = db.run('INSERT INTO device(name, key, active, created_at) VALUES(?,?,1,?)', ad, fmt, Date.now());
    log.bilgi(`Cihaz eklendi: ${ad}`);
    return { id: Number(r2.lastInsertRowid), key: fmt };
  }));
  r.put('/cihaz/:id', sar((req) => {
    const b = req.body || {};
    if (b.name !== undefined) db.run('UPDATE device SET name=? WHERE id=?', String(b.name).trim().slice(0, 30), Number(req.params.id));
    if (b.active !== undefined) db.run('UPDATE device SET active=? WHERE id=?', b.active ? 1 : 0, Number(req.params.id));
    return { ok: true };
  }));
  r.delete('/cihaz/:id', sar((req) => {
    db.run('DELETE FROM device WHERE id=?', Number(req.params.id));
    return { ok: true };
  }));
  r.get('/cihaz/:id/qr', sar(async (req) => {
    const c = db.get('SELECT * FROM device WHERE id=?', Number(req.params.id));
    if (!c) throw Object.assign(new Error('Cihaz yok'), { status: 404 });
    // url: köprü gibi başka bir bağlantı adresi (kopruler'den seçilir); ip: bu bilgisayarın adreslerinden biri.
    const ip = String(req.query.ip || adresler()[0]?.ip || '127.0.0.1');
    const verilen = String(req.query.url || '');
    if (verilen && !/^https?:\/\/[\w.\-]+(:\d{2,5})?$/.test(verilen)) throw Object.assign(new Error('Bağlantı adresi geçersiz'), { status: 400 });
    const url = verilen || `http://${ip}:${config.load().port}`;
    // Terminal Ayarlar › "QR ile kur" bu metni okur.
    const metin = `ORTASDEPO|${url}|${c.key}|${c.name}`;
    return { url, metin, qr: await QRCode.toDataURL(metin, { margin: 1, width: 320, errorCorrectionLevel: 'M' }), apkQr: await QRCode.toDataURL(`${url}/kur`, { margin: 1, width: 320 }) };
  }));

  // Excel'den raf içe aktarma: oku → eşleştir/önizle → uygula. Okunan dosya bir saat bellekte durur.
  const yuklenen = new Map();
  const dosyaAl = (anahtar) => {
    const x = yuklenen.get(String(anahtar || ''));
    if (!x) throw Object.assign(new Error('Dosya bulunamadı; yeniden yükleyin'), { status: 400 });
    return x;
  };
  r.post('/ice-aktar/oku', sar(async (req) => {
    const b = req.body || {};
    const buf = Buffer.from(String(b.icerik || ''), 'base64');
    if (!buf.length) throw Object.assign(new Error('Dosya boş'), { status: 400 });
    const t = await iceaktar.oku(String(b.ad || ''), buf);
    const anahtar = crypto.randomBytes(8).toString('hex');
    yuklenen.set(anahtar, t);
    setTimeout(() => yuklenen.delete(anahtar), 3600 * 1000).unref?.();
    return { anahtar, basliklar: t.basliklar, ornek: t.satirlar.slice(0, 8), toplam: t.satirlar.length, tahmin: iceaktar.tahminEt(t.basliklar), depolar: depo.depolar() };
  }));
  r.post('/ice-aktar/onizle', sar((req) => {
    const b = req.body || {};
    const c = iceaktar.coz({ ...dosyaAl(b.anahtar), eslesme: b.eslesme || {}, depoEslesme: b.depoEslesme || {}, sabitDepo: b.sabitDepo });
    return { ozet: iceaktar.ozet(c), hatalar: c.hatalar.slice(0, 200), depolar: c.depolar };
  }));
  r.post('/ice-aktar/uygula', sar((req) => {
    const b = req.body || {};
    const c = iceaktar.coz({ ...dosyaAl(b.anahtar), eslesme: b.eslesme || {}, depoEslesme: b.depoEslesme || {}, sabitDepo: b.sabitDepo });
    const s = iceaktar.uygula(c, { miktarModu: b.miktarModu === 'ekle' ? 'ekle' : 'ayarla' });
    log.bilgi(`Excel içe aktarma: ${c.satirlar.length} satır, ${s.yeniRaf} yeni raf, ${s.miktar} miktar, ${s.asilRaf} asıl raf, ${c.hatalar.length} hatalı satır atlandı`);
    yuklenen.delete(String(b.anahtar));
    return { ...s, atlanan: c.hatalar.length };
  }));
  r.get('/ice-aktar/sablon.xlsx', sar(async (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''raf-sablonu.xlsx");
    res.send(await iceaktar.sablon());
  }));

  // Etiket
  r.get('/etiket/bicimler', (req, res) => res.json({ bicimler: Object.entries(etiket.BICIM).map(([k, v]) => ({ kod: k, ad: v.ad })), yazdirabilir: Boolean(masaustu.yazdir), pdf: Boolean(masaustu.pdf) }));
  r.get('/yazicilar', sar(async () => (masaustu.yazicilar ? await masaustu.yazicilar() : [])));
  r.post('/etiket/onizle', sar((req) => {
    const h = etiketHazirla({ ...req.body, adet: 1 }, sunucu.address().port);
    return { html: h.html, sayfa: h.sayfa };
  }));
  r.post('/etiket/yazdir', sar(async (req) => etiketBas(req.body || {}, sunucu.address().port, 'yönetici')));
  r.post('/etiket/pdf', sar(async (req) => {
    if (!masaustu.pdf) throw Object.assign(new Error('PDF yalnız sunucu bilgisayarında'), { status: 400 });
    const h = etiketHazirla(req.body || {}, sunucu.address().port);
    return { dosya: await masaustu.pdf(h.html, { ad: `${h.tur === 'urun' ? 'urun' : 'raf'}-etiketleri-${h.etiket}` }) };
  }));

  // Yedek ve klasörler
  r.post('/yedek', sar(() => ({ ad: yedekAl('elle') })));
  r.get('/yedekler', sar(() => yedekListe(yedekKlasoru())));
  r.post('/klasor', sar(async (req) => {
    if (!yerelMi(req) || !masaustu.klasorAc) throw Object.assign(new Error('Yalnız sunucu bilgisayarında'), { status: 400 });
    const k = { yedek: yedekKlasoru(), gunluk: log.klasor(), veri: path.dirname(db.file()) }[req.body?.ne];
    if (!k) throw Object.assign(new Error('Bilinmeyen klasör'), { status: 400 });
    await masaustu.klasorAc(k);
    return { ok: true };
  }));

  return r;
}

// ---- Uygulama ----------------------------------------------------------------------------------

function uygulama({ arayuz }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(compression({ threshold: 2048 }));
  app.use(express.json({ limit: '20mb' }));

  app.use('/api', terminalApi());
  app.use('/yonetim/api', yoneticiApi());

  app.get('/apk', (req, res) => {
    const a = apk.bilgi();
    if (!a) return hata(res, 404, 'APK bu kurulumda yok');
    res.download(a.dosya, a.file);
  });
  // Terminalin tarayıcısında açılan basit indirme sayfası (QR ile gelinir).
  app.get('/kur', (req, res) => {
    const a = apk.bilgi();
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ortaş Depo Terminali</title>
<body style="font-family:sans-serif;background:#F4F5F7;margin:0;padding:24px;color:#1B2430">
<h2 style="margin:0 0 8px">Ortaş Depo Terminali</h2>
${a ? `<p>Sürüm ${a.versionName} · ${(a.boyut / 1048576).toFixed(1)} MB</p>
<p><a href="/apk" style="display:block;background:#F2B705;color:#1B2430;text-align:center;padding:16px;border-radius:12px;font-weight:700;text-decoration:none">APK'yı indir</a></p>
<p style="font-size:14px;color:#555">İndirince açın; "bilinmeyen kaynak" izni istenirse verin. Kurulumdan sonra uygulamada Ayarlar › QR ile kur.</p>` : '<p>Bu kurulumda APK yok.</p>'}
</body>`);
  });

  if (arayuz && fs.existsSync(arayuz)) {
    app.use(express.static(arayuz, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|yonetim\/api\/).*/, (req, res) => res.sendFile(path.join(arayuz, 'index.html')));
  }
  app.use((req, res) => hata(res, 404, 'Bulunamadı'));
  return app;
}

/**
 * Sunucuyu başlatır. `veriKlasoru`: config.json, depo.db, yedek/ ve gunluk/ burada.
 * Dönen: dinlenen port.
 */
async function baslat({ veriKlasoru, apkKlasoru, arayuz, host = '0.0.0.0', port } = {}) {
  fs.mkdirSync(veriKlasoru, { recursive: true });
  log.kur(path.join(veriKlasoru, 'gunluk'));
  rapor.kur(veriKlasoru, SURUM);
  config.init(path.join(veriKlasoru, 'config.json'));
  db.open(path.join(veriKlasoru, 'depo.db'), { varsayilanDepo: config.load().vega.depo });
  yedekYedekKlasor = path.join(veriKlasoru, 'yedek');
  apk.kur(apkKlasoru || path.join(__dirname, '..', 'apk'));

  depo.goruntuYukleOnbellek();
  depo.vegaYenile('açılış').catch(() => {});
  depo.vegaZamanla();
  // Önceki oturumdan Vega'ya yazılmamış transferler varsa Vega okumasından sonra yazılır.
  transfer.yaziciTetikle(8000);
  yedekZamanla();

  const p = port ?? config.load().port;
  const app = uygulama({ arayuz: arayuz || path.join(__dirname, '..', 'client', 'dist') });
  await new Promise((resolve, reject) => {
    // Express 5 dinleme hatasını (EADDRINUSE) geri çağırmaya verir, çözüm önce davranıp hatayı yutuyordu.
    sunucu = app.listen(p, host, (err) => (err ? reject(err) : resolve()));
  });
  const gercek = sunucu.address().port;
  log.bilgi(`Sunucu ${SURUM} dinliyor: ${host}:${gercek} · ${adresler().map((a) => a.ip).join(', ')}`);
  return gercek;
}

function masaustuBagla(f) {
  masaustu = f || {};
}

async function durdur() {
  if (sunucu) await new Promise((r) => sunucu.close(() => r()));
  await vega.kapat();
  db.close();
}

module.exports = { baslat, durdur, masaustuBagla, adresler, yedekAl };

if (require.main === module) {
  // Geliştirme: node server/index.js  → veri ./veri klasöründe
  baslat({ veriKlasoru: process.env.ORTAS_VERI || path.join(__dirname, '..', 'veri') }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
