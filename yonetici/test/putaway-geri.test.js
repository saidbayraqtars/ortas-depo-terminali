// Yönetici: terminalden yapılan rafa kaldırmayı geri alma (depo.rafaKaldirmaGeriAl). Vega'sız; görüntü elle verilir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-putgeri-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

depo._goruntuKur({
  surum: 2,
  at: Date.now(),
  depolar: [{ ind: 1, ad: 'MERKEZ' }],
  products: [
    { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
    { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
  ],
  stock: { 1: { 101: 30, 102: 10 } },
  moved: [],
  barcodes: { 101: ['8691234500412'] },
  receipts: [
    { id: 'R-1', izahat: '26', tur: 'Alış irsaliyesi', docNo: 'IRS-1', supplier: 'Tedarikçi', date: '21.10.2026', ts: 1, depo: 1, depoAd: 'MERKEZ', lines: [
      { id: 'R-1-101', productId: '101', accepted: 24 },
      { id: 'R-1-102', productId: '102', accepted: 10 },
    ] },
  ],
});
for (const r of ['A-01-01', 'A-01-02', 'B-01-01']) depo.rafEkle(1, r);

let n = 0;
const op = (type, payload) => ({ id: `op-${++n}`, type, createdAt: Date.now(), payload: { user: 'ali', device: 'TRM-01', ...payload } });
const calistir = (...ops) => {
  const r = depo.islemler('TRM-01', 'ali', ops);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  return ops.map((o) => db.get('SELECT id FROM movement WHERE op_id=?', o.id)?.id);
};
const kaldirilan = (satir) => Number(db.get('SELECT shelved FROM receipt_shelved WHERE line_id=?', satir)?.shelved || 0);
const zimmet = (pid, raf) => db.get('SELECT source FROM product_home WHERE depo=1 AND product_id=? AND shelf=?', pid, raf)?.source || null;

test('belgeli rafa kaldırma geri alınır: raf düşer, belgede kalan geri gelir, terminal adresi kalkar', () => {
  const [id] = calistir(op('PUTAWAY', { receiptId: 'R-1', lineId: 'R-1-101', productId: '101', shelf: 'A-01-01', qty: 20 }));
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 20);
  assert.strictEqual(kaldirilan('R-1-101'), 20);
  assert.strictEqual(zimmet('101', 'A-01-01'), 'TERMINAL');

  const r = depo.rafaKaldirmaGeriAl(id, 'yönetici', 'yanlış raf');
  assert.deepStrictEqual({ ...r }, { geriAlinan: 20, raf: 'A-01-01', belgeSatiri: true });
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 0);
  assert.strictEqual(db.get("SELECT 1 FROM location WHERE shelf='A-01-01' AND product_id='101'"), undefined);
  assert.strictEqual(kaldirilan('R-1-101'), 0);
  assert.strictEqual(depo.bekleyenKabul(1).get('101'), 24);
  assert.strictEqual(zimmet('101', 'A-01-01'), null);

  const asil = db.get('SELECT geri_at, geri_user, geri_not FROM movement WHERE id=?', id);
  assert.ok(asil.geri_at);
  assert.strictEqual(asil.geri_user, 'yönetici');
  assert.strictEqual(asil.geri_not, 'yanlış raf');
  const geri = db.get("SELECT delta, after, kind, ref, user, device FROM movement WHERE kind='PUTAWAY_GERI' AND shelf='A-01-01'");
  assert.deepStrictEqual({ ...geri }, { delta: -20, after: 0, kind: 'PUTAWAY_GERI', ref: 'IRS-1', user: 'yönetici', device: 'PC' });
  // Terminale giden ana veride belge yeniden açık.
  const belge = JSON.parse(depo.master().json).receipts.find((x) => x.id === 'R-1');
  assert.strictEqual(belge.lines.find((l) => l.id === 'R-1-101').shelved, 0);
});

test('aynı hareket ikinci kez geri alınmaz', () => {
  const [id] = calistir(op('PUTAWAY', { receiptId: 'R-1', lineId: 'R-1-102', productId: '102', shelf: 'A-01-02', qty: 4 }));
  depo.rafaKaldirmaGeriAl(id);
  assert.throws(() => depo.rafaKaldirmaGeriAl(id), /zaten geri alındı/);
  assert.strictEqual(depo.miktar(1, '102', 'A-01-02'), 0);
  assert.strictEqual(kaldirilan('R-1-102'), 0);
});

test('rafta o miktar kalmadıysa geri alınmaz ve hiçbir şey değişmez', () => {
  const [id] = calistir(op('PUTAWAY', { receiptId: 'R-1', lineId: 'R-1-101', productId: '101', shelf: 'A-01-02', qty: 10 }));
  calistir(op('PICK', { productId: '101', shelf: 'A-01-02', qty: 6 }));
  assert.strictEqual(depo.miktar(1, '101', 'A-01-02'), 4);
  assert.throws(() => depo.rafaKaldirmaGeriAl(id), /şu an 4 var; 10 geri alınamaz/);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-02'), 4);
  assert.strictEqual(kaldirilan('R-1-101'), 10);
  assert.strictEqual(db.get('SELECT geri_at FROM movement WHERE id=?', id).geri_at, null);
});

test('belgesiz rafa kaldırma geri alınır, belge ilerlemesine dokunulmaz', () => {
  const before = kaldirilan('R-1-101');
  const [id] = calistir(op('PUTAWAY', { productId: '101', shelf: 'B-01-01', qty: 3 }));
  assert.strictEqual(depo.miktar(1, '101', 'B-01-01'), 3);
  const r = depo.rafaKaldirmaGeriAl(id, 'yönetici', '');
  assert.strictEqual(r.belgeSatiri, false);
  assert.strictEqual(depo.miktar(1, '101', 'B-01-01'), 0);
  assert.strictEqual(kaldirilan('R-1-101'), before);
  assert.strictEqual(db.get('SELECT geri_not FROM movement WHERE id=?', id).geri_not, null);
});

test('yönetici/Excel adresi geri almada silinmez; raf başka ürünle kalırsa adres kalır', () => {
  depo.zimmetEkle(1, '102', 'B-01-01', 'ADMIN');
  const [a] = calistir(op('PUTAWAY', { productId: '102', shelf: 'B-01-01', qty: 2 }));
  const [b] = calistir(op('PUTAWAY', { productId: '102', shelf: 'B-01-01', qty: 5 }));
  assert.strictEqual(zimmet('102', 'B-01-01'), 'ADMIN');
  depo.rafaKaldirmaGeriAl(b);
  assert.strictEqual(depo.miktar(1, '102', 'B-01-01'), 2);
  assert.strictEqual(zimmet('102', 'B-01-01'), 'ADMIN');
  depo.rafaKaldirmaGeriAl(a);
  assert.strictEqual(depo.miktar(1, '102', 'B-01-01'), 0);
  assert.strictEqual(zimmet('102', 'B-01-01'), 'ADMIN');
});

test('yalnız rafa kaldırma ve var olan hareket geri alınır', () => {
  const [pick] = calistir(op('PICK', { productId: '101', shelf: 'A-01-02', qty: 1 }));
  assert.throws(() => depo.rafaKaldirmaGeriAl(pick), /Yalnız rafa kaldırma/);
  assert.throws(() => depo.rafaKaldirmaGeriAl(999999), /bulunamadı/);
  // Geri almanın kendi hareketi (PUTAWAY_GERI) tekrar geri alınamaz.
  const gerisi = db.get("SELECT id FROM movement WHERE kind='PUTAWAY_GERI' ORDER BY id LIMIT 1").id;
  assert.throws(() => depo.rafaKaldirmaGeriAl(gerisi), /Yalnız rafa kaldırma/);
});

test('işlem kaydı olmayan belgeli eski satır geri alınmaz', () => {
  db.run("INSERT INTO location(depo, product_id, shelf, qty, updated_at) VALUES(1,'101','A-01-01',5,0)");
  const eski = db.run("INSERT INTO movement(ts, depo, product_id, shelf, delta, after, kind, ref) VALUES(1,1,'101','A-01-01',5,5,'PUTAWAY','IRS-ESKI')");
  assert.throws(() => depo.rafaKaldirmaGeriAl(Number(eski.lastInsertRowid)), /eski kayıt geri alınamaz/);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 5);
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
