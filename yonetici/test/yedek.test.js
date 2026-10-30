// Program verisinin yedeği: varsayılan klasör, en çok 5 yedek, başka dosyaya dokunmama, klasör yazılamazsa yedeğin kaybolmaması.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-yedek-'));
// Klasör adında Türkçe harf: varsayılan C:/ortaşdepo-yedekler ile aynı durum (VACUUM INTO yolu).
const klasor = path.join(dir, 'ortaşdepo-yedekler');
const config = require('../server/config');
const db = require('../server/db');
const sunucu = require('../server/index');

let port;
const istek = async (yol, secenek = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/yonetim/api${yol}`, { headers: { 'Content-Type': 'application/json' }, ...secenek });
  return { status: r.status, govde: await r.json() };
};
const dosyalar = () => fs.readdirSync(klasor).sort();
const eskiYedek = (i) => {
  const ad = `depo-2026100${i}-0300-otomatik.db`;
  const yol = path.join(klasor, ad);
  fs.writeFileSync(yol, 'eski');
  const t = new Date(2026, 9, i, 3, 0, 0);
  fs.utimesSync(yol, t, t);
  return ad;
};

test.before(async () => {
  port = await sunucu.baslat({ veriKlasoru: dir, port: 0, host: '127.0.0.1', arayuz: dir });
  config.update({ yedek: { klasor } });
});

test('varsayılan: C:/ortaşdepo-yedekler, en çok 5 yedek', () => {
  assert.deepStrictEqual({ ...config.DEFAULTS.yedek }, { klasor: 'C:/ortaşdepo-yedekler', adet: 5 });
});

test('yedek açılabilir bir veritabanı olarak Türkçe adlı klasöre yazılır', () => {
  const ad = sunucu.yedekAl('elle');
  const { DatabaseSync } = require('node:sqlite');
  const v = new DatabaseSync(path.join(klasor, ad), { readOnly: true });
  assert.ok(v.prepare("SELECT value FROM meta WHERE key='surum'").get().value);
  v.close();
  assert.ok(Number(db.meta('sonYedek', 0)) > 0);
  fs.unlinkSync(path.join(klasor, ad));
});

test('5\'ten fazlası en eskiden silinir; elle ve otomatik ayrımı yok; başka dosyaya dokunulmaz', () => {
  const eskiler = [1, 2, 3, 4, 5, 6, 7].map(eskiYedek);
  fs.writeFileSync(path.join(klasor, 'notlar.txt'), 'silinmesin');
  fs.writeFileSync(path.join(klasor, 'baska.db'), 'silinmesin');
  const yeni = sunucu.yedekAl('elle');
  const kalan = dosyalar();
  assert.ok(kalan.includes(yeni));
  assert.ok(kalan.includes('notlar.txt'));
  assert.ok(kalan.includes('baska.db'));
  assert.strictEqual(kalan.filter((f) => /^depo-/.test(f)).length, 5);
  // Yeni yedek + en yeni 4 eski kalır.
  for (const a of eskiler.slice(0, 3)) assert.ok(!kalan.includes(a), `${a} silinmeliydi`);
  for (const a of eskiler.slice(3)) assert.ok(kalan.includes(a), `${a} kalmalıydı`);
});

test('yedek alınamazsa eskiler silinmez', () => {
  const once = dosyalar();
  const asil = db.backup;
  db.backup = () => { throw new Error('disk dolu'); };
  try {
    assert.throws(() => sunucu.yedekAl('elle'), /disk dolu/);
  } finally {
    db.backup = asil;
  }
  assert.deepStrictEqual(dosyalar(), once);
});

test('klasör kullanılamazsa yedek veri klasörüne alınır, kaybolmaz', () => {
  const dosya = path.join(dir, 'klasor-degil');
  fs.writeFileSync(dosya, 'x');
  config.update({ yedek: { klasor: path.join(dosya, 'alt') } });
  const ad = sunucu.yedekAl('elle');
  assert.ok(fs.existsSync(path.join(dir, 'yedek', ad)));
  config.update({ yedek: { klasor } });
});

test('ayar: klasör ve adet API\'den değişir, geçersiz değer reddedilir, yeni sınır uygulanır', async () => {
  assert.strictEqual((await istek('/ayarlar', { method: 'PUT', body: JSON.stringify({ yedek: { klasor: 'goreli/yol' } }) })).status, 400);
  assert.strictEqual((await istek('/ayarlar', { method: 'PUT', body: JSON.stringify({ yedek: { adet: 0 } }) })).status, 400);
  const r = await istek('/ayarlar', { method: 'PUT', body: JSON.stringify({ yedek: { klasor, adet: 2 } }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.govde.yedek.adet, 2);
  await istek('/yedek', { method: 'POST', body: '{}' });
  const liste = (await istek('/yedekler')).govde;
  assert.strictEqual(liste.length, 2);
  assert.ok(liste[0].zaman >= liste[1].zaman);
  assert.strictEqual((await istek('/ayarlar')).govde.dosyalar.yedek, klasor);
});

test.after(async () => {
  await sunucu.durdur();
  fs.rmSync(dir, { recursive: true, force: true });
});
