// Özel raf (config.ozelRaflar; Ortaş: "SIPARIS SATIS"): mal kabulden doğrudan sipariş hazırlığına giden mal bu barkodla rafa
// kaldırılmış sayılır. Rafa bekleyen düşer; rafta stok oluşmaz, ürüne raf adresi (Vega KOD10) verilmez, raf sınırı uygulanmaz.
// Vega'sız; görüntü elle verilir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-ozelraf-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const OZEL = 'SIPARIS SATIS';
const kur = (urunler = []) =>
  depo._goruntuKur({
    surum: 2,
    at: Date.now(),
    depolar: [{ ind: 1, ad: 'MERKEZ' }],
    products: urunler.length ? urunler : [
      { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
      { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
    ],
    stock: { 1: { 101: 50, 102: 10 } },
    moved: [],
    barcodes: {},
    receipts: [
      { id: 'F-1', izahat: '20', tur: 'Alış faturası', docNo: 'FAT-1', supplier: 'Tedarikçi', date: '05.11.2026', ts: Date.now(), depo: 1, depoAd: 'MERKEZ', lines: [
        { id: 'F-1-101', productId: '101', accepted: 50 },
        { id: 'F-1-102', productId: '102', accepted: 10 },
      ] },
    ],
  });
kur();
for (const r of ['A-01-01', 'TK-01-01']) depo.rafEkle(1, r);

let n = 0;
const op = (type, payload, user = 'ali') => ({ id: `oz-${++n}`, type, createdAt: Date.now(), payload: { user, device: 'TRM-01', ...payload } });
const calistir = (...ops) => {
  const r = depo.islemler('TRM-01', 'ali', ops);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  return ops.map((o) => db.get('SELECT id FROM movement WHERE op_id=?', o.id)?.id);
};
const reddedilen = (user, o) => depo.islemler('TRM-01', user, [o])[0];
const bekleyen = (pid) => depo.bekleyenKabul(1).get(pid) || 0;
const stokSatiri = () => db.get('SELECT COUNT(*) AS n FROM location WHERE shelf=?', OZEL).n;
const adresSatiri = () => db.get('SELECT COUNT(*) AS n FROM product_home WHERE shelf=?', OZEL).n;

test('50 gelen: 5 SIPARIS SATIS + 45 raf → bekleyen 0, rafta stok ve adres oluşmaz', () => {
  assert.strictEqual(bekleyen('101'), 50);
  calistir(op('PUTAWAY', { receiptId: 'BEK-1', lineId: 'BEK-1-101', productId: '101', shelf: OZEL, qty: 5 }));
  assert.strictEqual(bekleyen('101'), 45, 'özel rafa kaldırılan bekleyenden düşer');
  calistir(op('PUTAWAY', { receiptId: 'BEK-1', lineId: 'BEK-1-101', productId: '101', shelf: 'A-01-01', qty: 45 }));
  assert.strictEqual(bekleyen('101'), 0);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 45, 'raftaki yalnız 45');
  assert.strictEqual(stokSatiri(), 0, 'özel rafta stok satırı yok');
  assert.strictEqual(adresSatiri(), 0, 'ürüne özel raf adresi verilmez (Vega KOD10 yazımı tetiklenmez)');
  assert.deepStrictEqual(depo.zimmetler(1, '101').map((z) => z.shelf), ['A-01-01']);
  const h = db.get("SELECT delta, after, kind, ref FROM movement WHERE shelf=? AND product_id='101'", OZEL);
  assert.deepStrictEqual({ ...h }, { delta: 5, after: 0, kind: 'PUTAWAY', ref: null });
});

test('belgeli (satır kimlikli) özel rafa kaldırma belge satırını ilerletir', () => {
  calistir(op('PUTAWAY', { receiptId: 'F-1', lineId: 'F-1-102', productId: '102', shelf: OZEL, qty: 4 }));
  assert.strictEqual(Number(db.get("SELECT shelved FROM receipt_shelved WHERE line_id='F-1-102'").shelved), 4);
  assert.strictEqual(bekleyen('102'), 6);
  assert.strictEqual(stokSatiri(), 0);
  assert.strictEqual(adresSatiri(), 0);
  const h = db.get("SELECT ref FROM movement WHERE shelf=? AND product_id='102'", OZEL);
  assert.strictEqual(h.ref, 'FAT-1');
});

test('küçük harfle yazılan kod da özel raftır; yeni raf kaydı açılmaz', () => {
  calistir(op('PUTAWAY', { productId: '102', shelf: 'siparis satis', qty: 1 }));
  assert.strictEqual(bekleyen('102'), 5);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM shelf WHERE code=?', OZEL).n, 0);
  assert.strictEqual(stokSatiri(), 0);
});

test('özel rafa kaldırma geri alınır: bekleyen döner, düşülecek stok aranmaz', () => {
  const [id] = calistir(op('PUTAWAY', { receiptId: 'F-1', lineId: 'F-1-102', productId: '102', shelf: OZEL, qty: 2 }));
  assert.strictEqual(bekleyen('102'), 3);
  const r = depo.rafaKaldirmaGeriAl(id, 'yönetici', 'yanlış');
  assert.strictEqual(r.geriAlinan, 2);
  assert.strictEqual(r.raf, OZEL);
  assert.strictEqual(bekleyen('102'), 5);
  assert.strictEqual(Number(db.get("SELECT shelved FROM receipt_shelved WHERE line_id='F-1-102'").shelved), 4);
  const geri = db.get("SELECT delta, after, kind, user FROM movement WHERE kind='PUTAWAY_GERI' AND shelf=?", OZEL);
  assert.deepStrictEqual({ ...geri }, { delta: -2, after: 0, kind: 'PUTAWAY_GERI', user: 'yönetici' });
  assert.strictEqual(stokSatiri(), 0);
  assert.throws(() => depo.rafaKaldirmaGeriAl(id), /zaten geri alındı/);
});

test('raf sınırı özel rafa uygulanmaz, normal rafa uygulanır', () => {
  const ayni = (u) => db.run("INSERT INTO app_user(username, name, salt, pin_hash, active, created_at, role, perms, depots, shelves) VALUES(?, ?, 's', 'h', 1, 0, 'ozel', '*', '*', ?)", u[0], u[0], u[1]);
  ayni(['tk', 'TK*']);
  assert.strictEqual(reddedilen('tk', op('PUTAWAY', { productId: '101', shelf: 'A-01-01', qty: 1 }, 'tk')).ok, false, 'normal raf sınır dışı');
  const once = bekleyen('102');
  const r = reddedilen('tk', op('PUTAWAY', { productId: '102', shelf: OZEL, qty: 1 }, 'tk'));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(bekleyen('102'), once - 1);
});

test('özel raf yalnız rafa kaldırmada kullanılır: raftan alma, transfer, sayım, raf düzenleme reddedilir', () => {
  const kod = (o) => reddedilen('ali', o);
  assert.strictEqual(kod(op('PICK', { productId: '101', shelf: OZEL, qty: 1 })).ok, false);
  assert.strictEqual(kod(op('TRANSFER', { productId: '101', from: 'A-01-01', to: OZEL, qty: 1 })).ok, false);
  assert.strictEqual(kod(op('TRANSFER', { productId: '101', from: OZEL, to: 'A-01-01', qty: 1 })).ok, false);
  assert.strictEqual(kod(op('SHELF_ARRANGE', { shelves: [OZEL], lines: [{ shelf: OZEL, productId: '101', counted: 3, system: 0 }] })).ok, false);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 45, 'hiçbiri raf stokunu değiştirmedi');
  assert.strictEqual(stokSatiri(), 0);
  // Terminalde "raf ekle" sorulursa sunucu sessizce geçer, raf kaydı açılmaz.
  assert.strictEqual(kod(op('SHELF_ADD', { code: OZEL })).ok, true);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM shelf WHERE code=?', OZEL).n, 0);
});

test('ana veri: özel raflar head ile gider, stok/adres satırı gitmez', () => {
  const m = JSON.parse(depo.master().json);
  assert.deepStrictEqual(m.specialShelves, [OZEL]);
  assert.ok(!m.locations.some((l) => l.shelf === OZEL));
  assert.ok(!m.homes.some((h) => h.shelf === OZEL));
});

test('raf kaydı elle açılmış olsa da: Raflar listesinde özel işaretli, sayım kapsamında ve gruplarda yok', () => {
  depo.rafEkle(1, OZEL);
  const r = depo.raflar(1).find((x) => x.code === OZEL);
  assert.strictEqual(r.ozel, true);
  assert.strictEqual(depo.raflar(1).find((x) => x.code === 'A-01-01').ozel, false);
  assert.ok(!depo.kapsamRaflari(1, ['SIPARIS']).includes(OZEL));
  assert.ok(!depo.rafGruplari(1).some((g) => g.onek === 'SIPARIS SATIS'));
});

test("Vega kartındaki 'SIPARIS SATIS' adresi zimmet olmaz", () => {
  config.update({ rafAdresi: { alan: 'KOD10' } });
  kur([
    { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet', raf: `${OZEL}, A-01-01` },
    { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
  ]);
  depo._goruntuKur({ ...depo.goruntu(), rafAlan: 'KOD10' });
  depo.vegaZimmetEsitle();
  assert.ok(!db.get('SELECT 1 AS x FROM product_home WHERE shelf=?', OZEL), 'özel raf zimmet olmadı');
  assert.ok(db.get("SELECT 1 AS x FROM product_home WHERE shelf='A-01-01' AND product_id='101'"), 'normal adres alındı');
});

test('özel raf olmadan önce yazılmış stok ve adresler bir kez temizlenir', () => {
  db.run('INSERT INTO location(depo, product_id, shelf, qty, updated_at) VALUES(1, ?, ?, 7, 0)', '102', OZEL);
  depo.zimmetEkle(1, '102', OZEL, 'TERMINAL');
  assert.strictEqual(stokSatiri(), 1);
  assert.strictEqual(adresSatiri(), 1);
  const r = depo.ozelRafTemizle();
  assert.deepStrictEqual(r, { stok: 1, adres: 1 });
  assert.strictEqual(stokSatiri(), 0);
  assert.strictEqual(adresSatiri(), 0);
  // İkinci çağrı bir şey yapmaz (bir kez).
  db.run('INSERT INTO location(depo, product_id, shelf, qty, updated_at) VALUES(1, ?, ?, 7, 0)', '102', OZEL);
  assert.deepStrictEqual(depo.ozelRafTemizle(), { stok: 0, adres: 0 });
  db.run('DELETE FROM location WHERE shelf=?', OZEL);
});

test('özel raf listesi ayardan gelir; boşaltılırsa SIPARIS SATIS sıradan raf olur', () => {
  config.update({ ozelRaflar: [] });
  assert.strictEqual(depo.ozelRafMi(OZEL), false);
  assert.deepStrictEqual(JSON.parse(depo.master().json).specialShelves, []);
  config.update({ ozelRaflar: [OZEL, ' ozel 2 '] });
  assert.deepStrictEqual(depo.ozelRaflar(), [OZEL, 'OZEL 2']);
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
