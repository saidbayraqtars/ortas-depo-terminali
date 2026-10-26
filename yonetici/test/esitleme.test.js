// Terminal eşitlemesi, gerçek HTTP üzerinden: v2 stok parçaları ve değişiklik bekleme ucu (/api/changes).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-esitleme-'));
const sunucu = require('../server/index');
const db = require('../server/db');
const depo = require('../server/depo');

let port;
const KEY = 'TEST-KEY-0001';
const baslik = { 'X-Device-Key': KEY, 'X-Device-Name': 'TRM-T', 'Content-Type': 'application/json' };
const cevap = async (yol, govde) => {
  const r = await fetch(`http://127.0.0.1:${port}${yol}`, govde ? { method: 'POST', headers: baslik, body: JSON.stringify(govde) } : { headers: baslik });
  assert.strictEqual(r.status, 200);
  return r.json();
};
const urunler = Array.from({ length: 300 }, (_, i) => ({ id: String(1000 + i), code: `K-${i}`, name: `Ürün ${i}`, unit: 'Adet' }));
const goruntu = (stok) => ({
  surum: 2, at: Date.now(), depolar: [{ ind: 1, ad: 'MERKEZ' }], products: urunler, rafAlan: null,
  stock: { 1: stok }, moved: [], barcodes: { 1000: ['869000'] }, receipts: [],
});
const stok0 = Object.fromEntries(urunler.filter((_, i) => i % 3 === 0).map((u) => [u.id, 5]));

test.before(async () => {
  port = await sunucu.baslat({ veriKlasoru: dir, port: 0, host: '127.0.0.1', arayuz: dir });
  db.run('INSERT INTO device(name, key, active, created_at) VALUES(?,?,1,?)', 'TRM-T', KEY, Date.now());
  depo._goruntuKur(goruntu(stok0));
  depo.rafEkle(1, 'A-01-01');
  depo.rafEkle(1, 'A-01-02');
  depo.degisti();
});
test.after(async () => {
  await sunucu.durdur();
});

async function hepsiniAl(v, bilinen = {}, en = 8) {
  const parcalar = [];
  let son;
  for (let i = 0; i < 40; i++) {
    const c = await cevap('/api/master/parts', { known: bilinen, max: en, v });
    son = c;
    for (const p of c.parts) {
      bilinen[p.key] = p.hash;
      parcalar.push(p);
    }
    if (c.remaining === 0) break;
  }
  return { parcalar, bilinen, son };
}

test('v2: kovada stok yok, stok q parçalarında; birleştirince tam listeyle aynı; v1 eskisi gibi kovada stokla gelir', async () => {
  const tam = JSON.parse(depo.master().json);
  const { parcalar, son } = await hepsiniAl(2);
  assert.strictEqual(son.surum, depo.surum());
  const kovaUrun = parcalar.filter((p) => p.key[0] === 'b').flatMap((p) => p.data.products);
  assert.strictEqual(kovaUrun.length, tam.products.length); // yalnız stoklu/hareketli/rafta olan kartlar gider
  assert.ok(kovaUrun.length >= 100);
  assert.ok(kovaUrun.every((u) => !('vegaStock' in u) && !('stocks' in u)));
  const stok = new Map(parcalar.filter((p) => p.key[0] === 'q').flatMap((p) => p.data.items).map((x) => [x.id, x]));
  for (const u of tam.products) {
    const x = stok.get(u.id);
    assert.strictEqual(x ? x.vs : 0, u.vegaStock, u.id);
    assert.deepStrictEqual(x ? x.st : {}, u.stocks, u.id);
  }
  // v1: kovada stok var, q parçası yok.
  const v1 = await hepsiniAl(1);
  assert.ok(v1.parcalar.every((p) => p.key[0] !== 'q'));
  const v1Urun = v1.parcalar.filter((p) => p.key[0] === 'b').flatMap((p) => p.data.products);
  assert.ok(v1Urun.some((u) => u.vegaStock === 5 && u.stocks[1] === 5));
});

test('v2: yalnız Vega stoku değişince sadece stok parçası iner; kova inmez', async () => {
  const { bilinen } = await hepsiniAl(2);
  assert.deepStrictEqual((await cevap('/api/master/parts', { known: bilinen, max: 8, v: 2 })).parts, []);
  // Satış: stoklu kartların yarısında stok düştü (kovalara dağılır; kartlar aynı kalır).
  const yeni = { ...stok0 };
  for (const id of Object.keys(stok0).slice(0, 50)) yeni[id] = 4;
  depo._goruntuKur(goruntu(yeni));
  depo.degisti();
  const c = await cevap('/api/master/parts', { known: bilinen, max: 8, v: 2 });
  assert.ok(c.parts.length > 0);
  assert.ok(c.parts.every((p) => p.key[0] === 'q'), c.parts.map((p) => p.key).join());
  assert.strictEqual(c.remaining, 0);
  // v1 terminal aynı değişiklikte kovaları baştan alırdı.
  const v1 = await hepsiniAl(1);
  const eski = await cevap('/api/master/parts', { known: v1.bilinen, max: 8, v: 1 });
  assert.deepStrictEqual(eski.parts, []);
});

test('v2: kova değişince stok parçası da gelir (terminal kovayı yazarken stokunu siler); eski kovası olan terminale stok gitmez', async () => {
  const { bilinen } = await hepsiniAl(2);
  const k = 'b' + depo.kova('1001');
  depo.islemler('TRM-T', 'ali', [{ id: 'esl-2', type: 'PUTAWAY', createdAt: Date.now(), payload: { productId: '1001', shelf: 'A-01-01', qty: 3, depot: 1 } }]);
  const c = await cevap('/api/master/parts', { known: bilinen, max: 8, v: 2 });
  const anahtarlar = c.parts.map((p) => p.key);
  assert.ok(anahtarlar.includes(k), anahtarlar.join());
  assert.ok(anahtarlar.includes('q' + k.slice(1)), 'kova gelince stok parçası da gelmeli');
  // Terminal bu kovayı hiç bilmiyorsa (eski hash yok) stok parçası, kovayla birlikte aynı cevapta ya da hiç gelmez.
  const bos = { ...bilinen };
  delete bos[k];
  const c2 = await cevap('/api/master/parts', { known: bos, max: 8, v: 2 });
  assert.ok(c2.parts.some((p) => p.key === k) && c2.parts.some((p) => p.key === 'q' + k.slice(1)));
  // En çok 1 kova istenirse: kovası gelmeyen terminal için stok parçası gönderilmez.
  const hic = await cevap('/api/master/parts', { known: {}, max: 1, v: 2 });
  const b = hic.parts.filter((p) => p.key[0] === 'b').map((p) => p.key[0] + p.key.slice(1));
  const q = hic.parts.filter((p) => p.key[0] === 'q').map((p) => p.key.slice(1));
  assert.deepStrictEqual(q, b.map((x) => x.slice(1)));
  assert.strictEqual(hic.remaining, 63);
});

test('/api/changes: sayaç farklıysa hemen döner; aynıysa değişiklik olunca ya da süre dolunca döner', async () => {
  const s = depo.surum();
  let t = Date.now();
  assert.strictEqual((await cevap(`/api/changes?since=${s - 1}`)).surum, s);
  assert.ok(Date.now() - t < 500);
  // Bekleyen istek, başka biri bir şey değiştirince açılır.
  t = Date.now();
  const bekleyen = cevap(`/api/changes?since=${s}&wait=20`);
  setTimeout(() => depo.degisti(), 300);
  assert.strictEqual((await bekleyen).surum, s + 1);
  const gecen = Date.now() - t;
  assert.ok(gecen >= 250 && gecen < 3000, `bekleme ${gecen} ms`);
  // Değişiklik yoksa süre dolunca aynı sayaçla döner.
  t = Date.now();
  assert.strictEqual((await cevap(`/api/changes?since=${depo.surum()}&wait=1`)).surum, depo.surum());
  assert.ok(Date.now() - t >= 900);
  // Yetkisiz cihaz bekletilmez.
  const r = await fetch(`http://127.0.0.1:${port}/api/changes?since=1`, { headers: { 'X-Device-Key': 'YOK' } });
  assert.strictEqual(r.status, 401);
});
