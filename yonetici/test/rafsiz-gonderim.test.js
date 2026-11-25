// Rafsız gönderim rafa bekleyenden düşer (2026-11-25, Ortaş: "31.10'dan beri alış belgelerinde hiç rafa kalkan yok").
// Merkez'e alışla gelip rafa konmadan Toybelen'e giden mal Merkez'de rafa kaldırılacak iş değildir; düşülmezse alış satırı hiç kapanmaz.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-rafsiz-gonderim-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const transfer = require('../server/transfer');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 }, transfer: { aktif: true, cift: [1, 108] } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const belge = (id, ts, satirlar) => ({
  id, izahat: '20', tur: 'Alış faturası', docNo: id, supplier: 'Tedarikçi', date: '20.11.2026', ts, depo: 1, depoAd: 'MERKEZ',
  lines: satirlar.map(([pid, accepted]) => ({ id: `${id}-${pid}`, productId: pid, accepted })),
});
depo._goruntuKur({
  surum: 2, at: Date.now(), depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 108, ad: 'TOYBELEN' }],
  products: [
    { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
    { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
    { id: '103', code: 'AN-0040', name: 'Antifriz 4 L', unit: 'Adet' },
  ],
  stock: { 1: { 101: 10, 102: 5, 103: 4 } }, moved: [], barcodes: {},
  receipts: [belge('FAT-1', Date.now() - 86400000, [['101', 10], ['102', 5]]), belge('FAT-2', Date.now(), [['103', 4]])],
});
transfer._gorunum({ at: Date.now(), yolda: 3, depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 3, ad: 'TRANSFER' }, { ind: 108, ad: 'TOYBELEN' }], sevkler: [], ozet: 'x' });
depo.rafEkle(1, 'A-01-01');
depo.rafEkle(1, 'A-01-02');

let n = 0;
const op = (type, payload) => ({ id: `rg-${++n}`, type, createdAt: Date.now(), payload: { user: 'ali', device: 'TRM-01', ...payload } });
const calistir = (...ops) => {
  const r = depo.islemler('TRM-01', 'ali', ops);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
};
const bekleyen = (pid) => depo.bekleyenKabul(1).get(pid) || 0;
const belgeDurum = (id) => depo.belgelerDagitimli().find((b) => b.id === id);

test('başlangıç: iki alış belgesi açık, hepsi bekliyor', () => {
  assert.strictEqual(bekleyen('101'), 10);
  assert.strictEqual(bekleyen('102'), 5);
  assert.strictEqual(belgeDurum('FAT-1').acik, true);
});

test('bir kalem rafa, öteki rafsız Toybelen\'e: alış belgesi rafa kalkmış olur, Merkez\'de bekleyen kalmaz', () => {
  calistir(op('PUTAWAY', { receiptId: 'BEK-1', lineId: 'BEK-1-101', productId: '101', shelf: 'A-01-01', qty: 10, depot: 1 }));
  // Eskiden burada kalıyordu: 102 rafa hiç konmadığı için FAT-1 "Kısmen kalktı"da sonsuza dek açık.
  assert.strictEqual(belgeDurum('FAT-1').acik, true);
  calistir(op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '102', qty: 5 }] }));
  assert.strictEqual(bekleyen('102'), 0);
  const b = belgeDurum('FAT-1');
  assert.strictEqual(b.acik, false);
  assert.strictEqual(b.kalan, 0);
  // /kabul?durum=kapali listesine girer.
  assert.ok(depo.belgelerDagitimli().filter((x) => !x.acik).some((x) => x.id === 'FAT-1'));
  // Terminalin "Rafa bekleyen ürünler" belgesinde 102 yok.
  const m = JSON.parse(depo.master().json);
  const bek = m.receipts.find((r) => r.id === 'BEK-1');
  assert.ok(!bek || !bek.lines.some((l) => l.productId === '102'));
});

test('raf stoku olan ürünün gönderimi rafsız sayılmaz (raftan düşer), bekleyene dokunmaz', () => {
  calistir(op('PUTAWAY', { receiptId: 'BEK-1', lineId: 'BEK-1-103', productId: '103', shelf: 'A-01-02', qty: 1, depot: 1 }));
  assert.strictEqual(bekleyen('103'), 3);
  // Terminal raf seçmeden gönderdi ama 103 A-01-02'de duruyor: sunucu raftan düşer, bekleyen değişmez.
  calistir(op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '103', qty: 1 }] }));
  assert.strictEqual(depo.miktar(1, '103', 'A-01-02'), 0);
  assert.strictEqual(bekleyen('103'), 3);
  // Rafta kalmadı: sonraki rafsız gönderim bekleyenden düşer.
  calistir(op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '103', qty: 2 }] }));
  assert.strictEqual(bekleyen('103'), 1);
  assert.strictEqual(belgeDurum('FAT-2').kalan, 1);
});

test('geri alınan gönderim bekleyene geri döner', () => {
  const t = db.get("SELECT t.id FROM transfer t JOIN transfer_line l ON l.transfer_id=t.id WHERE l.product_id='102' AND l.shelf=''");
  db.run("UPDATE transfer SET durum='GERI', geri_at=? WHERE id=?", Date.now(), t.id);
  depo.degisti();
  assert.strictEqual(bekleyen('102'), 5);
  assert.strictEqual(belgeDurum('FAT-1').acik, true);
});

test('milattan önceki gönderim sayılmaz', () => {
  const t = db.get("SELECT t.id FROM transfer t JOIN transfer_line l ON l.transfer_id=t.id WHERE l.product_id='103' AND l.shelf='' LIMIT 1");
  db.run('UPDATE transfer SET created_at=? WHERE id=?', new Date('2026-10-01T00:00:00').getTime(), t.id);
  depo.degisti();
  assert.strictEqual(bekleyen('103'), 3);
});

test('rafa kaldırılan ürünler listesi: ürün başına rafa kaldırılan + rafsız gönderilen, geri alınan yok', () => {
  const l = depo.kaldirilanListe();
  const u = Object.fromEntries(l.urunler.map((x) => [x.productId, x]));
  assert.deepStrictEqual([u['101'].rafa, u['101'].rafsizGiden, u['101'].raflar, u['101'].kisiler], [10, 0, ['A-01-01'], ['ali']]);
  // 102'nin gönderimi geri alındı; rafa da hiç konmadı → listede yok.
  assert.strictEqual(u['102'], undefined);
  // 103: 1 rafa kaldırıldı; 2'lik rafsız gönderim milattan önceye çekildi (önceki test) → milattan beri görünmez.
  assert.deepStrictEqual([u['103'].rafa, u['103'].rafsizGiden], [1, 0]);
  assert.strictEqual(depo.kaldirilanListe({ bas: new Date('2026-09-01T00:00:00').getTime() }).urunler.find((x) => x.productId === '103').rafsizGiden, 2);
  assert.deepStrictEqual(depo.kaldirilanListe({ metin: 'hf-' }).urunler, []);
  assert.strictEqual(depo.kaldirilanListe({ depoNo: 108 }).urunler.length, 0);
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
