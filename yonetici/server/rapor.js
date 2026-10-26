// Çökme ve hata raporları. Terminaller `/api/rapor` ile buraya yollar; program kendi hatalarını da ekler.
// Raporlar <veri>/raporlar/ altında durur ve nevaqr VPS'teki hata toplayıcıya iletilir (araclar/hata-toplayici):
// Said sahaya dokunamıyor, oradan okur. VPS'e ulaşılamazsa "gonderilecek/" klasöründe bekler, 10 dakikada bir denenir.
// Anahtar server/rapor.json'da ({ "anahtar": "..." }, depoya girmez); yoksa iletilmez, yalnız yerelde kalır.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const log = require('./log');

const ADRES = 'https://lisans.neva.technology/hata/v1/rapor';
const SAKLAMA_GUN = 60;

let klasor = null;
let bekleyen = null;
let anahtar = '';
let surum = '';
let zamanlayici = null;

function kur(veriKlasoru, uygulamaSurumu) {
  klasor = path.join(veriKlasoru, 'raporlar');
  bekleyen = path.join(klasor, 'gonderilecek');
  fs.mkdirSync(bekleyen, { recursive: true });
  surum = uygulamaSurumu;
  try {
    anahtar = String(JSON.parse(fs.readFileSync(path.join(__dirname, 'rapor.json'), 'utf8')).anahtar || '');
  } catch {
    anahtar = '';
  }
  try {
    const sinir = Date.now() - SAKLAMA_GUN * 86400000;
    for (const f of fs.readdirSync(klasor)) {
      const p = path.join(klasor, f);
      if (f.endsWith('.json') && fs.statSync(p).mtimeMs < sinir) fs.unlinkSync(p);
    }
  } catch {}
  log.dinle((mesaj, hata) => programHatasi(mesaj, hata));
  clearInterval(zamanlayici);
  zamanlayici = setInterval(() => ilet().catch(() => {}), 10 * 60 * 1000);
  zamanlayici.unref?.();
  setTimeout(() => ilet().catch(() => {}), 5000).unref?.();
}

function dosyaAdi(r) {
  const id = String(r.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const tur = String(r.kind || 'rapor').replace(/[^a-z0-9-]/gi, '').slice(0, 24);
  return `${Date.now()}-${tur}-${id}.json`;
}

function kaydet(r) {
  if (!klasor) return;
  fs.writeFileSync(path.join(bekleyen, dosyaAdi(r)), JSON.stringify(r), 'utf8');
  ilet().catch(() => {});
}

/** Terminalden gelen rapor. */
function terminalden(r, cihaz) {
  if (!r || typeof r !== 'object' || !/^[A-Za-z0-9_-]{8,64}$/.test(String(r.id || ''))) {
    throw Object.assign(new Error('Rapor geçersiz'), { status: 400 });
  }
  r.yoneticiCihaz = cihaz.name;
  r.yoneticiSurum = surum;
  log.uyari(`Terminal raporu · ${cihaz.name} · ${r.kind} · ${String(r.summary || '').split('\n')[0].slice(0, 200)}`);
  kaydet(r);
}

// Programın kendi hataları (günlükteki HATA satırları): aynı mesaj saatte bir, günde en çok 30.
const sonGonderim = new Map();
let gunluk = { gun: '', adet: 0 };

function programHatasi(mesaj, hata) {
  try {
    const an = Date.now();
    const gun = new Date().toDateString();
    if (gunluk.gun !== gun) gunluk = { gun, adet: 0 };
    const k = mesaj + (hata?.message || '');
    if (gunluk.adet >= 30 || an - (sonGonderim.get(k) || 0) < 3600000) return;
    sonGonderim.set(k, an);
    gunluk.adet++;
    kaydet({
      id: crypto.randomUUID().replace(/-/g, ''),
      app: 'ortas-yonetici',
      kind: 'error',
      time: new Date().toISOString(),
      summary: `${mesaj}${hata ? ` — ${hata.message || hata}` : ''}`,
      stack: hata?.stack || null,
      appVersion: surum,
      device: os.hostname(),
      os: `${os.type()} ${os.release()}`,
    });
  } catch {}
}

let iletiliyor = false;

async function ilet() {
  if (!anahtar || !bekleyen || iletiliyor) return;
  iletiliyor = true;
  try {
    for (const f of fs.readdirSync(bekleyen).filter((x) => x.endsWith('.json')).sort().slice(0, 50)) {
      const p = path.join(bekleyen, f);
      const govde = fs.readFileSync(p, 'utf8');
      const r = await fetch(ADRES, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Rapor-Anahtari': anahtar },
        body: govde,
        signal: AbortSignal.timeout(15000),
      });
      // 4xx (bozuk rapor, kota) yeniden denenmez; arşive alınır.
      if (!r.ok && r.status >= 500) break;
      fs.renameSync(p, path.join(klasor, f));
    }
  } finally {
    iletiliyor = false;
  }
}

module.exports = { kur, terminalden, ilet };
