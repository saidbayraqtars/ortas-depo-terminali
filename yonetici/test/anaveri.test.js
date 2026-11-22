// Ana veri artımlı kurulur (depo.js "Ana veri, artımlı"): her değişiklikte 130 bin ürün baştan kurulmaz, yalnız değişen
// bileşen yenilenir. Bu test artımlı sonucun baştan kurulanla (masterParcalariTam) BAYT BAYT aynı olduğunu sınar: özet bir kez
// bile farklı çıkarsa eski terminaller bütün ana veriyi yeniden indirir. v3'te kova b (kart), l (raf stoku), h (raf adresi) olur.
// Vega'sız; görüntü elle verilir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-anaveri-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 }, urun: { kapsam: 'aktif', gun: 365 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Tekrarlanabilir rastgele.
let tohum = 12345;
const rast = (n) => {
  tohum = (Math.imul(tohum, 1103515245) + 12345) >>> 0;
  return tohum % n;
};

const URUN = 900;
const urunler = Array.from({ length: URUN }, (_, i) => ({
  id: String(1000 + i * 7),
  code: `K-${i}`,
  name: i % 13 === 0 ? `Ürün ${i} "tırnaklı" İŞÖ` : `Ürün ${i}`,
  unit: i % 5 ? 'Adet' : 'Takım',
  ...(i % 17 === 0 ? { pasif: true } : {}),
}));
const barkodlar = Object.fromEntries(urunler.filter((_, i) => i % 3 === 0).map((p, i) => [p.id, [`869${p.id}9`, `869${p.id}1`].slice(0, 1 + (i % 2))]));
let stok = { 1: {}, 5: {} };
for (const p of urunler) if (rast(3)) stok[1 + 4 * rast(2)][p.id] = 1 + rast(40);
let hareketli = urunler.filter(() => rast(4) === 0).map((p) => p.id);
let belgeler = [
  { id: 'F-1', izahat: '20', tur: 'Alış faturası', docNo: 'FAT-1', supplier: 'Tedarikçi', date: '05.11.2026', ts: Date.now(), depo: 1, depoAd: 'MERKEZ', lines: urunler.slice(0, 40).map((p) => ({ id: `F-1-${p.id}`, productId: p.id, accepted: 10 })) },
];

/** Vega görüntüsü; `kart` false ise ürün ve barkod dizileri aynı kalır (kartlar yeniden okunmadı). */
const kur = () =>
  depo._goruntuKur({
    surum: 2, at: Date.now(), depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 5, ad: 'TOYBELEN' }],
    products: urunler, stock: stok, moved: hareketli, barcodes: barkodlar, receipts: belgeler,
  });
kur();
const RAFLAR = Array.from({ length: 30 }, (_, i) => `A-${String(i).padStart(2, '0')}`);
for (const d of [1, 5]) for (const r of RAFLAR) depo.rafEkle(d, r);

let n = 0;
const islem = (type, payload) => {
  const r = depo.islemler('TRM-01', 'ali', [{ id: `av-${++n}`, type, createdAt: Date.now(), payload: { user: 'ali', device: 'TRM-01', ...payload } }]);
  return r[0];
};

const esit = (ne) => {
  for (const v of [2]) {
    const artimli = depo._masterParcalari(v);
    const tam = depo._masterParcalariTam(v);
    assert.deepStrictEqual([...artimli.keys()], [...tam.keys()], `${ne}: anahtarlar`);
    for (const [k, p] of tam) {
      const a = artimli.get(k);
      if (a.json !== p.json) assert.fail(`${ne}: ${k} parçası farklı\nartımlı: ${a.json.slice(0, 300)}\ntam:     ${p.json.slice(0, 300)}`);
      assert.strictEqual(a.hash, p.hash, `${ne}: ${k} özeti`);
    }
  }
  // v3: b + l + h birleşince v2 kovasıyla aynı içerik; stok ve baş parçalar aynı.
  const v2 = depo._masterParcalari(2);
  const v3 = depo._masterParcalari(3);
  for (let i = 0; i < 64; i++) {
    const b = JSON.parse(v2.get('b' + i).json);
    assert.deepStrictEqual(JSON.parse(v3.get('b' + i).json), { products: b.products }, `${ne}: v3 b${i}`);
    assert.deepStrictEqual(JSON.parse(v3.get('l' + i).json), { locations: b.locations }, `${ne}: v3 l${i}`);
    assert.deepStrictEqual(JSON.parse(v3.get('h' + i).json), { homes: b.homes }, `${ne}: v3 h${i}`);
    assert.strictEqual(v3.get('q' + i).hash, v2.get('q' + i).hash);
  }
  for (const k of ['head', 'shelves']) assert.strictEqual(v3.get(k).hash, v2.get(k).hash);
};

test('artımlı ana veri baştan kurulanla bayt bayt aynı: ilk kurulum', () => {
  esit('ilk');
  // Aynı sayaçta ikinci çağrı aynı nesneyi verir (yeniden kurulmaz).
  assert.strictEqual(depo._masterParcalari(2), depo._masterParcalari(2));
});

test('rafa kaldırma, raftan alma, transfer, raf ekleme, adres ekleme/silme sonrası da aynı', () => {
  for (let tur = 0; tur < 60; tur++) {
    const p = urunler[rast(URUN)];
    const d = 1 + 4 * rast(2);
    const raf = RAFLAR[rast(RAFLAR.length)];
    switch (rast(7)) {
      case 0:
      case 1:
        islem('PUTAWAY', { productId: p.id, shelf: raf, qty: 1 + rast(5), depot: d });
        break;
      case 2:
        islem('PICK', { productId: p.id, shelf: raf, qty: 1 + rast(3), depot: d });
        break;
      case 3:
        islem('TRANSFER', { productId: p.id, from: raf, to: RAFLAR[rast(RAFLAR.length)], qty: 1, depot: d });
        break;
      case 4:
        depo.rafEkle(d, `YENI-${tur}`);
        break;
      case 5:
        depo.zimmetEkle(d, p.id, raf);
        break;
      default: {
        const z = db.get('SELECT depo, product_id, shelf FROM product_home ORDER BY RANDOM() LIMIT 1');
        if (z) depo.zimmetSil(z.depo, z.product_id, z.shelf);
      }
    }
    depo.degisti();
    if (tur % 6 === 0) esit(`tur ${tur}`);
  }
  esit('son');
});

test('Vega stoku, hareketli ürünler, belgeler değişince; ürünü bilinmeyen raf stoku; pasif ürün rafta', () => {
  // Stok değişir, kartlar aynı dizi (kartlar yeniden okunmadı).
  stok = { 1: { ...stok[1] }, 5: { ...stok[5] } };
  for (let i = 0; i < 50; i++) stok[1][urunler[rast(URUN)].id] = rast(3) ? rast(100) : 0;
  hareketli = hareketli.slice(10);
  belgeler = [...belgeler, { id: 'F-2', izahat: '20', tur: 'Alış faturası', docNo: 'FAT-2', supplier: 'B', date: '06.11.2026', ts: Date.now(), depo: 5, depoAd: 'TOYBELEN', lines: urunler.slice(100, 130).map((p) => ({ id: `F-2-${p.id}`, productId: p.id, accepted: 3 })) }];
  kur();
  depo.degisti();
  esit('stok değişti');
  // Vega'da artık olmayan ürünün raf stoku ve adresi (kart silinmiş): raf stoku gider, adresi gitmez.
  db.run("INSERT INTO location(depo, product_id, shelf, qty, updated_at) VALUES(1, '999999', 'A-01', 4, 0)");
  db.run("INSERT INTO product_home(depo, product_id, shelf, source, updated_at) VALUES(1, '999999', 'A-01', 'ADMIN', 0)");
  // Pasif ürün rafta: terminale gider.
  const pasif = urunler.find((p) => p.pasif);
  db.run('INSERT OR REPLACE INTO location(depo, product_id, shelf, qty, updated_at) VALUES(1, ?, ?, 2, 0)', pasif.id, 'A-02');
  depo.degisti();
  esit('bilinmeyen ürün + pasif rafta');
  db.run('DELETE FROM location WHERE product_id=?', pasif.id);
  db.run("UPDATE location SET qty=0 WHERE product_id='999999'");
  depo.degisti();
  esit('pasif raftan kalktı');
});

test('kartlar yeniden okununca (ad, barkod, yeni ürün, silinen ürün) ve kapsam "tüm" olunca da aynı', () => {
  urunler[5] = { ...urunler[5], name: 'Adı değişti' };
  urunler.push({ id: '5', code: 'YENI', name: 'Yeni kart', unit: 'Adet' });
  urunler.splice(20, 3);
  barkodlar[urunler[40].id] = ['111', '000'];
  // Vega okuması yeni dizi verir.
  depo._goruntuKur({ surum: 2, at: Date.now(), depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 5, ad: 'TOYBELEN' }], products: [...urunler], stock: stok, moved: hareketli, barcodes: { ...barkodlar }, receipts: belgeler });
  depo.degisti();
  esit('kartlar değişti');
  config.update({ urun: { kapsam: 'tum', gun: 365 } });
  depo.degisti();
  esit('kapsam tüm');
  config.update({ urun: { kapsam: 'aktif', gun: 365 } });
  depo.degisti();
  esit('kapsam aktif');
});

test('değişmeyen kova yeniden kurulmaz: bir rafa kaldırma yalnız o ürünün kovasını ve head parçasını değiştirir', () => {
  const once = new Map(depo._masterParcalari(3));
  const p = urunler[200];
  assert.ok(islem('PUTAWAY', { productId: p.id, shelf: 'A-05', qty: 2, depot: 1 }).ok);
  const sonra = depo._masterParcalari(3);
  const degisen = [...sonra.keys()].filter((k) => sonra.get(k) !== once.get(k));
  const k = depo.kova(p.id);
  // Ürün A-05'e ilk kez konduysa raf adresi de verilir (h); stok ve kart parçaları aynı nesne kalır.
  assert.ok(degisen.includes('l' + k), degisen.join(','));
  assert.ok(degisen.every((x) => ['head', 'l' + k, 'h' + k].includes(x)), degisen.join(','));
});

test('v3 cevabı: kovanın b, l, h parçaları birlikte bir kova sayılır; stok parçası kovasıyla gelir; güncel terminale boş döner', () => {
  const hepsi = JSON.parse(depo.masterParcaCevabi({}, 64, 3));
  assert.strictEqual(hepsi.remaining, 0);
  assert.strictEqual(hepsi.parts.length, 2 + 64 * 4);
  const bilinen = Object.fromEntries(hepsi.parts.map((x) => [x.key, x.hash]));
  assert.strictEqual(JSON.parse(depo.masterParcaCevabi(bilinen, 8, 3)).parts.length, 0);

  // Boş terminal, 8 kova: 8 × (b, l, h, q) + head + shelves; 56 kova kalır.
  const ilk = JSON.parse(depo.masterParcaCevabi({}, 8, 3));
  assert.strictEqual(ilk.remaining, 56);
  assert.deepStrictEqual(ilk.parts.map((x) => x.key).filter((k) => k[0] === 'q').length, 8);
  assert.strictEqual(ilk.parts.length, 2 + 8 * 4);

  // Yalnız raf stoku değişir: yalnız l parçası (ve head) gelir.
  const p = urunler[300];
  assert.ok(islem('PUTAWAY', { productId: p.id, shelf: 'A-07', qty: 1, depot: 1 }).ok);
  assert.ok(islem('PUTAWAY', { productId: p.id, shelf: 'A-07', qty: 1, depot: 1 }).ok);
  const b2 = Object.fromEntries(JSON.parse(depo.masterParcaCevabi({}, 64, 3)).parts.map((x) => [x.key, x.hash]));
  assert.ok(islem('PUTAWAY', { productId: p.id, shelf: 'A-07', qty: 1, depot: 1 }).ok);
  const fark = JSON.parse(depo.masterParcaCevabi(b2, 8, 3)).parts.map((x) => x.key);
  assert.deepStrictEqual(fark.filter((k) => k !== 'head'), ['l' + depo.kova(p.id)]);

  // Eski (v2) terminale aynı değişiklik bütün kovayı indirir; v2 cevabı eskisiyle aynı kurala uyar.
  const v2 = JSON.parse(depo.masterParcaCevabi({}, 64, 2));
  assert.strictEqual(v2.parts.length, 2 + 64 * 2);
});

test('işlem geri alınırsa (hata) artımlı veri bozulmaz', () => {
  const p = urunler[400];
  assert.throws(() =>
    db.tx(() => {
      db.run('INSERT OR REPLACE INTO location(depo, product_id, shelf, qty, updated_at) VALUES(1, ?, ?, 99, 0)', p.id, 'A-09');
      throw new Error('geri al');
    }),
  );
  depo.degisti();
  esit('geri alınan işlem');
});
