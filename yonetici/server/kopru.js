// Toybelen köprüsü: Merkez'e ulaşan bir bilgisayarda (FortiClient VPN'li) çalışan ters vekil.
// Toybelen terminalleri bu bilgisayarın yerel ağ adresine bağlanır (varsayılan :5480); köprü /api/*, /apk ve /kur isteklerini
// Merkez PC'nin VPN adresine iletir. Veritabanı ve Vega yoktur: tek gerçek sunucu Merkez'dir.
//   - Uzun yoklama (/api/changes, 25 sn) ve gzip aynen geçer: istek ve cevap gövdeleri çözülmeden akıtılır.
//   - Bağlantı koparsa köprü 502 döner; terminal bunu "sunucuya ulaşılamıyor" sayar, bugünkü gibi çevrimdışı çalışıp işlemleri
//     kuyruğa yazar, bağlantı gelince gönderir.
//   - Merkez köprüyü X-Kopru başlığından tanır (Özet'te "Toybelen köprüsü: bağlı / son görülme", cihaz QR'ında adres seçimi).
//   - Köprü arayüzü (http://127.0.0.1:port/) yalnız bu bilgisayardan: Merkez adresi, "Merkez'e ulaşılıyor mu, gecikme kaç ms".
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const log = require('./log');

const SURUM = require('../package.json').version;
const ATLANAN = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
const YOKLAMA_MS = 10000;

let dosya = null;
let ayar = { hedef: '', ad: 'Toybelen köprüsü' };
let sunucu = null;
let yoklayici = null;
const durum = {
  ulasilir: null, gecikmeMs: null, sonKontrol: 0, sonBasari: 0, hata: '', istek: 0, hataliIstek: 0, basladi: Date.now(),
};
const terminaller = new Map(); // cihaz adı → son istek zamanı

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

function ayarYukle() {
  try {
    const j = JSON.parse(fs.readFileSync(dosya, 'utf8'));
    ayar = { ...ayar, hedef: typeof j.hedef === 'string' ? j.hedef : '', ad: String(j.ad || ayar.ad).slice(0, 40) };
  } catch {
    /* ilk açılış */
  }
}

/** Hedef adresi: http(s)://ana-makine[:port]; yol, sorgu ve parça atılır. Geçersizse null. */
function hedefCoz(metin) {
  let s = String(metin || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function ayarKaydet(yeni) {
  const hedef = yeni.hedef === '' ? '' : hedefCoz(yeni.hedef);
  if (hedef === null) throw Object.assign(new Error('Merkez adresi geçersiz. Örnek: 192.168.1.10:5480'), { status: 400 });
  ayar = { ...ayar, hedef, ad: yeni.ad ? String(yeni.ad).trim().slice(0, 40) : ayar.ad };
  fs.mkdirSync(path.dirname(dosya), { recursive: true });
  fs.writeFileSync(dosya, JSON.stringify(ayar, null, 2), 'utf8');
  Object.assign(durum, { ulasilir: null, gecikmeMs: null, hata: '' });
  log.bilgi(`Köprü ayarı: Merkez ${ayar.hedef || '(yok)'}`);
  yokla().catch(() => {});
}

function istemci(hedef) {
  return hedef.startsWith('https:') ? https : http;
}

const ajanlar = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }) };

function baslikHazirla(req, u) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) if (!ATLANAN.has(k)) h[k] = v;
  h.host = u.host;
  // Terminalin gerçek adresi Merkez'de "son bağlantı"da görünsün; köprü kimliği ve adresleri Merkez'in köprüyü tanıması için.
  const onceki = req.headers['x-forwarded-for'];
  const ip = String(req.socket.remoteAddress || '').replace('::ffff:', '');
  h['x-forwarded-for'] = onceki ? `${onceki}, ${ip}` : ip;
  h['x-kopru'] = ayar.ad;
  h['x-kopru-adresler'] = adresler().map((a) => `http://${a.ip}:${sunucu?.address()?.port || ''}`).join(',');
  return h;
}

/** İsteği hedefe akıtır; cevabı çözmeden (gzip dahil) olduğu gibi geri akıtır. */
function vekil(req, res) {
  const hedef = hedefCoz(ayar.hedef);
  if (!hedef) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify({ error: 'Köprü: Merkez adresi ayarlanmadı (köprü bilgisayarında programı açıp Merkez adresini girin)' }));
  }
  const u = new URL(hedef);
  const cihaz = String(req.headers['x-device-name'] || '').trim();
  if (cihaz) terminaller.set(cihaz, Date.now());
  durum.istek++;
  const up = istemci(hedef).request(
    { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), method: req.method, path: req.url, headers: baslikHazirla(req, u), agent: ajanlar[u.protocol] },
    (r) => {
      const h = {};
      for (const [k, v] of Object.entries(r.headers)) if (!ATLANAN.has(k)) h[k] = v;
      durum.sonBasari = Date.now();
      res.writeHead(r.statusCode || 502, h);
      r.pipe(res);
      r.on('error', () => res.destroy());
    },
  );
  // Uzun yoklama en çok 25-30 sn bekler; bunun çok üstü ölü bağlantıdır.
  up.setTimeout(70000, () => up.destroy(new Error('Merkez zamanında cevap vermedi')));
  up.on('error', (e) => {
    durum.hataliIstek++;
    durum.hata = e.code === 'ECONNREFUSED' ? 'Merkez bağlantıyı reddetti (program kapalı ya da port kapalı)' : e.message;
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `Köprü Merkez'e ulaşamıyor: ${durum.hata}` }));
    } else res.destroy();
  });
  // Terminal bırakırsa Merkez'e açık kalan uzun yoklama da kapansın.
  res.on('close', () => {
    if (!res.writableEnded) up.destroy();
  });
  req.pipe(up);
}

/** Merkez'e ulaşılıyor mu, gecikme kaç ms: /api/ping (kimlik gerekmez). Merkez bu çağrıdan köprüyü tanır. */
async function yokla() {
  const hedef = hedefCoz(ayar.hedef);
  if (!hedef) {
    Object.assign(durum, { ulasilir: false, gecikmeMs: null, hata: 'Merkez adresi ayarlanmadı', sonKontrol: Date.now() });
    return;
  }
  const u = new URL(hedef);
  const bas = process.hrtime.bigint();
  await new Promise((ok) => {
    const r = istemci(hedef).request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: '/api/ping', method: 'GET', timeout: 6000, agent: ajanlar[u.protocol],
        headers: { host: u.host, 'x-kopru': ayar.ad, 'x-kopru-adresler': adresler().map((a) => `http://${a.ip}:${sunucu?.address()?.port || ''}`).join(','), 'x-kopru-surum': SURUM } },
      (cevap) => {
        cevap.resume();
        cevap.on('end', () => {
          const ms = Number(process.hrtime.bigint() - bas) / 1e6;
          Object.assign(durum, { sonKontrol: Date.now() });
          if (cevap.statusCode === 200) Object.assign(durum, { ulasilir: true, gecikmeMs: Math.round(ms), sonBasari: Date.now(), hata: '' });
          else Object.assign(durum, { ulasilir: false, gecikmeMs: null, hata: `Merkez ${cevap.statusCode} döndü (yönetici programı değil ya da eski sürüm)` });
          ok();
        });
      },
    );
    r.on('timeout', () => r.destroy(new Error('zaman aşımı (6 sn)')));
    r.on('error', (e) => {
      Object.assign(durum, { ulasilir: false, gecikmeMs: null, sonKontrol: Date.now(), hata: e.code === 'ECONNREFUSED' ? 'Merkez bağlantıyı reddetti (program kapalı ya da güvenlik duvarı)' : e.message });
      ok();
    });
    r.end();
  });
}

function durumVer() {
  const sinir = Date.now() - 3 * 60 * 1000;
  return {
    mod: 'kopru',
    surum: SURUM,
    ad: ayar.ad,
    hedef: ayar.hedef,
    port: sunucu?.address()?.port || null,
    adresler: adresler(),
    ...durum,
    terminalSayisi: [...terminaller.values()].filter((t) => t > sinir).length,
    terminaller: [...terminaller.entries()].filter(([, t]) => t > sinir).map(([ad, t]) => ({ ad, son: t })),
  };
}

const ARAYUZ = `<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Toybelen köprüsü</title>
<style>
:root{--zemin:#eef0ec;--kart:#fff;--yazi:#1b2430;--soluk:#667;--cizgi:#d9dcd6;--ok:#1f7a3d;--hata:#b3261e;--vurgu:#f2b705}
@media (prefers-color-scheme:dark){:root{--zemin:#161a1f;--kart:#20262d;--yazi:#e8ebee;--soluk:#97a1ab;--cizgi:#323a43;--ok:#5fcf84;--hata:#ff8a80}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,Segoe UI,sans-serif;background:var(--zemin);color:var(--yazi);padding:24px}
main{max-width:720px;margin:0 auto;display:grid;gap:14px}h1{margin:0;font-size:22px}p{margin:0}
.kart{background:var(--kart);border:1px solid var(--cizgi);border-radius:12px;padding:16px;display:grid;gap:10px}
.durum{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600}
.nokta{width:12px;height:12px;border-radius:50%;background:var(--soluk)}.nokta.ok{background:var(--ok)}.nokta.hata{background:var(--hata)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dt{color:var(--soluk)}dd{margin:0;word-break:break-all}
label{display:grid;gap:4px;font-weight:600}input{font:inherit;padding:10px 12px;border:1px solid var(--cizgi);border-radius:8px;background:var(--zemin);color:var(--yazi)}
button{font:inherit;font-weight:600;padding:10px 16px;border-radius:8px;border:0;background:var(--vurgu);color:#1b2430;cursor:pointer;justify-self:start}
.soluk{color:var(--soluk);font-size:13px}.hata{color:var(--hata)}.mono{font-family:ui-monospace,Consolas,monospace}
</style>
<main>
<h1>Toybelen köprüsü</h1>
<div class="kart"><div class="durum"><span class="nokta" id="nokta"></span><span id="baslik">Kontrol ediliyor…</span></div>
<p class="soluk" id="altmetin"></p>
<dl id="ayrinti"></dl></div>
<form class="kart" id="form"><label>Merkez adresi (VPN üzerinden)<input id="hedef" class="mono" placeholder="192.168.1.10:5480" autocomplete="off"></label>
<p class="soluk">Merkez bilgisayarının yerel ağ adresi ve portu. FortiClient VPN bağlıyken bu bilgisayardan erişilebilmeli.</p>
<button type="submit">Kaydet ve sına</button><p class="hata" id="formhata"></p></form>
<div class="kart"><b>Toybelen terminalleri bu adrese bağlanır</b><div id="adresler" class="mono"></div>
<p class="soluk">Cihazlar sayfasındaki kurulum QR'ında "Toybelen köprüsü" adresini seçin. Bu bilgisayar açık ve VPN bağlı değilse terminaller çevrimdışı çalışır, işlemleri sonra gönderir.</p></div>
</main>
<script>
const $=(i)=>document.getElementById(i);
function once(t){if(!t)return 'hiç';const s=Math.round((Date.now()-t)/1000);return s<5?'az önce':s<60?s+' sn önce':s<3600?Math.floor(s/60)+' dk önce':new Date(t).toLocaleString('tr-TR')}
async function yenile(){
  try{
    const d=await (await fetch('/kopru/durum',{cache:'no-store'})).json();
    const ok=d.ulasilir===true;
    $('nokta').className='nokta '+(d.ulasilir===null?'':ok?'ok':'hata');
    $('baslik').textContent=d.ulasilir===null?'Kontrol ediliyor…':ok?"Merkez'e ulaşılıyor · "+d.gecikmeMs+' ms':"Merkez'e ulaşılamıyor";
    $('altmetin').textContent=ok?'Terminal istekleri Merkez\\'e iletiliyor.':(d.hata||'');
    $('ayrinti').innerHTML='<dt>Merkez</dt><dd class="mono">'+(d.hedef||'—')+'</dd><dt>Son başarılı iletişim</dt><dd>'+once(d.sonBasari)+'</dd><dt>Bağlı terminal</dt><dd>'+d.terminalSayisi+(d.terminaller.length?' ('+d.terminaller.map(t=>t.ad).join(', ')+')':'')+'</dd><dt>İletilen istek</dt><dd>'+d.istek+(d.hataliIstek?' · '+d.hataliIstek+' hatalı':'')+'</dd><dt>Sürüm</dt><dd>'+d.surum+'</dd>';
    $('adresler').innerHTML=d.adresler.map(a=>'http://'+a.ip+':'+d.port+' <span class="soluk">('+a.ad+')</span>').join('<br>')||'Ağ bağlantısı yok';
    if(!$('hedef').dataset.dolu){$('hedef').value=d.hedef.replace(/^https?:\\/\\//,'');$('hedef').dataset.dolu='1'}
  }catch(e){$('baslik').textContent='Köprü yanıt vermiyor'}
}
$('form').addEventListener('submit',async(e)=>{e.preventDefault();$('formhata').textContent='';
  const r=await fetch('/kopru/ayar',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({hedef:$('hedef').value})});
  if(!r.ok){$('formhata').textContent=(await r.json()).error||'Kaydedilemedi'}else{setTimeout(yenile,1500)}yenile()});
yenile();setInterval(yenile,3000);
</script></html>`;

function yerel(req, res, devam) {
  if (!yerelMi(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    return void res.end(JSON.stringify({ error: 'Köprü ayarı yalnız bu bilgisayardan' }));
  }
  devam();
}

function istek(req, res) {
  const yol = req.url.split('?')[0];
  if (yol === '/api' || yol.startsWith('/api/') || yol === '/apk' || yol === '/kur') return vekil(req, res);
  if (yol === '/' || yol === '/kopru') {
    return yerel(req, res, () => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(ARAYUZ);
    });
  }
  if (yol === '/kopru/durum') {
    return yerel(req, res, () => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(durumVer()));
    });
  }
  if (yol === '/kopru/ayar' && req.method === 'PUT') {
    return yerel(req, res, () => {
      let govde = '';
      req.on('data', (c) => { govde += c; if (govde.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          ayarKaydet(JSON.parse(govde || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Bulunamadı' }));
}

/** Köprüyü başlatır. `veriKlasoru`: kopru.json burada. `hedef` verilirse ayarı ezer (deneme). Dönen: dinlenen port. */
async function baslat({ veriKlasoru, port = 5480, host = '0.0.0.0', hedef } = {}) {
  fs.mkdirSync(veriKlasoru, { recursive: true });
  log.kur(path.join(veriKlasoru, 'gunluk'));
  dosya = path.join(veriKlasoru, 'kopru.json');
  ayarYukle();
  if (hedef) ayar.hedef = hedefCoz(hedef) || '';
  sunucu = http.createServer(istek);
  // Uzun yoklamalar açık kalır; Node'un varsayılan 5 dk istek zaman aşımı ve 5 sn keep-alive süresi uygun, üst sınır yok.
  sunucu.requestTimeout = 0;
  sunucu.keepAliveTimeout = 65000;
  await new Promise((resolve, reject) => {
    sunucu.once('error', reject);
    sunucu.listen(port, host, () => resolve());
  });
  const gercek = sunucu.address().port;
  log.bilgi(`Köprü ${SURUM} dinliyor: ${host}:${gercek} → ${ayar.hedef || '(Merkez adresi yok)'}`);
  yokla().catch(() => {});
  yoklayici = setInterval(() => yokla().catch(() => {}), YOKLAMA_MS);
  yoklayici.unref?.();
  return gercek;
}

async function durdur() {
  clearInterval(yoklayici);
  if (sunucu) {
    sunucu.closeAllConnections?.();
    await new Promise((r) => sunucu.close(() => r()));
  }
}

module.exports = { baslat, durdur, adresler, durum: durumVer, _hedefCoz: hedefCoz };

if (require.main === module) {
  // Geliştirme: node server/kopru.js --hedef 127.0.0.1:5490 --port 5481 [--veri klasör]
  const a = process.argv.slice(2);
  const al = (ad, vars) => { const i = a.indexOf(`--${ad}`); return i >= 0 ? a[i + 1] : vars; };
  baslat({ veriKlasoru: al('veri', path.join(__dirname, '..', 'veri-kopru')), port: Number(al('port', 5481)), hedef: al('hedef') })
    .then((p) => console.log(`Köprü ${p} portunda`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
