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

const SURUM = require('../package.json').version;
let yedekKlasoru = null;
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

function yedekAl(etiket = 'otomatik') {
  const an = new Date();
  const ad = `depo-${an.getFullYear()}${String(an.getMonth() + 1).padStart(2, '0')}${String(an.getDate()).padStart(2, '0')}-${String(an.getHours()).padStart(2, '0')}${String(an.getMinutes()).padStart(2, '0')}-${etiket}.db`;
  const hedef = path.join(yedekKlasoru, ad);
  db.backup(hedef);
  // Otomatik yedeklerin son 30'u kalır; elle alınanlara dokunulmaz.
  const oto = fs.readdirSync(yedekKlasoru).filter((f) => f.endsWith('-otomatik.db')).sort();
  for (const f of oto.slice(0, Math.max(0, oto.length - 30))) fs.unlinkSync(path.join(yedekKlasoru, f));
  db.set('sonYedek', Date.now());
  log.bilgi(`Yedek alındı: ${ad}`);
  return ad;
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
  setTimeout(kontrol, 60 * 1000);
  setInterval(kontrol, 3600 * 1000);
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
        return { depo: Number(a), code: depo.rafKodu(b) };
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
    String(req.socket.remoteAddress || '').replace('::ffff:', ''),
    String(req.get('X-Device-Name') || c.name).slice(0, 60),
    req.get('X-App-Version') || null,
    c.id,
  );
  next();
}

function terminalApi() {
  const r = express.Router();
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
        },
        bugun: islem,
        cihazlar,
        sonHareketler: db
          .all('SELECT * FROM movement ORDER BY ts DESC, id DESC LIMIT 12')
          .map((h) => ({ ...h, depoAd: depo.depoAdi(h.depo), ...depo.urunAdi(h.product_id) })),
        apk: ap ? { versionName: ap.versionName, versionCode: ap.versionCode, boyut: ap.boyut } : null,
        sonYedek: Number(db.meta('sonYedek', 0)) || null,
        masaustu: Boolean(masaustu.klasorAc),
      };
    }),
  );

  // Ayarlar
  r.get('/ayarlar', (req, res) => res.json({ ...config.publicView(), dosyalar: { veri: db.file(), yedek: yedekKlasoru, gunluk: log.klasor() } }));
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
        if ('depo' in b.rafAdresi) yeni.rafAdresi.depo = b.rafAdresi.depo === '' || b.rafAdresi.depo === null ? null : Number(b.rafAdresi.depo);
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
      if (b.yenileme) yeni.yenileme = Math.max(30, Math.min(3600, Number(b.yenileme) || 120));
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
      const vegaDegisti = ['vega', 'kabul', 'rafAdresi'].some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(yeni[k]));
      if (vegaDegisti) await depo.vegaYenile();
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
  r.post('/vega/yenile', sar(async () => depo.vegaYenile()));
  r.get('/vega/fis-varsayilan', sar(async () => vega.fisVarsayilanlari(config.load())));

  // Ürünler
  r.get('/urunler', sar((req) => depo.urunListesi({ q: req.query.q, filtre: req.query.filtre || 'hepsi', depo: depo.depoSuzgec(req.query.depo), limit: Math.min(2000, Number(req.query.limit) || 300) })));
  r.get('/urunler.csv', sar((req, res) => {
    const { liste } = depo.urunListesi({ q: req.query.q, filtre: req.query.filtre || 'hepsi', depo: depo.depoSuzgec(req.query.depo), limit: 1e9 });
    csv(res, 'urunler.csv', ['Kod', 'Ad', 'Birim', 'Vega stok', 'Rafta', 'Raf sayısı', 'Rafa kaldırılacak', 'Yerleşmemiş'], liste.map((u) => [u.code, u.name, u.unit, u.vegaStock, u.raf, u.rafSayisi, u.bekleyen, u.fark]));
  }));
  r.get('/urun/:id', sar((req) => depo.urunDetay(req.params.id)));
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
  r.get('/raf/:depo/:code', sar((req) => depo.rafDetay(Number(req.params.depo), req.params.code)));
  r.post('/raflar', sar((req) => {
    const kodlar = Array.isArray(req.body.kodlar) ? req.body.kodlar : [req.body.kod];
    return depo.raflarAc(req.body.depo, kodlar, { zone: req.body.zone || undefined, note: String(req.body.note || '') });
  }));
  r.put('/raf/:depo/:code', sar((req) => {
    const c = depo.rafKodu(req.params.code);
    const d = Number(req.params.depo);
    db.run('UPDATE shelf SET zone=COALESCE(?, zone), note=COALESCE(?, note) WHERE depo=? AND code=?', req.body.zone ?? null, req.body.note ?? null, d, c);
    depo.degisti();
    return { ok: true };
  }));
  r.delete('/raf/:depo/:code', sar((req) => {
    const c = depo.rafKodu(req.params.code);
    const d = Number(req.params.depo);
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
    const s = depo.rafBosalt(Number(req.params.depo), req.params.code, (req.body || {}).hedef);
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
    const satir = new Map(db.all('SELECT session_id, COUNT(*) AS n, COUNT(DISTINCT shelf) AS raf, SUM(CASE WHEN ABS(counted-server_before)>0.000001 THEN 1 ELSE 0 END) AS fark FROM count_line GROUP BY session_id').map((x) => [x.session_id, x]));
    return db.all('SELECT * FROM count_session ORDER BY created_at DESC LIMIT 500').map((s) => ({
      ...s,
      depoAd: depo.depoAdi(s.depo),
      vega_docs: s.vega_docs ? JSON.parse(s.vega_docs).docs : null,
      kalem: satir.get(s.id)?.n || 0,
      raf: satir.get(s.id)?.raf || 0,
      rafFarkli: satir.get(s.id)?.fark || 0,
    }));
  }));
  r.post('/sayimlar', sar((req) => {
    const b = req.body || {};
    const id = 'C' + crypto.randomBytes(5).toString('hex');
    const no = depo.sayimNo();
    db.run(
      'INSERT INTO count_session(id, no, title, blind, kind, status, source, note, created_at, depo) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,
      no,
      String(b.title || 'Sayım').trim().slice(0, 60) || 'Sayım',
      b.blind === false ? 0 : 1,
      b.kind === 'GENEL' ? 'GENEL' : 'RAF',
      'OPEN',
      'ADMIN',
      String(b.note || '').slice(0, 300),
      Date.now(),
      depo.depoCoz(b.depo),
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
  r.get('/kullanicilar', sar(() => db.all('SELECT username, name, active, created_at FROM app_user ORDER BY username')));
  r.post('/kullanicilar', sar((req) => {
    const b = req.body || {};
    const u = String(b.username || '').trim().toLowerCase();
    const pin = String(b.pin || '');
    if (!/^[a-z0-9._ğüşıöç-]{2,24}$/.test(u)) throw Object.assign(new Error('Kullanıcı adı 2-24 karakter: harf, rakam, nokta, tire'), { status: 400 });
    if (!/^\d{4,8}$/.test(pin)) throw Object.assign(new Error('Şifre 4-8 haneli rakam olmalı'), { status: 400 });
    if (db.get('SELECT 1 FROM app_user WHERE username=?', u)) throw Object.assign(new Error('Bu kullanıcı adı var'), { status: 400 });
    const salt = crypto.randomBytes(12).toString('hex');
    db.run('INSERT INTO app_user(username, name, salt, pin_hash, active, created_at) VALUES(?,?,?,?,1,?)', u, String(b.name || u).trim().slice(0, 40), salt, pinOzeti(salt, pin), Date.now());
    depo.degisti();
    return { ok: true };
  }));
  r.put('/kullanici/:u', sar((req) => {
    const b = req.body || {};
    const u = req.params.u;
    if (!db.get('SELECT 1 FROM app_user WHERE username=?', u)) throw Object.assign(new Error('Kullanıcı yok'), { status: 404 });
    if (b.pin) {
      if (!/^\d{4,8}$/.test(String(b.pin))) throw Object.assign(new Error('Şifre 4-8 haneli rakam olmalı'), { status: 400 });
      const salt = crypto.randomBytes(12).toString('hex');
      db.run('UPDATE app_user SET salt=?, pin_hash=? WHERE username=?', salt, pinOzeti(salt, String(b.pin)), u);
    }
    if (b.name !== undefined) db.run('UPDATE app_user SET name=? WHERE username=?', String(b.name).trim().slice(0, 40) || u, u);
    if (b.active !== undefined) db.run('UPDATE app_user SET active=? WHERE username=?', b.active ? 1 : 0, u);
    depo.degisti();
    return { ok: true };
  }));
  r.delete('/kullanici/:u', sar((req) => {
    db.run('DELETE FROM app_user WHERE username=?', req.params.u);
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
    const ip = String(req.query.ip || adresler()[0]?.ip || '127.0.0.1');
    const url = `http://${ip}:${config.load().port}`;
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
  r.get('/yedekler', sar(() =>
    fs.readdirSync(yedekKlasoru).filter((f) => f.endsWith('.db')).sort().reverse().slice(0, 60)
      .map((f) => ({ ad: f, boyut: fs.statSync(path.join(yedekKlasoru, f)).size, zaman: fs.statSync(path.join(yedekKlasoru, f)).mtimeMs }))));
  r.post('/klasor', sar(async (req) => {
    if (!yerelMi(req) || !masaustu.klasorAc) throw Object.assign(new Error('Yalnız sunucu bilgisayarında'), { status: 400 });
    const k = { yedek: yedekKlasoru, gunluk: log.klasor(), veri: path.dirname(db.file()) }[req.body?.ne];
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
  config.init(path.join(veriKlasoru, 'config.json'));
  db.open(path.join(veriKlasoru, 'depo.db'), { varsayilanDepo: config.load().vega.depo });
  yedekKlasoru = path.join(veriKlasoru, 'yedek');
  fs.mkdirSync(yedekKlasoru, { recursive: true });
  apk.kur(apkKlasoru || path.join(__dirname, '..', 'apk'));

  depo.goruntuYukleOnbellek();
  depo.vegaYenile().catch(() => {});
  depo.vegaZamanla();
  yedekZamanla();

  const p = port ?? config.load().port;
  const app = uygulama({ arayuz: arayuz || path.join(__dirname, '..', 'client', 'dist') });
  await new Promise((resolve, reject) => {
    sunucu = app.listen(p, host, resolve);
    sunucu.once('error', reject);
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
