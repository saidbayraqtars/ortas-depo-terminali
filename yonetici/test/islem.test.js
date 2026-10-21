// Terminal işlemlerinin sunucudaki etkisi (Vega'sız; Vega görüntüsü elle verilir).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-test-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
config.init(path.join(dir, 'config.json'));
db.open(path.join(dir, 'depo.db'));

depo._goruntuKur({
  at: Date.now(),
  depoAd: 'MERKEZ',
  products: [
    { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
    { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
    { id: '103', code: 'AN-0040', name: 'Antifriz 4 L', unit: 'Adet' },
  ],
  stock: { 101: 24, 102: 10, 103: 5 },
  moved: [],
  barcodes: { 101: ['8691234500412'] },
  receipts: [
    { id: '26-9', izahat: '26', tur: 'Alış irsaliyesi', docNo: 'IRS-9', supplier: 'Tedarikçi', date: '21.10.2026', ts: 1, lines: [
      { id: '26-9-101', productId: '101', accepted: 24 },
      { id: '26-9-102', productId: '102', accepted: 10 },
    ] },
  ],
});
for (const r of ['A-01-01', 'A-01-02', 'B-01-01']) depo.rafEkle(r);

let n = 0;
const op = (type, payload, createdAt = Date.now()) => ({ id: `op-${++n}`, type, createdAt, payload: { user: 'ali', device: 'TRM-01', ...payload } });

test('rafa kaldırma raf stokunu ve belge ilerlemesini artırır', () => {
  const r = depo.islemler('TRM-01', 'ali', [
    op('PUTAWAY', { receiptId: '26-9', lineId: '26-9-101', productId: '101', shelf: 'A-01-01', qty: 20 }),
    op('PUTAWAY', { receiptId: '26-9', lineId: '26-9-101', productId: '101', shelf: 'a-01-02', qty: 4 }),
  ]);
  assert.ok(r.every((x) => x.ok));
  assert.strictEqual(depo.miktar('101', 'A-01-01'), 20);
  assert.strictEqual(depo.miktar('101', 'A-01-02'), 4);
  const m = JSON.parse(depo.master().json);
  const belge = m.receipts.find((x) => x.id === '26-9');
  assert.strictEqual(belge.lines.find((l) => l.id === '26-9-101').shelved, 24);
  assert.strictEqual(depo.bekleyenKabul().get('101'), undefined);
  assert.strictEqual(depo.bekleyenKabul().get('102'), 10);
});

test('aynı işlem ikinci kez gelirse yeniden işlenmez', () => {
  const o = op('PUTAWAY', { receiptId: '26-9', lineId: '26-9-102', productId: '102', shelf: 'B-01-01', qty: 3 });
  depo.islemler('TRM-01', 'ali', [o]);
  const r = depo.islemler('TRM-01', 'ali', [o]);
  assert.deepStrictEqual(r, [{ id: o.id, ok: true }]);
  assert.strictEqual(depo.miktar('102', 'B-01-01'), 3);
});

test('tanımsız rafa gelen mal kaybolmaz, raf açılır', () => {
  depo.islemler('TRM-01', 'ali', [op('PUTAWAY', { productId: '103', shelf: 'Z-09', qty: 2 })]);
  assert.ok(depo.rafVarMi('Z-09'));
  assert.strictEqual(depo.miktar('103', 'Z-09'), 2);
});

test('transfer kaynağı eksiye düşürmez', () => {
  depo.islemler('TRM-01', 'ali', [op('TRANSFER', { productId: '101', from: 'A-01-02', to: 'B-01-01', qty: 10 })]);
  assert.strictEqual(depo.miktar('101', 'A-01-02'), 0);
  assert.strictEqual(depo.miktar('101', 'B-01-01'), 10);
});

test('hatalı işlem kalıcı ret alır', () => {
  const r = depo.islemler('TRM-01', 'ali', [op('TRANSFER', { productId: '101', from: 'A', to: 'A', qty: 1 }), op('XYZ', {})]);
  assert.deepStrictEqual(r.map((x) => x.ok), [false, false]);
});

test('sayım rafı sayılan değere çeker; sayılmayan ürün sıfırlanır', () => {
  // B-01-01: 102 x3, 101 x10. Terminal yalnız 102'yi 5 saydı.
  const id = 'C1';
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, created_at) VALUES('C1','SAY-0001','Deneme',1,'GENEL','OPEN','ADMIN',?)", Date.now());
  const r = depo.islemler('TRM-01', 'ali', [
    op('COUNT_SUBMIT', { sessionId: id, no: 'SAY-0001', shelves: ['B-01-01'], lines: [{ shelf: 'B-01-01', productId: '102', system: 3, counted: 5 }] }, Date.now() + 1000),
  ]);
  assert.ok(r[0].ok);
  assert.strictEqual(depo.miktar('102', 'B-01-01'), 5);
  assert.strictEqual(depo.miktar('101', 'B-01-01'), 0);
  const o = depo.sayimOzet(id);
  const u102 = o.urunler.find((u) => u.productId === '102');
  // Olması gereken = raflar (5) + bekleyen kabul (10 − 3 = 7) = 12; Vega 10 → +2
  assert.strictEqual(u102.hedef, 12);
  assert.strictEqual(u102.fark, 2);
  const u101 = o.urunler.find((u) => u.productId === '101');
  // 101: A-01-01'de 20 kaldı; Vega 24 → −4
  assert.strictEqual(u101.hedef, 20);
  assert.strictEqual(u101.fark, -4);
});

test('terminalde başlatılan serbest sayım onay bekleyen olarak açılır', () => {
  depo.islemler('TRM-01', 'ali', [op('COUNT_SUBMIT', { sessionId: 'LOCAL-abc', no: 'SAY-T1', title: 'Serbest', shelves: ['A-01-01'], lines: [{ shelf: 'A-01-01', productId: '101', system: 20, counted: 20 }] })]);
  const s = db.get("SELECT * FROM count_session WHERE id='LOCAL-abc'");
  assert.strictEqual(s.status, 'CLOSED');
  assert.strictEqual(s.source, 'TERMINAL');
});

test('ana veri: ETag değişiklikle değişir, terminale açık sayım ve kullanıcı gider', () => {
  const e1 = depo.master().etag;
  db.run("INSERT INTO app_user(username, name, salt, pin_hash, active, created_at) VALUES('ali','Ali','s','h',1,0)");
  depo.degisti();
  const m = depo.master();
  assert.notStrictEqual(m.etag, e1);
  const j = JSON.parse(m.json);
  assert.deepStrictEqual(j.users.map((u) => u.username), ['ali']);
  assert.deepStrictEqual(j.counts.map((c) => c.id), ['C1']);
  assert.strictEqual(j.warehouse, 'MERKEZ');
  assert.deepStrictEqual(j.products.find((p) => p.id === '101').barcodes, ['8691234500412']);
});

test('ürün listesi isimle yakın eşleşmeyi bulur', () => {
  const r = depo.urunListesi({ q: 'antfiriz' });
  assert.deepStrictEqual(r.liste.map((u) => u.id), ['103']);
  assert.strictEqual(depo.urunListesi({ q: '8691234500412' }).liste[0].id, '101');
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
