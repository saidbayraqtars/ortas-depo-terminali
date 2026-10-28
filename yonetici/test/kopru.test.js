// Toybelen köprüsü + belge kilidi uç noktaları: gerçek Merkez sunucusu (Vega'sız) ve köprü aynı süreçte, HTTP üzerinden.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-kopru-'));
const merkez = require('../server/index');
const kopru = require('../server/kopru');
const db = require('../server/db');

let merkezPort;
let kopruPort;

/** Küçük HTTP istemcisi: gzip'i çözmeden de döndürebilir. */
function istek(port, yol, { method = 'GET', headers = {}, body, ham = false } = {}) {
  return new Promise((ok, no) => {
    const veri = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: yol, method, headers: { ...(veri ? { 'Content-Type': 'application/json', 'Content-Length': veri.length } : {}), ...headers } }, (res) => {
      const parcalar = [];
      res.on('data', (c) => parcalar.push(c));
      res.on('end', () => {
        let g = Buffer.concat(parcalar);
        if (!ham && res.headers['content-encoding'] === 'gzip') g = zlib.gunzipSync(g);
        const metin = g.toString('utf8');
        let json = null;
        try { json = JSON.parse(metin); } catch { /* json değil */ }
        ok({ status: res.statusCode, headers: res.headers, metin, json, govde: Buffer.concat(parcalar) });
      });
    });
    r.on('error', no);
    if (veri) r.write(veri);
    r.end();
  });
}

const cihaz = (ad) => ({ 'X-Device-Key': 'ABCD-1234-EFGH', 'X-Device-Name': ad });

test.before(async () => {
  merkezPort = await merkez.baslat({ veriKlasoru: path.join(dir, 'merkez'), port: 0, host: '127.0.0.1' });
  db.run("INSERT INTO device(name, key, active, created_at) VALUES('TRM-01', 'ABCD-1234-EFGH', 1, ?)", Date.now());
  kopruPort = await kopru.baslat({ veriKlasoru: path.join(dir, 'kopru'), port: 0, host: '127.0.0.1', hedef: `127.0.0.1:${merkezPort}` });
});

test.after(async () => {
  await kopru.durdur();
  await merkez.durdur();
});

test('köprü: /api isteklerini Merkez\'e iletir, cihaz anahtarı ve gövde aynen geçer, cevap kodu korunur', async () => {
  // Ping kimlik gerektirmez.
  let r = await istek(kopruPort, '/api/ping');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  // Cihaz anahtarı olmadan 401 (Merkez'in cevabı olduğu gibi).
  r = await istek(kopruPort, '/api/locks');
  assert.strictEqual(r.status, 401);
  // Anahtarla geçer; POST gövdesi iletilir.
  r = await istek(kopruPort, '/api/lock', { method: 'POST', headers: cihaz('TRM-01'), body: { docId: 'D20-1', kind: 'KABUL', docNo: 'A1', user: 'ali' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.ok(r.json.token);
  r = await istek(kopruPort, '/api/locks', { headers: cihaz('TRM-01') });
  assert.deepStrictEqual(r.json.locks.map((k) => [k.id, k.user, k.device]), [['D20-1', 'ali', 'TRM-01']]);
  // Vega yokken ana veri 503: durum kodu ve gövde korunur.
  r = await istek(kopruPort, '/api/master', { headers: cihaz('TRM-01') });
  assert.strictEqual(r.status, 503);
});

test('köprü: Merkez köprüyü tanır (Özet\'te bağlı), terminalin gerçek adresi son bağlantıda görünür', async () => {
  const d = (await istek(merkezPort, '/yonetim/api/durum')).json;
  assert.strictEqual(d.kopruler.length, 1);
  assert.strictEqual(d.kopruler[0].ad, 'Toybelen köprüsü');
  assert.strictEqual(d.kopruler[0].bagli, true);
  assert.ok(d.kopruler[0].adresler.every((a) => /^http:\/\/[\d.]+:\d+$/.test(a)));
  // X-Forwarded-For (köprü ekler): terminal bu adresten gelmiş gibi kaydedilir.
  await istek(kopruPort, '/api/locks', { headers: { ...cihaz('TRM-01'), 'X-Forwarded-For': '192.168.9.44' } });
  assert.strictEqual(db.get("SELECT last_ip FROM device WHERE name='TRM-01'").last_ip, '192.168.9.44');
  // Köprü olmadan doğrudan gelen istekte X-Forwarded-For yok sayılır (sahte adres yazılamaz).
  await istek(merkezPort, '/api/locks', { headers: { ...cihaz('TRM-01'), 'X-Forwarded-For': '1.2.3.4' } });
  assert.strictEqual(db.get("SELECT last_ip FROM device WHERE name='TRM-01'").last_ip, '127.0.0.1');
});

test('köprü: gzip cevap çözülmeden geçer, uzun yoklama beklenen sürede döner', async () => {
  for (let i = 0; i < 60; i++) {
    await istek(merkezPort, '/api/lock', { method: 'POST', headers: cihaz('TRM-01'), body: { docId: `D20-${100 + i}`, kind: 'KABUL', docNo: `Belge-${i}`, user: 'ali', device: `TRM-${i}` } });
  }
  const r = await istek(kopruPort, '/api/locks', { headers: { ...cihaz('TRM-01'), 'Accept-Encoding': 'gzip' }, ham: true });
  assert.strictEqual(r.headers['content-encoding'], 'gzip', 'köprü cevabı yeniden sıkıştırmadan ya da çözmeden geçirdi');
  const gz = JSON.parse(zlib.gunzipSync(r.govde).toString('utf8'));
  assert.ok(gz.locks.length >= 60);

  const surum = (await istek(kopruPort, '/api/changes?since=-5&wait=1', { headers: cihaz('TRM-01') })).json.surum;
  const bas = Date.now();
  const bekle = await istek(kopruPort, `/api/changes?since=${surum}&wait=1`, { headers: cihaz('TRM-01') });
  const sure = Date.now() - bas;
  assert.strictEqual(bekle.status, 200);
  assert.ok(sure >= 900 && sure < 4000, `uzun yoklama ~1 sn bekledi (${sure} ms)`);
});

test('köprü: yerel arayüz yalnız bu bilgisayardan, durum ve gecikme gösterir; Merkez adresi kaydedilir ve doğrulanır', async () => {
  await new Promise((r) => setTimeout(r, 200));
  let r = await istek(kopruPort, '/kopru/durum');
  assert.strictEqual(r.json.mod, 'kopru');
  assert.strictEqual(r.json.ulasilir, true);
  assert.ok(r.json.gecikmeMs >= 0 && r.json.gecikmeMs < 1000);
  assert.ok(r.json.terminalSayisi >= 1);
  r = await istek(kopruPort, '/');
  assert.match(r.metin, /Toybelen köprüsü/);
  // Geçersiz adres reddedilir.
  r = await istek(kopruPort, '/kopru/ayar', { method: 'PUT', body: { hedef: 'http://' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(kopru._hedefCoz('192.168.1.10:5480'), 'http://192.168.1.10:5480');
  assert.strictEqual(kopru._hedefCoz('https://merkez.ornek.com/yol?x=1'), 'https://merkez.ornek.com');
  assert.strictEqual(kopru._hedefCoz(''), null);
});

test('köprü: Merkez kapanınca terminale 502 döner, durum "ulaşılamıyor" olur; Merkez gelince yeniden çalışır', async () => {
  // Merkez adresini ulaşılamaz bir porta çevir (kapalı port), sonra geri al.
  const eski = `127.0.0.1:${merkezPort}`;
  let r = await istek(kopruPort, '/kopru/ayar', { method: 'PUT', body: { hedef: '127.0.0.1:1' } });
  assert.strictEqual(r.status, 200);
  r = await istek(kopruPort, '/api/locks', { headers: cihaz('TRM-01') });
  assert.strictEqual(r.status, 502);
  assert.match(r.json.error, /Merkez'e ulaşamıyor/);
  await new Promise((ok) => setTimeout(ok, 300));
  assert.strictEqual((await istek(kopruPort, '/kopru/durum')).json.ulasilir, false);

  r = await istek(kopruPort, '/kopru/ayar', { method: 'PUT', body: { hedef: eski } });
  assert.strictEqual(r.status, 200);
  await new Promise((ok) => setTimeout(ok, 300));
  assert.strictEqual((await istek(kopruPort, '/kopru/durum')).json.ulasilir, true);
  assert.strictEqual((await istek(kopruPort, '/api/locks', { headers: cihaz('TRM-01') })).status, 200);

  // Adres boş bırakılırsa terminale açık bir 503 mesajı gider.
  await istek(kopruPort, '/kopru/ayar', { method: 'PUT', body: { hedef: '' } });
  r = await istek(kopruPort, '/api/locks', { headers: cihaz('TRM-01') });
  assert.strictEqual(r.status, 503);
  assert.match(r.json.error, /Merkez adresi ayarlanmadı/);
  await istek(kopruPort, '/kopru/ayar', { method: 'PUT', body: { hedef: eski } });
});

test('Merkez kilit uçları: yönetici açınca tutan terminalin nabzı "yonetici" der, tümünü sıfırlama çalışır (HTTP)', async () => {
  const al = await istek(merkezPort, '/api/lock', { method: 'POST', headers: cihaz('TRM-01'), body: { docId: 'SEVK-7', kind: 'TRANSFER', docNo: 'A0000007', user: 'veli' } });
  assert.ok(al.json.ok);
  const liste = (await istek(merkezPort, '/yonetim/api/kilitler')).json;
  const k = liste.liste.find((x) => x.id === 'SEVK-7');
  assert.deepStrictEqual([k.tur, k.user, k.device, k.belgeNo], ['TRANSFER', 'veli', 'TRM-01', 'A0000007']);
  assert.strictEqual((await istek(merkezPort, '/yonetim/api/kilitler/ac', { method: 'POST', body: { belgeId: 'YOK' } })).status, 404);
  assert.strictEqual((await istek(merkezPort, '/yonetim/api/kilitler/ac', { method: 'POST', body: { belgeId: 'SEVK-7' } })).status, 200);
  const ping = await istek(merkezPort, '/api/lock/ping', { method: 'POST', headers: cihaz('TRM-01'), body: { docId: 'SEVK-7', token: al.json.token } });
  assert.deepStrictEqual([ping.json.ok, ping.json.neden], [false, 'yonetici']);
  const sifirla = (await istek(merkezPort, '/yonetim/api/kilitler/sifirla', { method: 'POST' })).json;
  assert.ok(sifirla.sifirlanan >= 60);
  assert.deepStrictEqual((await istek(merkezPort, '/api/locks', { headers: cihaz('TRM-01') })).json.locks, []);
  // Başkası kilitli belgeyi alamaz; sunucu holder mesajını verir.
  await istek(merkezPort, '/api/lock', { method: 'POST', headers: cihaz('TRM-01'), body: { docId: 'D20-9', user: 'ahmet', device: 'TRM-03' } });
  const ikinci = await istek(merkezPort, '/api/lock', { method: 'POST', headers: cihaz('TRM-01'), body: { docId: 'D20-9', user: 'veli', device: 'TRM-05' } });
  assert.deepStrictEqual([ikinci.json.ok, ikinci.json.holder.mesaj], [false, 'ahmet (TRM-03) kullanıyor']);
});
