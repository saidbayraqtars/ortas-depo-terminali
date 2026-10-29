// Paketle gelen B2B raf listesi (iceaktar.otomatik): terminal ürünün adresini yalnız çalışılan depodan okur, bu yüzden
// liste sonradan kullanıma alınan depoya da, ilk çalışmada ürün bulunamadıysa sonradan da aktarılmalı.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-oto-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const iceaktar = require('../server/iceaktar');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const URUNLER = [
  { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
  { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
];
const goruntu = (depolar, products = URUNLER) =>
  depo._goruntuKur({
    surum: 2,
    at: Date.now(),
    depolar: depolar.map((d) => ({ ind: d, ad: `DEPO ${d}` })),
    products,
    stock: {},
    moved: [],
    barcodes: {},
    receipts: [],
  });
const raflar = (d, pid) => depo.zimmetler(d, pid).map((z) => z.shelf);
const dosya = path.join(dir, 'b2b.tsv');
fs.writeFileSync(dosya, 'YF-1042\tA-01-01;Z-09-09\nHF-0310\tB-01-01\n');

test('depo sonradan kullanıma alınınca aynı liste yalnız o depoya aktarılır, eski depolara dokunulmaz', () => {
  db.run('DELETE FROM product_home');
  goruntu([106]);
  const ilk = iceaktar.otomatik({ dosya });
  assert.deepStrictEqual(ilk.depolar, [106]);
  assert.strictEqual(ilk.asilRaf, 3);
  assert.deepStrictEqual(raflar(106, '101'), ['A-01-01', 'Z-09-09']);
  assert.deepStrictEqual(raflar(1, '101'), []);

  // Ortaş: önce yalnız 106 seçiliydi, sonra Merkez (1) ve Toybelen (108) kullanıma alındı.
  goruntu([106, 1, 108]);
  const ikinci = iceaktar.otomatik({ dosya });
  assert.deepStrictEqual(ikinci.depolar, [1, 108]);
  assert.strictEqual(ikinci.asilRaf, 6);
  assert.deepStrictEqual(raflar(1, '101'), ['A-01-01', 'Z-09-09']);
  assert.deepStrictEqual(raflar(108, '102'), ['B-01-01']);
  assert.ok(depo.rafVarMi(1, 'Z-09-09') && depo.rafVarMi(108, 'Z-09-09'));
  // Terminalin okuduğu ana veride adres çalışılan depoda görünür.
  const m = JSON.parse(depo.master().json);
  assert.ok(m.homes.some((h) => h.depot === 1 && h.productId === '101' && h.shelf === 'A-01-01'));

  // Aynı durumda tekrar çağrı bir şey yapmaz.
  assert.strictEqual(iceaktar.otomatik({ dosya }), null);
});

test('terminalden silinen adres, depoda başka IMPORT zimmeti durdukça aynı listeyle geri gelmez', () => {
  db.run("DELETE FROM product_home WHERE depo=1 AND shelf='Z-09-09'");
  goruntu([106, 1, 108, 2]);
  const r = iceaktar.otomatik({ dosya });
  assert.deepStrictEqual(r.depolar, [2]);
  assert.deepStrictEqual(raflar(1, '101'), ['A-01-01']);
  assert.deepStrictEqual(raflar(2, '101'), ['A-01-01', 'Z-09-09']);
});

test('yalnız TERMINAL/ADMIN zimmeti olan depo da listeyi alır (IMPORT yok)', () => {
  db.run('DELETE FROM product_home');
  goruntu([1, 7]);
  const r0 = iceaktar.otomatik({ dosya }); // aynı liste; 1 ve 7'de IMPORT yok → ikisi de alır
  assert.deepStrictEqual(r0.depolar, [1, 7]);
  db.run("DELETE FROM product_home WHERE depo=7");
  depo.zimmetEkle(7, '102', 'C-03-03', 'TERMINAL');
  goruntu([1, 7, 9]);
  const r = iceaktar.otomatik({ dosya });
  assert.deepStrictEqual(r.depolar, [7, 9]);
  assert.deepStrictEqual(raflar(7, '102'), ['B-01-01', 'C-03-03']);
});

test('ilk çalışmada Vega görüntüsünde ürün yoksa liste kaybolmaz: kartlar gelince aktarılır', () => {
  db.run('DELETE FROM product_home');
  const ekUrun = [{ id: '900', code: 'BASKA-1', name: 'Başka', unit: 'Adet' }];
  fs.writeFileSync(dosya, 'YF-1042\tA-01-01\nHF-0310\tB-01-01\nBASKA-1\tK-01-01\n');
  goruntu([1, 2], [{ id: '901', code: 'HIC-ESLESMEZ', name: 'x', unit: 'Adet' }]);
  const bos1 = iceaktar.otomatik({ dosya });
  assert.strictEqual(bos1.asilRaf, 0);
  assert.strictEqual(bos1.bulunamayan, 3);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM product_home').n, 0);

  // Aynı liste, kartlar şimdi görüntüde: imza aynı olsa da hiçbir depoda IMPORT zimmeti olmadığı için aktarılır.
  goruntu([1, 2], URUNLER.concat(ekUrun));
  const sonra = iceaktar.otomatik({ dosya });
  assert.deepStrictEqual(sonra.depolar, [1, 2]);
  assert.strictEqual(sonra.bulunamayan, 0);
  assert.strictEqual(sonra.asilRaf, 6);
  assert.deepStrictEqual(raflar(2, '900'), ['K-01-01']);
});

test('liste aynıyken Vega\'ya sonradan açılan kart eşlenir; terminalden silinen adres geri gelmez', () => {
  db.run('DELETE FROM product_home');
  fs.writeFileSync(dosya, 'YF-1042\tA-01-01;Z-09-09\nYENI-777\tN-01-01\n');
  goruntu([1, 2], URUNLER);
  const ilk = iceaktar.otomatik({ dosya });
  assert.strictEqual(ilk.bulunamayan, 1);
  assert.deepStrictEqual(raflar(1, '555'), []);

  // İsmail terminalden YF-1042'nin Z-09-09 adresini 1. depoda sildi.
  db.run("DELETE FROM product_home WHERE depo=1 AND product_id='101' AND shelf='Z-09-09'");
  // Kart Vega'da açıldı (kart sayısı değişti).
  goruntu([1, 2], URUNLER.concat([{ id: '555', code: 'YENI-777', name: 'Yeni kart', unit: 'Adet' }]));
  const r = iceaktar.otomatik({ dosya });
  assert.strictEqual(r.tamamlanan, 2); // 1 adres × 2 depo
  assert.deepStrictEqual(raflar(1, '555'), ['N-01-01']);
  assert.deepStrictEqual(raflar(2, '555'), ['N-01-01']);
  assert.deepStrictEqual(raflar(1, '101'), ['A-01-01']);
  assert.deepStrictEqual(raflar(2, '101'), ['A-01-01', 'Z-09-09']);
  assert.strictEqual(r.bulunamayan, 0);
  // Yeniden çağrı (örn. yönetici yeniden başlayınca) bir şey eklemez.
  assert.strictEqual(iceaktar.otomatik({ dosya }), null);
});

test('aynı kodlu birden çok kart: asıl raf hepsine yazılır, miktarlı satır tek karta', () => {
  db.run('DELETE FROM product_home');
  fs.writeFileSync(dosya, 'PSB-53205\tP-01-01\n');
  const kartlar = URUNLER.concat([
    { id: '301', code: 'PSB-53205', name: 'Eski kart', unit: 'Adet' },
    { id: '302', code: 'PSB53205', name: 'Yeni kart', unit: 'Adet' },
    { id: '303', code: 'PSB-53205\n\n', name: 'Satır sonlu kopya', unit: 'Adet' },
  ]);
  goruntu([1], kartlar);
  const r = iceaktar.otomatik({ dosya });
  assert.strictEqual(r.asilRaf, 3);
  for (const id of ['301', '302', '303']) assert.deepStrictEqual(raflar(1, id), ['P-01-01'], id);
  // Elle içe aktarmada miktar tek karta gider (aynı kodlularda sonuncu), asıl raf hepsine.
  const miktarli = iceaktar.coz({ satirlar: [['PSB-53205', 'X-01-01', '3']], eslesme: { urun: 0, raf: 1, miktar: 2 }, sabitDepo: 1 });
  assert.deepStrictEqual(miktarli.satirlar.map((s) => s.productId), ['303']);
});

test('eski kurulum (eşleşmeyen kaydı yok): aynı listede adres almamış kart bir kez tamamlanır, silinen adres geri gelmez', () => {
  db.run('DELETE FROM product_home');
  fs.writeFileSync(dosya, 'PSB-53205\tP-01-01\nYF-1042\tA-01-01;Z-09-09\n');
  const kartlar = URUNLER.concat([
    { id: '301', code: 'PSB-53205', name: 'Eski kart', unit: 'Adet' },
    { id: '302', code: 'PSB53205', name: 'Yeni kart', unit: 'Adet' },
  ]);
  goruntu([1], kartlar);
  iceaktar.otomatik({ dosya });
  // 1.8.0'daki gibi: yalnız son kart adres almış, eşleşmeyen kaydı yok; İsmail YF-1042'nin Z-09-09'unu silmiş.
  db.run("DELETE FROM product_home WHERE product_id='301'");
  db.run("DELETE FROM product_home WHERE product_id='101' AND shelf='Z-09-09'");
  db.run("DELETE FROM meta WHERE key='b2bOtoAktarimEslesmeyen'");
  goruntu([1, 5], kartlar); // yeni depo 5 de kullanılıyor → tarama tetiklenir (depo 5'e liste, depo 1'e eksikler)
  const r = iceaktar.otomatik({ dosya });
  assert.deepStrictEqual(r.depolar, [5]);
  assert.deepStrictEqual(raflar(1, '301'), ['P-01-01']);
  assert.deepStrictEqual(raflar(1, '101'), ['A-01-01']);
  assert.deepStrictEqual(raflar(5, '101'), ['A-01-01', 'Z-09-09']);
});
