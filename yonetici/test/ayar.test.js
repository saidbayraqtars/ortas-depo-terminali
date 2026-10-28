// Ayarlar kaydı (HTTP): depolar arası transfer bölümü boş ("otomatik") alanlarla kaydedilebilmeli.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-ayar-'));
const sunucu = require('../server/index');
const config = require('../server/config');

let port;
test.before(async () => {
  port = await sunucu.baslat({ veriKlasoru: dir, port: 0, host: '127.0.0.1', arayuz: dir });
});
test.after(async () => {
  await sunucu.durdur();
});

const kaydet = async (govde) => {
  const r = await fetch(`http://127.0.0.1:${port}/yonetim/api/ayarlar`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(govde) });
  return { durum: r.status, govde: await r.json() };
};

test('transfer ayarı: boş yoldaki depo ve USERNO (null, "" ya da 0) otomatik kalır, açılabilir', async () => {
  for (const bos of [null, '', 0]) {
    const r = await kaydet({ transfer: { aktif: true, yoldaDepo: bos, userno: bos, onek: 'A', gun: 45 } });
    assert.strictEqual(r.durum, 200, JSON.stringify(r.govde));
    const t = config.load().transfer;
    assert.deepStrictEqual([t.aktif, t.yoldaDepo, t.userno, t.onek, t.gun], [true, null, null, 'A', 45]);
  }
});

test('transfer ayarı: seçilen yoldaki depo ve USERNO kaydedilir; geçersiz değerler reddedilir', async () => {
  let r = await kaydet({ transfer: { aktif: true, yoldaDepo: 3, userno: 104, onek: 'a', gun: 30 } });
  assert.strictEqual(r.durum, 200);
  const t = config.load().transfer;
  assert.deepStrictEqual([t.yoldaDepo, t.userno, t.onek, t.gun], [3, 104, 'A', 30]);
  r = await kaydet({ transfer: { yoldaDepo: -2 } });
  assert.strictEqual(r.durum, 400);
  r = await kaydet({ transfer: { onek: '1' } });
  assert.strictEqual(r.durum, 400);
});
