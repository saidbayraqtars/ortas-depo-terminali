// Canlı sayım (2.2.0): satış ve rafa kaldırma sürerken sayım. K1: sayıldıktan sonra rafa yapılan hareket sayımca silinmez.
// K2: Vega farkı sayım anında dondurulur; sayımdan sonraki satış onayda fişe karışmaz.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-canli-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const vega = require('../server/vega');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

// Her test kendi zaman diliminde (2 saat arayla, hepsi geçmişte): bir testin hareketi diğerinin "sayımdan sonra"sına düşmesin.
let T = Date.now() - 24 * 3600 * 1000;
let dilim = 0;
const yeniDilim = () => (T = Date.now() - (22 - 2 * dilim++) * 3600 * 1000);
const goruntu = (stok, filigran, filigranAt = Date.now() + 1) =>
  depo._goruntuKur({
    surum: 2,
    at: Date.now(),
    filigran,
    filigranAt,
    depolar: [{ ind: 1, ad: 'MERKEZ' }],
    products: [
      { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
      { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
      { id: '103', code: 'AN-0040', name: 'Antifriz 4 L', unit: 'Adet' },
      { id: '104', code: 'BJ-0001', name: 'Buji', unit: 'Adet' },
    ],
    stock: { 1: stok },
    moved: [],
    barcodes: {},
    receipts: [],
  });
goruntu({ 101: 10, 102: 4, 103: 6, 104: 20 }, 500, T - 200000);
for (const r of ['A-01', 'A-02', 'B-01']) depo.rafEkle(1, r);
const koy = (pid, raf, q) => db.tx(() => depo.miktarAyarla(1, pid, raf, q, { kind: 'ADJUST', ts: T - 3600000 }));

let n = 0;
/** Terminal işlemi; `saat` terminal saatinin sunucudan farkı (ms). createdAt ve sentAt terminal saatiyle. */
const gonder = (type, payload, an, { saat = 0, sentAt = Date.now() } = {}) =>
  depo.islemler('TRM-01', 'ali', [{ id: `c-${++n}`, type, createdAt: an + saat, payload: { user: 'ali', device: 'TRM-01', ...payload } }], { sentAt: sentAt + saat });
const oturum = (id) =>
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, created_at, depo) VALUES(?,?,'Canlı',1,'RAF','OPEN','ADMIN',?,1)", id, id, T - 600000);

test('sayarken raftan alınan ve rafa konan mal sayımca silinmez; okutulmayan eski ürün 0 olur', () => {
  yeniDilim();
  koy('101', 'A-01', 10);
  koy('103', 'A-01', 6);
  oturum('K1');
  // Raf A-01 T'de açıldı, 101 T+10 sn'de son okutuldu (10 adet). Sonra başka terminal 3 adet aldı, 102'den 5 adet koydu.
  assert.ok(gonder('PICK', { productId: '101', shelf: 'A-01', qty: 3, depot: 1 }, T + 20000)[0].ok);
  assert.ok(gonder('PUTAWAY', { productId: '102', shelf: 'A-01', qty: 5, depot: 1 }, T + 30000)[0].ok);
  const r = gonder('COUNT_SUBMIT', {
    sessionId: 'K1', no: 'K1', depot: 1, shelves: ['A-01'],
    shelfTimes: [{ shelf: 'A-01', start: T, end: T + 10000 }],
    lines: [{ shelf: 'A-01', productId: '101', system: 10, counted: 10, at: T + 10000 }],
  }, T + 60000);
  assert.ok(r[0].ok, r[0].error);
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 7, 'sayılan 10 − sonradan alınan 3');
  assert.strictEqual(depo.miktar(1, '102', 'A-01'), 5, 'raf açıldıktan sonra konan, okutulmayan ürün yerinde kalır');
  assert.strictEqual(depo.miktar(1, '103', 'A-01'), 0, 'açılıştan önce rafta olup okutulmayan ürün 0');
  const o = depo.sayimOzet('K1');
  const l101 = o.satirlar.find((l) => l.product_id === '101');
  assert.strictEqual(l101.hareket_sonra, -3);
  assert.strictEqual(l101.sistemAnda, 10, 'sayıldığı anda raf kaydı 10');
  assert.strictEqual(l101.fark, 0, 'sayım rafta fark bulmadı');
  assert.strictEqual(l101.catisma, 0);
  assert.ok(o.toplam.canli);
  const u = db.get("SELECT * FROM count_urun WHERE session_id='K1' AND product_id='101'");
  assert.strictEqual(u.durum, 'BEKLIYOR');
  assert.strictEqual(u.ilk_ts, T);
  assert.strictEqual(u.son_ts, T + 10000);
});

test('terminal saati sunucudan farklıysa anlar sunucu saatine çevrilir', () => {
  yeniDilim();
  oturum('K2');
  const saat = 3600 * 1000; // terminal 1 saat ileri
  koy('104', 'A-02', 12);
  assert.ok(gonder('PICK', { productId: '104', shelf: 'A-02', qty: 2, depot: 1 }, T + 20000, { saat })[0].ok);
  const r = gonder('COUNT_SUBMIT', {
    sessionId: 'K2', no: 'K2', depot: 1, shelves: ['A-02'],
    shelfTimes: [{ shelf: 'A-02', start: T + saat, end: T + 5000 + saat }],
    lines: [{ shelf: 'A-02', productId: '104', system: 12, counted: 11, at: T + 5000 + saat }],
  }, T + 60000, { saat });
  assert.ok(r[0].ok, r[0].error);
  assert.strictEqual(depo.miktar(1, '104', 'A-02'), 9, 'sayılan 11 − sonra alınan 2');
  const m = db.get("SELECT fiili_ts FROM movement WHERE kind='PICK' AND product_id='104' ORDER BY id DESC LIMIT 1");
  assert.ok(Math.abs(m.fiili_ts - (T + 20000)) < 2000, 'hareketin fiili anı sunucu saatiyle');
});

test('eski terminal (zaman bilgisi yok): raf okutulana eşitlenir, dondurma zamansız', () => {
  yeniDilim();
  oturum('K3');
  koy('104', 'B-01', 8);
  const r = depo.islemler('TRM-OLD', 'ali', [{ id: 'eski-1', type: 'COUNT_SUBMIT', createdAt: Date.now(), payload: {
    sessionId: 'K3', no: 'K3', depot: 1, shelves: ['B-01'], lines: [{ shelf: 'B-01', productId: '104', system: 8, counted: 6 }],
  } }]);
  assert.ok(r[0].ok);
  assert.strictEqual(depo.miktar(1, '104', 'B-01'), 6);
  assert.strictEqual(db.get("SELECT zamanli FROM count_urun WHERE session_id='K3'").zamanli, 0);
  assert.strictEqual(db.get("SELECT ref_ts FROM count_line WHERE session_id='K3'").ref_ts, null);
});

test('Vega farkı sayım anında dondurulur: sayımdan sonraki satış farka girmez, belirsiz ara hareket işaretlenir', async () => {
  yeniDilim();
  db.run("DELETE FROM count_session WHERE id IN ('K1','K2','K3')");
  db.run("DELETE FROM count_urun");
  db.run("DELETE FROM vega_filigran");
  // Sayım D1: 101 tek rafta (A-01) sayıldı. 104 iki rafta farklı saatlerde sayıldı (A-02 erken, B-01 geç).
  koy('101', 'A-01', 10);
  koy('104', 'A-02', 12);
  koy('104', 'B-01', 8);
  koy('103', 'A-01', 0);
  koy('102', 'A-01', 0);
  db.run("INSERT INTO vega_filigran(at, ind) VALUES(?, 500), (?, 540)", T - 100000, T + 100000);
  oturum('D1');
  const r = gonder('COUNT_SUBMIT', {
    sessionId: 'D1', no: 'D1', depot: 1, shelves: ['A-01', 'A-02', 'B-01'],
    shelfTimes: [
      { shelf: 'A-01', start: T, end: T + 10000 },
      { shelf: 'A-02', start: T + 20000, end: T + 30000 },
      { shelf: 'B-01', start: T + 200000, end: T + 210000 },
    ],
    lines: [
      { shelf: 'A-01', productId: '101', system: 10, counted: 10, at: T + 10000 },
      { shelf: 'A-02', productId: '104', system: 12, counted: 12, at: T + 30000 },
      { shelf: 'B-01', productId: '104', system: 8, counted: 8, at: T + 210000 },
    ],
  }, T + 300000);
  assert.ok(r[0].ok, r[0].error);
  // Gönderimden sonraki Vega okuması: 101'den sayımdan sonra 2 satıldı (raftan alınmadan), 104'ten iki rafın sayımı arasında 3 satıldı,
  // 101'e sayımdan sonra 5 alış faturası girdi (rafa bekleyen değil; bekleyenden bağımsız nötr tür olduğu için yalnız Vega'da görünür).
  goruntu({ 101: 8, 104: 17 }, 600);
  const eski = vega.sayimHareketleri;
  let sorgu = null;
  vega.sayimHareketleri = async (cfg, x) => {
    sorgu = x;
    return [
      { stokno: '101', ind: 505, tip: 21, miktar: -2 }, // sayımdan sonra (wSon=500) satış
      { stokno: '104', ind: 520, tip: 101, miktar: -3 }, // A-02 (wIlk=500) ile B-01 (wSon=540) arasında perakende satış
      { stokno: '104', ind: 560, tip: 21, miktar: 0 },
    ];
  };
  try {
    assert.strictEqual(await depo.sayimDondur(), 2);
  } finally {
    vega.sayimHareketleri = eski;
  }
  assert.deepStrictEqual(sorgu.depo, [1]);
  assert.strictEqual(sorgu.altInd, 500);
  assert.strictEqual(sorgu.ustInd, 600);
  const o = depo.sayimOzet('D1');
  const u101 = o.urunler.find((u) => u.productId === '101');
  // q = raf 10 − Vega 8 = +2; sayımdan sonraki satış −2 düzeltilir → fark 0 (onay anındaki hesap +2 derdi).
  assert.strictEqual(u101.farkSimdi, 2);
  assert.strictEqual(u101.donmus, true);
  assert.strictEqual(u101.duzeltme, -2);
  assert.strictEqual(u101.fark, 0);
  assert.strictEqual(u101.kontrol, false);
  const u104 = o.urunler.find((u) => u.productId === '104');
  // 104: raf 20, Vega 17 → q +3; 3 adet A-02 ile B-01 sayımı arasında satıldı: hangi raftan bilinmiyor → elle bak.
  assert.strictEqual(u104.fark, 3);
  assert.strictEqual(u104.belirsiz, -3);
  assert.strictEqual(u104.kontrol, true);
  assert.strictEqual(o.toplam.kontrol, 1);

  // Onay: dondurulmuş fark yazılır; sonradan Vega'da yeni satış olsa da fişe girmez.
  goruntu({ 101: 1, 104: 10 }, 700);
  const eskiYaz = vega.sayimYaz;
  let kalemler = null;
  vega.sayimYaz = async (cfg, k) => {
    kalemler = k;
    return { docs: [], lines: [] };
  };
  try {
    await depo.sayimOnayla('D1', { vegaYaz: true, stoknolar: ['101', '104'] });
  } finally {
    vega.sayimYaz = eskiYaz;
  }
  assert.deepStrictEqual(kalemler.sort((a, b) => a.stokno - b.stokno), [{ stokno: 101, fark: 0 }, { stokno: 104, fark: 3 }]);
});

test('sayım raftan alma ile eşleşen satışı düzeltmez; gönderimden önceki Vega okuması dondurmaz', async () => {
  yeniDilim();
  db.run("DELETE FROM vega_filigran");
  koy('101', 'A-01', 10);
  db.run("INSERT INTO vega_filigran(at, ind) VALUES(?, 800)", T - 100000);
  oturum('D2');
  // Sayıldıktan sonra 2 adet raftan alındı (PICK) ve Vega'da satış kesildi: raf ve Vega birlikte düştü, fark yok.
  assert.ok(gonder('PICK', { productId: '101', shelf: 'A-01', qty: 2, depot: 1 }, T + 20000)[0].ok);
  const r = gonder('COUNT_SUBMIT', {
    sessionId: 'D2', no: 'D2', depot: 1, shelves: ['A-01'],
    shelfTimes: [{ shelf: 'A-01', start: T, end: T + 10000 }],
    lines: [{ shelf: 'A-01', productId: '101', system: 10, counted: 10, at: T + 10000 }],
  }, T + 60000);
  assert.ok(r[0].ok, r[0].error);
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 8);
  // Gönderimden önce başlamış okuma (filigranAt eski) dondurmaz.
  goruntu({ 101: 8 }, 810, Date.now() - 60000);
  const eski = vega.sayimHareketleri;
  vega.sayimHareketleri = async () => [{ stokno: '101', ind: 805, tip: 21, miktar: -2 }];
  try {
    assert.strictEqual(await depo.sayimDondur(), 0);
    goruntu({ 101: 8 }, 810);
    assert.strictEqual(await depo.sayimDondur(), 1);
  } finally {
    vega.sayimHareketleri = eski;
  }
  const u = depo.sayimOzet('D2').urunler.find((x) => x.productId === '101');
  // q = 8 − 8 = 0; sonraki Vega −2, raf −2 → düzeltme 0.
  assert.strictEqual(u.fark, 0);
  assert.strictEqual(u.duzeltme, 0);
  assert.strictEqual(u.kontrol, false);
});

test('sayım saatine ait Vega okuması yoksa fark dondurulur ama elle bakılacak işaretlenir', async () => {
  yeniDilim();
  db.run("DELETE FROM vega_filigran");
  oturum('D3');
  koy('103', 'B-01', 4);
  const r = gonder('COUNT_SUBMIT', {
    sessionId: 'D3', no: 'D3', depot: 1, shelves: ['B-01'],
    shelfTimes: [{ shelf: 'B-01', start: T, end: T + 10000 }],
    lines: [{ shelf: 'B-01', productId: '103', system: 4, counted: 5, at: T + 10000 }],
  }, T + 60000);
  assert.ok(r[0].ok);
  goruntu({ 103: 4 }, 900);
  await depo.sayimDondur();
  // B-01'de önceki testten kalan 104 de okutulmadığı için bu sayımda 0 sayıldı; o da dondurulur.
  assert.strictEqual(db.get("SELECT durum FROM count_urun WHERE session_id='D3' AND product_id='104'").durum, 'TAMAM');
  const u = depo.sayimOzet('D3').urunler.find((x) => x.productId === '103');
  assert.strictEqual(u.fark, 1);
  assert.strictEqual(u.belirsiz, null);
  assert.strictEqual(u.kontrol, true);
  assert.match(u.donmaDetay.neden, /Vega okuması yok/);
});
