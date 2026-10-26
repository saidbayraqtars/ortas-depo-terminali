// Hata toplayıcı: sahadaki uygulamaların çökme/donma raporlarını alır, diske JSON olarak yazar.
// nevaqr VPS'te 127.0.0.1:8796 dinler; nginx lisans.neva.technology/hata/ yolunu buraya verir.
// Bağımlılık yok (Node 22). Kurulum: KURULUM.md.
//
//   POST /hata/v1/rapor   başlık X-Rapor-Anahtari, gövde JSON { id, app, kind, ... }  → 200 { ok }
//   GET  /hata/v1/saglik  → 200 { ok }
//
// Raporlar: $STATE_DIRECTORY/<app>/<YYYY-MM-DD>/<HHMMSS>-<kind>-<id>.json
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8796);
const KLASOR = process.env.STATE_DIRECTORY || path.join(__dirname, 'veri');
const ANAHTAR = process.env.RAPOR_ANAHTARI || '';
const GOVDE_SINIRI = 1024 * 1024;
const KOTA = 500 * 1024 * 1024; // toplam rapor boyutu; dolunca yenisi reddedilir
const SAKLAMA_GUN = 120;

if (!ANAHTAR) {
  console.error('RAPOR_ANAHTARI tanımlı değil');
  process.exit(1);
}

fs.mkdirSync(KLASOR, { recursive: true });

// Aynı rapor iki yoldan gelebilir (terminal doğrudan + yönetici programı aracılığıyla); kimlikle tekilleşir.
const gorulen = new Set();
let toplam = 0;

function tara() {
  const sinir = Date.now() - SAKLAMA_GUN * 86400000;
  toplam = 0;
  for (const app of fs.readdirSync(KLASOR)) {
    const ad = path.join(KLASOR, app);
    if (!fs.statSync(ad).isDirectory()) continue;
    for (const gun of fs.readdirSync(ad)) {
      const gd = path.join(ad, gun);
      if (!fs.statSync(gd).isDirectory()) continue;
      for (const f of fs.readdirSync(gd)) {
        const p = path.join(gd, f);
        const st = fs.statSync(p);
        if (st.mtimeMs < sinir) {
          fs.unlinkSync(p);
          continue;
        }
        toplam += st.size;
        const m = f.match(/-([A-Za-z0-9_-]{8,64})\.json$/);
        if (m) gorulen.add(m[1]);
      }
      if (fs.readdirSync(gd).length === 0) fs.rmdirSync(gd);
    }
  }
}

tara();
setInterval(() => {
  try {
    tara();
  } catch (e) {
    console.error('tarama', e);
  }
}, 6 * 3600 * 1000).unref();

function yanit(res, kod, govde) {
  res.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(govde));
}

function esit(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function iki(n) {
  return String(n).padStart(2, '0');
}

function kaydet(r, ip) {
  const id = String(r.id || '');
  const app = String(r.app || '');
  const kind = String(r.kind || 'rapor').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'rapor';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw Object.assign(new Error('id geçersiz'), { kod: 400 });
  if (!/^[a-z0-9-]{2,40}$/.test(app)) throw Object.assign(new Error('app geçersiz'), { kod: 400 });
  if (gorulen.has(id)) return false;

  const an = new Date();
  const gun = `${an.getFullYear()}-${iki(an.getMonth() + 1)}-${iki(an.getDate())}`;
  const saat = `${iki(an.getHours())}${iki(an.getMinutes())}${iki(an.getSeconds())}`;
  const dir = path.join(KLASOR, app, gun);
  fs.mkdirSync(dir, { recursive: true });
  const metin = JSON.stringify({ ...r, alindi: an.toISOString(), ip }, null, 2);
  if (toplam + metin.length > KOTA) throw Object.assign(new Error('kota dolu'), { kod: 507 });
  fs.writeFileSync(path.join(dir, `${saat}-${kind}-${id}.json`), metin, 'utf8');
  toplam += metin.length;
  gorulen.add(id);
  console.log(`${app} ${kind} ${id} ${r.device || ''} ${r.appVersion || ''} ${ip}`);
  return true;
}

http
  .createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/hata/v1/saglik') return yanit(res, 200, { ok: true });
    if (req.method !== 'POST' || url !== '/hata/v1/rapor') return yanit(res, 404, { error: 'Bulunamadı' });
    if (!esit(req.headers['x-rapor-anahtari'] || '', ANAHTAR)) return yanit(res, 401, { error: 'Anahtar' });

    const parcalar = [];
    let boyut = 0;
    req.on('data', (c) => {
      boyut += c.length;
      if (boyut > GOVDE_SINIRI) {
        yanit(res, 413, { error: 'Çok büyük' });
        req.destroy();
      } else parcalar.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const govde = JSON.parse(Buffer.concat(parcalar).toString('utf8'));
        const liste = Array.isArray(govde) ? govde.slice(0, 50) : [govde];
        const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
        let yeni = 0;
        for (const r of liste) if (kaydet(r, ip)) yeni++;
        yanit(res, 200, { ok: true, yeni });
      } catch (e) {
        yanit(res, e.kod || 400, { error: e.message });
      }
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`hata-toplayici ${PORT} · ${KLASOR}`));
