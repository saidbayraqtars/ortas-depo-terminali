// Terminal işlemlerinin sunucudaki etkisi (Vega'sız; Vega görüntüsü elle verilir). İki depo: 1 MERKEZ, 2 ŞUBE.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-test-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const iceaktar = require('../server/iceaktar');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

depo._goruntuKur({
  surum: 2,
  at: Date.now(),
  depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 2, ad: 'ŞUBE' }],
  products: [
    { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
    { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
    { id: '103', code: 'AN-0040', name: 'Antifriz 4 L', unit: 'Adet' },
  ],
  stock: { 1: { 101: 24, 102: 10, 103: 5 }, 2: { 101: 6 } },
  moved: [],
  barcodes: { 101: ['8691234500412'] },
  receipts: [
    { id: '26-9-1', izahat: '26', tur: 'Alış irsaliyesi', docNo: 'IRS-9', supplier: 'Tedarikçi', date: '21.10.2026', ts: 1, depo: 1, depoAd: 'MERKEZ', lines: [
      { id: '26-9-1-101', productId: '101', accepted: 24 },
      { id: '26-9-1-102', productId: '102', accepted: 10 },
    ] },
    { id: '20-5-2', izahat: '20', tur: 'Alış faturası', docNo: 'FAT-5', supplier: 'Tedarikçi', date: '21.10.2026', ts: 2, depo: 2, depoAd: 'ŞUBE', lines: [
      { id: '20-5-2-101', productId: '101', accepted: 6 },
    ] },
  ],
});
for (const r of ['A-01-01', 'A-01-02', 'B-01-01']) depo.rafEkle(1, r);
depo.rafEkle(2, 'A-01-01');

let n = 0;
const op = (type, payload, createdAt = Date.now()) => ({ id: `op-${++n}`, type, createdAt, payload: { user: 'ali', device: 'TRM-01', ...payload } });

test('rafa kaldırma raf stokunu ve belge ilerlemesini artırır', () => {
  const r = depo.islemler('TRM-01', 'ali', [
    op('PUTAWAY', { receiptId: '26-9-1', lineId: '26-9-1-101', productId: '101', shelf: 'A-01-01', qty: 20 }),
    op('PUTAWAY', { receiptId: '26-9-1', lineId: '26-9-1-101', productId: '101', shelf: 'a-01-02', qty: 4 }),
  ]);
  assert.ok(r.every((x) => x.ok));
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 20);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-02'), 4);
  const m = JSON.parse(depo.master().json);
  const belge = m.receipts.find((x) => x.id === '26-9-1');
  assert.strictEqual(belge.lines.find((l) => l.id === '26-9-1-101').shelved, 24);
  assert.strictEqual(depo.bekleyenKabul(1).get('101'), undefined);
  assert.strictEqual(depo.bekleyenKabul(1).get('102'), 10);
});

test('belge kendi deposunda rafa kalkar (terminalin seçili deposu farklı olsa da)', () => {
  const r = depo.islemler('TRM-01', 'ali', [op('PUTAWAY', { receiptId: '20-5-2', lineId: '20-5-2-101', productId: '101', shelf: 'A-01-01', qty: 6, depot: 1 })]);
  assert.ok(r[0].ok);
  assert.strictEqual(depo.miktar(2, '101', 'A-01-01'), 6);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 20);
});

test('aynı işlem ikinci kez gelirse yeniden işlenmez', () => {
  const o = op('PUTAWAY', { receiptId: '26-9-1', lineId: '26-9-1-102', productId: '102', shelf: 'B-01-01', qty: 3 });
  depo.islemler('TRM-01', 'ali', [o]);
  const r = depo.islemler('TRM-01', 'ali', [o]);
  assert.deepStrictEqual(r, [{ id: o.id, ok: true }]);
  assert.strictEqual(depo.miktar(1, '102', 'B-01-01'), 3);
});

test('tanımsız rafa gelen mal kaybolmaz, raf seçili depoda açılır', () => {
  depo.islemler('TRM-01', 'ali', [op('PUTAWAY', { productId: '103', shelf: 'Z-09', qty: 2, depot: 2 })]);
  assert.ok(depo.rafVarMi(2, 'Z-09'));
  assert.ok(!depo.rafVarMi(1, 'Z-09'));
  assert.strictEqual(depo.miktar(2, '103', 'Z-09'), 2);
});

test('transfer seçili depoda; kaynağı eksiye düşürmez', () => {
  depo.islemler('TRM-01', 'ali', [op('TRANSFER', { productId: '101', from: 'A-01-02', to: 'B-01-01', qty: 10, depot: 1 })]);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-02'), 0);
  assert.strictEqual(depo.miktar(1, '101', 'B-01-01'), 10);
});

test('hatalı işlem kalıcı ret alır', () => {
  const r = depo.islemler('TRM-01', 'ali', [op('TRANSFER', { productId: '101', from: 'A', to: 'A', qty: 1 }), op('XYZ', {}), op('PUTAWAY', { productId: 'P1', shelf: 'A-01-01', qty: 1 })]);
  assert.deepStrictEqual(r.map((x) => x.ok), [false, false, false]);
});

test('sayım sayımın deposunda; rafı sayılan değere çeker, sayılmayan ürün sıfırlanır', () => {
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, created_at, depo) VALUES('C1','SAY-0001','Deneme',1,'GENEL','OPEN','ADMIN',?,1)", Date.now());
  const r = depo.islemler('TRM-01', 'ali', [
    op('COUNT_SUBMIT', { sessionId: 'C1', no: 'SAY-0001', shelves: ['B-01-01'], lines: [{ shelf: 'B-01-01', productId: '102', system: 3, counted: 5 }] }, Date.now() + 1000),
  ]);
  assert.ok(r[0].ok);
  assert.strictEqual(depo.miktar(1, '102', 'B-01-01'), 5);
  assert.strictEqual(depo.miktar(1, '101', 'B-01-01'), 0);
  const o = depo.sayimOzet('C1');
  const u102 = o.urunler.find((u) => u.productId === '102');
  // MERKEZ: raflar 5 + bekleyen (10 − 3) = 12; Vega 10 → +2
  assert.strictEqual(u102.hedef, 12);
  assert.strictEqual(u102.fark, 2);
  const u101 = o.urunler.find((u) => u.productId === '101');
  // 101 MERKEZ: A-01-01'de 20 kaldı (ŞUBE'deki 6 sayılmaz); Vega MERKEZ 24 → −4
  assert.strictEqual(u101.hedef, 20);
  assert.strictEqual(u101.fark, -4);
});

test('terminalde başlatılan serbest sayım terminalin deposunda, onay bekleyen olarak açılır', () => {
  depo.islemler('TRM-01', 'ali', [op('COUNT_SUBMIT', { sessionId: 'LOCAL-abc', no: 'SAY-T1', title: 'Serbest', depot: 2, shelves: ['A-01-01'], lines: [{ shelf: 'A-01-01', productId: '101', system: 6, counted: 6 }] })]);
  const s = db.get("SELECT * FROM count_session WHERE id='LOCAL-abc'");
  assert.strictEqual(s.status, 'CLOSED');
  assert.strictEqual(s.depo, 2);
});

test('ana veri: depolar, depo bazlı raf/konum/belge/stok; ETag değişiklikle değişir', () => {
  const e1 = depo.master().etag;
  db.run("INSERT INTO app_user(username, name, salt, pin_hash, active, created_at) VALUES('ali','Ali','s','h',1,0)");
  depo.degisti();
  const m = depo.master();
  assert.notStrictEqual(m.etag, e1);
  const j = JSON.parse(m.json);
  assert.deepStrictEqual(j.depots, [{ id: 1, name: 'MERKEZ' }, { id: 2, name: 'ŞUBE' }]);
  assert.strictEqual(j.defaultDepot, 1);
  assert.deepStrictEqual(j.users.map((u) => u.username), ['ali']);
  assert.deepStrictEqual(j.counts.map((c) => [c.id, c.depot]), [['C1', 1]]);
  const p = j.products.find((x) => x.id === '101');
  assert.deepStrictEqual(p.stocks, { 1: 24, 2: 6 });
  assert.strictEqual(p.vegaStock, 30);
  assert.ok(j.shelves.some((s) => s.depot === 2 && s.code === 'A-01-01'));
  assert.ok(j.locations.some((l) => l.depot === 2 && l.productId === '101' && l.qty === 6));
  assert.ok(!j.receipts.some((r) => r.id === '20-5-2'), 'tamamlanan belge gitmez');
});

test('ürün listesi isimle yakın eşleşmeyi bulur; depo süzgeci', () => {
  const r = depo.urunListesi({ q: 'antfiriz' });
  assert.deepStrictEqual(r.liste.map((u) => u.id), ['103']);
  assert.strictEqual(depo.urunListesi({ q: '8691234500412' }).liste[0].id, '101');
  const sube = depo.urunListesi({ depo: 2 }).liste.find((u) => u.id === '101');
  assert.strictEqual(sube.vegaStock, 6);
  assert.strictEqual(sube.raf, 6);
});

test('Excel içe aktarma: depo adı eşleşir, raf açılır, miktar ve asıl raf yazılır, hatalı satır atlanır', async () => {
  const csv = 'Depo;Raf;Bölge;Ürün kodu;Miktar\nmerkez;C-01-01;C;YF-1042;7\nŞube;C-02-01;C;8691234500412;\nOLMAYAN;C-03-01;;;\n1;C-04-01;;XX-YOK;\n';
  const t = await iceaktar.oku('raflar.csv', Buffer.from(csv));
  const es = iceaktar.tahminEt(t.basliklar);
  assert.deepStrictEqual(es, { depo: 0, raf: 1, bolge: 2, urun: 3, miktar: 4 });
  const c = iceaktar.coz({ ...t, eslesme: es });
  assert.strictEqual(c.satirlar.length, 2);
  assert.deepStrictEqual(c.hatalar.map((h) => h.satir), [4, 5]);
  const s = iceaktar.uygula(c);
  assert.deepStrictEqual(s, { yeniRaf: 2, miktar: 1, asilRaf: 1 });
  assert.strictEqual(depo.miktar(1, '101', 'C-01-01'), 7);
  assert.strictEqual(db.get("SELECT shelf FROM product_home WHERE depo=2 AND product_id='101'").shelf, 'C-02-01');
  // Elle eşleme: OLMAYAN → 2
  const c2 = iceaktar.coz({ ...t, eslesme: es, depoEslesme: { OLMAYAN: 2 } });
  assert.strictEqual(c2.hatalar.length, 1);
});

test('eski tek depolu veritabanı göçü: raflar ve stok varsayılan depoya bağlanır', () => {
  const { DatabaseSync } = require('node:sqlite');
  const f = path.join(dir, 'eski.db');
  const e = new DatabaseSync(f);
  e.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('surum','1');
    CREATE TABLE shelf(code TEXT PRIMARY KEY, zone TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'ADMIN', created_at INTEGER NOT NULL);
    CREATE TABLE location(product_id TEXT NOT NULL, shelf TEXT NOT NULL, qty REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(product_id, shelf));
    CREATE TABLE movement(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, product_id TEXT NOT NULL, shelf TEXT NOT NULL, delta REAL NOT NULL, after REAL NOT NULL, kind TEXT NOT NULL, ref TEXT, user TEXT, device TEXT, op_id TEXT);
    CREATE TABLE count_session(id TEXT PRIMARY KEY, no TEXT NOT NULL, title TEXT NOT NULL, blind INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'RAF', status TEXT NOT NULL DEFAULT 'OPEN', source TEXT NOT NULL DEFAULT 'ADMIN', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, closed_at INTEGER, vega_docs TEXT, vega_written_at INTEGER);
    INSERT INTO shelf(code, created_at) VALUES('X-1', 0); INSERT INTO location VALUES('9', 'X-1', 3, 0);`);
  e.close();
  db.close();
  db.open(f, { varsayilanDepo: 7 });
  assert.strictEqual(db.get("SELECT depo FROM shelf WHERE code='X-1'").depo, 7);
  assert.strictEqual(db.get("SELECT depo, qty FROM location WHERE product_id='9'").depo, 7);
  assert.strictEqual(db.meta('surum'), '2');
  db.close();
  db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
