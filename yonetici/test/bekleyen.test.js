// Rafa bekleyen mal ürün bazlı (depo.bekleyenUrunler / bekleyenListe): belge eşleşmesi aranmaz. Vega'sız; görüntü elle verilir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-bekleyen-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const belge = (id, docNo, ts, satirlar) => ({
  id, izahat: '20', tur: 'Alış faturası', docNo, supplier: 'Tedarikçi', date: '01.11.2026', ts, depo: 1, depoAd: 'MERKEZ',
  lines: satirlar.map(([pid, accepted]) => ({ id: `${id}-${pid}`, productId: pid, accepted })),
});
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
    belge('B-1', 'FAT-1', 1, [['101', 20], ['102', 10]]),
    belge('B-2', 'FAT-2', 2, [['101', 10]]),
  ],
});
for (const r of ['A-01-01', 'B-01-01']) depo.rafEkle(1, r);

let n = 0;
const op = (type, payload) => ({ id: `op-${++n}`, type, createdAt: Date.now(), payload: { user: 'ali', device: 'TRM-01', ...payload } });
const calistir = (...ops) => assert.ok(depo.islemler('TRM-01', 'ali', ops).every((x) => x.ok));
const bekleyen = (pid) => depo.bekleyenKabul(1).get(pid) || 0;

test('bekleyen = gelen belgelerin toplamı, belgelere bölünmez', () => {
  assert.strictEqual(bekleyen('101'), 30);
  assert.strictEqual(bekleyen('102'), 10);
  const l = depo.bekleyenListe();
  assert.deepStrictEqual(l.ozet, { urun: 2, adet: 40, depolar: [{ depo: 1, depoAd: 'MERKEZ', urun: 2, adet: 40 }] });
  assert.deepStrictEqual(l.urunler.map((u) => [u.urunKod, u.gelen, u.rafa, u.bekleyen]), [['HF-0310', 10, 0, 10], ['YF-1042', 30, 0, 30]]);
});

test('belgesiz rafa kaldırma bekleyenden düşer', () => {
  calistir(op('PUTAWAY', { productId: '101', shelf: 'A-01-01', qty: 12 }));
  assert.strictEqual(bekleyen('101'), 18);
});

test('belgeli rafa kaldırma da aynı ürünün toplamından düşer (hangi belge olduğu önemsiz)', () => {
  calistir(op('PUTAWAY', { receiptId: 'B-2', lineId: 'B-2-101', productId: '101', shelf: 'A-01-01', qty: 10 }));
  assert.strictEqual(bekleyen('101'), 8);
});

test('terminalden ürün bazlı listeyle (BEK-) kaldırma belgesiz yazılır, receipt_shelved kirlenmez', () => {
  calistir(op('PUTAWAY', { receiptId: 'BEK-1', lineId: 'BEK-1-101', productId: '101', shelf: 'A-01-01', qty: 3 }));
  assert.strictEqual(bekleyen('101'), 5);
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM receipt_shelved WHERE line_id LIKE 'BEK-%'").n, 0);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 25);
  const m = JSON.parse(depo.master().json);
  assert.deepStrictEqual(m.receipts.find((r) => r.id === 'BEK-1').lines.map((l) => [l.id, l.productId, l.accepted]), [['BEK-1-101', '101', 5], ['BEK-1-102', '102', 10]]);
});

test('geri alınan kaldırma bekleyene geri döner; fazla kaldırma eksiye düşmez', () => {
  const son = db.get("SELECT id FROM movement WHERE kind='PUTAWAY' AND ref IS NULL ORDER BY id DESC LIMIT 1").id;
  depo.rafaKaldirmaGeriAl(son);
  assert.strictEqual(bekleyen('101'), 8);
  calistir(op('PUTAWAY', { productId: '102', shelf: 'B-01-01', qty: 15 }));
  assert.strictEqual(bekleyen('102'), 0);
  assert.strictEqual(depo.bekleyenListe().ozet.urun, 1);
});

test('elle kapatılan belge ve ona yazılan kaldırma sayılmaz (belgesiz kaldırma sürer)', () => {
  db.run('INSERT INTO receipt_state(receipt_id, closed, closed_at, note) VALUES(?,1,?,?)', 'B-2', Date.now(), '');
  depo.degisti();
  // B-1: 20 gelen − 12 belgesiz = 8 (B-2'nin 10'u ve ona yazılan 10 kaldırma dışarıda).
  assert.strictEqual(bekleyen('101'), 8);
});

test('arama: stok kodu, ad ve barkod', () => {
  db.run('UPDATE receipt_state SET closed=0 WHERE receipt_id=?', 'B-2');
  depo.degisti();
  assert.deepStrictEqual(depo.bekleyenListe({ metin: 'yf-10' }).urunler.map((u) => u.productId), ['101']);
  assert.deepStrictEqual(depo.bekleyenListe({ metin: '8691234500412' }).urunler.map((u) => u.productId), ['101']);
  assert.deepStrictEqual(depo.bekleyenListe({ metin: 'hava' }).urunler, []);
});

test('milat: ayar bir kez 2026-10-31 yapılır, günlük sınır kapalı', () => {
  assert.strictEqual(config.load().kabul.baslangic, '2026-10-31');
  assert.strictEqual(config.load().kabul.gun, 0);
  assert.strictEqual(config.load().kabul.milatSurum, 1);
  assert.strictEqual(config.kabulBaslangic(config.load()), '2026-10-31');
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Mal kabul belge listesi: ürün bazlı kaldırma en eski belgeden başlayarak belgelere dağıtılır', () => {
  const b = Object.fromEntries(depo.belgelerDagitimli().map((x) => [x.id, x]));
  // 102: 10 geldi, 15 kaldırıldı → FAT-1'in 102 satırı kapanır; 101: 30 geldi, 22 kaldırıldı (8 bekliyor)
  assert.strictEqual(b['B-1'].lines.find((l) => l.productId === '102').shelved, 10);
  const kalan = Object.values(b).reduce((t, x) => t + x.kalan, 0);
  assert.strictEqual(kalan, depo.bekleyenListe().ozet.adet);
  assert.strictEqual(b['B-2'].acik, false);
  assert.strictEqual(b['B-1'].acik, true);
});

test('aynı anda iki terminal aynı ürünü rafa kaldırır: ikisi de kabul edilir (mal kaybolmaz), bekleyen eksiye düşmez, hiçbir işlem reddedilmez', () => {
  assert.strictEqual(bekleyen('101'), 8);
  const hepsi = depo.islemler('TRM-01', 'ali', [op('PUTAWAY', { receiptId: 'BEK-1', lineId: 'BEK-1-101', productId: '101', shelf: 'A-01-01', qty: 5, depot: 1 })])
    .concat(depo.islemler('TRM-02', 'veli', [op('PUTAWAY', { receiptId: 'BEK-1', lineId: 'BEK-1-101', productId: '101', shelf: 'B-01-01', qty: 5, depot: 1 })]));
  assert.ok(hepsi.every((x) => x.ok), JSON.stringify(hepsi));
  assert.strictEqual(bekleyen('101'), 0, 'toplam 10 > bekleyen 8: eksiye düşmez');
  assert.strictEqual(depo.miktar(1, '101', 'B-01-01'), 5);
  // Aynı işlem yeniden gelirse (bağlantı koptu) ikinci kez rafa eklenmez.
  const o = op('PUTAWAY', { receiptId: 'BEK-1', lineId: 'BEK-1-101', productId: '101', shelf: 'B-01-01', qty: 1, depot: 1 });
  depo.islemler('TRM-02', 'veli', [o]);
  depo.islemler('TRM-02', 'veli', [o]);
  assert.strictEqual(depo.miktar(1, '101', 'B-01-01'), 6);
  // Ürün listede kalmayınca (bekleyen 0) terminal yine de kaldırır: sunucu reddetmez.
  assert.ok(depo.islemler('TRM-01', 'ali', [op('PUTAWAY', { productId: '101', shelf: 'A-01-01', qty: 2, depot: 1 })])[0].ok);
});
