// Rafsız (envanter) sayım (Ortaş İsmail, 2026-11-23: Zincir; Ramazan'da bütün depolar). Raf okutulmaz, raf stoku değişmez;
// ürün başına terminallerin saydığı toplam Vega stokuyla karşılaştırılır. Her terminalin gönderimi kendi öncekinin yerine geçer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-rafsiz-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const vega = require('../server/vega');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const T = Date.now() - 3 * 3600 * 1000;
const goruntu = (stok, filigran, filigranAt = Date.now() + 1) =>
  depo._goruntuKur({
    surum: 2,
    at: Date.now(),
    filigran,
    filigranAt,
    depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 110, ad: 'ZİNCİRDEPO' }],
    products: [
      { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
      { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
      { id: '103', code: 'AN-0040', name: 'Antifriz 4 L', unit: 'Adet' },
    ],
    stock: { 110: stok },
    moved: [],
    barcodes: {},
    receipts: [],
  });
goruntu({ 101: 10, 102: 2, 103: 6 }, 500, T - 200000);
depo.rafEkle(110, 'Z-01');
db.tx(() => depo.miktarAyarla(110, '101', 'Z-01', 10, { kind: 'ADJUST', ts: T - 3600000 }));
db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, created_at, depo) VALUES('R1','SAY-R1','Zincir',1,'RAFSIZ','OPEN','ADMIN',?,110)", T - 600000);

let n = 0;
const gonder = (cihaz, payload, an) =>
  depo.islemler(cihaz, 'ali', [{ id: `r-${++n}`, type: 'COUNT_SUBMIT', createdAt: an, payload: { user: 'ali', device: cihaz, sessionId: 'R1', no: 'SAY-R1', depot: 110, ...payload } }], { sentAt: Date.now() });
const satir = (productId, counted, at) => ({ shelf: 'RAFSIZ', productId, system: 0, counted, at });

test('terminale rafsız olarak gider; raf okutan eski terminalin gönderimi reddedilir', () => {
  const m = JSON.parse(depo.master().json);
  assert.strictEqual(m.counts.find((c) => c.id === 'R1').shelfless, true);
  const r = gonder('TRM-ESKI', { shelves: ['Z-01'], lines: [{ shelf: 'Z-01', productId: '101', system: 10, counted: 3 }] }, T);
  assert.strictEqual(r[0].ok, false);
  assert.match(r[0].error, /rafsız sayım; terminali güncelleyin/);
  assert.strictEqual(depo.miktar(110, '101', 'Z-01'), 10, 'raf stoku değişmedi');
});

test('iki terminalin saydığı toplanır; raf stoku değişmez; fark Vega stokuna göre', () => {
  assert.ok(gonder('TRM-01', { shelfless: true, lines: [satir('101', 4, T + 1000), satir('102', 2, T + 2000)] }, T + 3000)[0].ok);
  assert.ok(gonder('TRM-02', { shelfless: true, lines: [satir('101', 3, T + 5000)] }, T + 6000)[0].ok);
  assert.strictEqual(depo.miktar(110, '101', 'Z-01'), 10, 'rafsız sayım raf stokuna dokunmaz');
  const o = depo.sayimOzet('R1');
  const u = o.urunler.find((x) => x.productId === '101');
  assert.strictEqual(u.sayilan, 7);
  assert.strictEqual(u.hedef, 7);
  assert.strictEqual(u.vegaStock, 10);
  assert.strictEqual(u.fark, -3);
  assert.strictEqual(u.digerRaflar, 0);
  assert.strictEqual(u.bekleyen, 0);
  assert.deepStrictEqual(u.raflar.sort(), ['TRM-01', 'TRM-02']);
  assert.strictEqual(o.urunler.find((x) => x.productId === '102').fark, 0);
  assert.strictEqual(o.toplam.terminal, 2);
  assert.deepStrictEqual(o.raflar, []);
  assert.strictEqual(o.toplam.canli, false);
  assert.ok(o.satirlar.every((l) => l.terminal && l.fark === 0));
});

test('terminal yeniden gönderince yalnız kendi sayısının yerine geçer', () => {
  assert.ok(gonder('TRM-01', { shelfless: true, lines: [satir('101', 5, T + 8000)] }, T + 9000)[0].ok);
  const o = depo.sayimOzet('R1');
  assert.strictEqual(o.urunler.find((x) => x.productId === '101').sayilan, 8, 'TRM-01 5 + TRM-02 3');
  assert.strictEqual(o.urunler.find((x) => x.productId === '102'), undefined, 'TRM-01 artık 102 göndermiyor');
  assert.strictEqual(db.get("SELECT durum FROM count_urun WHERE session_id='R1' AND product_id='102'").durum, 'BEKLIYOR');
});

test('Vega farkı sayım anında dondurulur: sayımdan sonraki satış ve alış farka girmez', async () => {
  db.run('INSERT INTO vega_filigran(at, ind) VALUES(?, 500)', T - 100000);
  // Sayımdan sonra Vega'da: 101'den 1 satış, 4 alış faturası (rafsızda alış da düşülür). Şu anki Vega stoku 13.
  goruntu({ 101: 13, 102: 2, 103: 6 }, 600);
  const eski = vega.sayimHareketleri;
  vega.sayimHareketleri = async () => [
    { stokno: '101', ind: 510, tip: 21, miktar: -1 },
    { stokno: '101', ind: 520, tip: 20, miktar: 4 },
  ];
  try {
    assert.ok((await depo.sayimDondur()) >= 1);
  } finally {
    vega.sayimHareketleri = eski;
  }
  const u = depo.sayimOzet('R1').urunler.find((x) => x.productId === '101');
  assert.strictEqual(u.donmus, true);
  assert.strictEqual(u.farkSimdi, -5, 'şu anki stoka göre 8 − 13');
  assert.strictEqual(u.duzeltme, 3);
  assert.strictEqual(u.fark, -2, 'sayım anındaki Vega 10: 8 − 10');
});

test('sayılmayan stoklu ürün seçilirse 0 sayılır; onayda Vega\'ya fark ve hedef gider', async () => {
  const o = depo.sayimOzet('R1', { dahilSayilmayan: true });
  const u103 = o.urunler.find((x) => x.productId === '103');
  assert.strictEqual(u103.sayilmadi, true);
  assert.strictEqual(u103.hedef, 0);
  assert.strictEqual(u103.fark, -6);
  assert.ok(o.toplam.sayilmadi >= 1);
  const eskiYaz = vega.sayimYaz;
  const eskiDon = vega.sayimHareketleri;
  let kalemler = null;
  let secenek = null;
  vega.sayimYaz = async (cfg, k, s) => {
    kalemler = k;
    secenek = s;
    return { docs: [], lines: [] };
  };
  vega.sayimHareketleri = async () => [];
  try {
    await depo.sayimOnayla('R1', { vegaYaz: true, stoknolar: ['101', '103'], dahilSayilmayan: true });
  } finally {
    vega.sayimYaz = eskiYaz;
    vega.sayimHareketleri = eskiDon;
  }
  assert.deepStrictEqual(kalemler.sort((a, b) => a.stokno - b.stokno), [{ stokno: 101, fark: -2 }, { stokno: 103, hedef: 0 }]);
  assert.strictEqual(secenek.depo, 110);
  assert.strictEqual(db.get("SELECT status FROM count_session WHERE id='R1'").status, 'APPROVED');
  assert.strictEqual(depo.miktar(110, '101', 'Z-01'), 10);
});

test('çakışma uyarısı: aynı ürünü başka terminal saydıysa (gönderdi) ya da sayıyorsa döner, kendi kaydı dönmez', () => {
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, created_at, depo) VALUES('R2','SAY-R2','Çakışma',1,'RAFSIZ','OPEN','ADMIN',?,110)", T);
  assert.ok(gonder('TRM-01', { sessionId: 'R2', no: 'SAY-R2', shelfless: true, lines: [satir('101', 12, T + 1000)] }, T + 2000)[0].ok);
  const a = depo.sayimIzle({ sessionId: 'R2', productId: '101', user: 'veli', device: 'TRM-02' });
  assert.deepStrictEqual(a.baska.map((x) => [x.device, x.durum, x.adet]), [['TRM-01', 'GONDERDI', 12]]);
  assert.deepStrictEqual(depo.sayimIzle({ sessionId: 'R2', productId: '101', user: 'ali', device: 'TRM-01' }).baska.map((x) => [x.device, x.durum]), [['TRM-02', 'SAYIYOR']]);
  assert.deepStrictEqual(depo.sayimIzle({ sessionId: 'R2', productId: '102', user: 'veli', device: 'TRM-02' }).baska, []);
  assert.deepStrictEqual(depo.sayimIzle({ sessionId: 'YOK', productId: '101', device: 'TRM-02' }).baska, []);
});

test('çakışma uyarısı raf sayımında rafa göre', () => {
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, created_at, depo) VALUES('K9','SAY-K9','Raf',1,'RAF','OPEN','ADMIN',?,110)", T);
  db.run("INSERT INTO count_shelf(session_id, shelf, user, device, submitted_at) VALUES('K9','Z-01','ali','TRM-01',?)", T);
  assert.deepStrictEqual(depo.sayimIzle({ sessionId: 'K9', shelf: 'z-01', user: 'veli', device: 'TRM-02' }).baska.map((x) => [x.device, x.durum]), [['TRM-01', 'GONDERDI']]);
  assert.deepStrictEqual(depo.sayimIzle({ sessionId: 'K9', shelf: 'Z-02', user: 'veli', device: 'TRM-02' }).baska, []);
});

test('Excel: stok kodu, sayılan, seçilen depoların Vega stoku ve fark', async () => {
  const ExcelJS = require('exceljs');
  const x = await depo.sayimExcel('R2', { depolar: [1, 110] });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.buf);
  const ws = wb.worksheets[0];
  assert.deepStrictEqual(ws.getRow(2).values.slice(1), ['Stok Kodu', 'Ürün Adı', 'Sayılan Adet', 'MERKEZ', 'ZİNCİRDEPO', 'Fark (ZİNCİRDEPO)']);
  assert.deepStrictEqual(ws.getRow(3).values.slice(1), ['YF-1042', 'Yağ filtresi', 12, 0, 13, -1]);
  const tum = await depo.sayimExcel('R2', {});
  const ws2 = new ExcelJS.Workbook();
  await ws2.xlsx.load(tum.buf);
  assert.deepStrictEqual(ws2.worksheets[0].getRow(2).values.slice(1, 6), ['Stok Kodu', 'Ürün Adı', 'Sayılan Adet', 'MERKEZ', 'ZİNCİRDEPO']);
});
