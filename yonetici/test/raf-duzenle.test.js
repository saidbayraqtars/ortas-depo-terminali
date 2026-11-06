// Yönetici: terminalde "Raf Düzenle" (SHELF_ARRANGE). Rafta duran mal rafa tanımlanır; sayım oturumu açılmaz, onay beklenmez,
// Vega'ya yazılmaz. Vega'sız; görüntü elle verilir. İki depo: 1 MERKEZ, 108 TOYBELEN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-rafduzenle-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const yetki = require('../server/yetki');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

depo._goruntuKur({
  surum: 2,
  at: Date.now(),
  depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 108, ad: 'TOYBELEN' }],
  products: [
    { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
    { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
    { id: '103', code: 'AN-0040', name: 'Antifriz 4 L', unit: 'Adet' },
  ],
  stock: { 1: { 101: 40, 102: 10, 103: 5 }, 108: { 101: 6 } },
  moved: [],
  barcodes: {},
  receipts: [],
});
for (const r of ['A-01-01', 'A-01-02', 'B-01-01']) depo.rafEkle(1, r);
depo.rafEkle(108, 'T-01-01');

let n = 0;
const op = (type, user, payload, createdAt = Date.now()) => ({ id: `rd-${++n}`, type, createdAt, payload: { user, device: 'TRM-01', ...payload } });
const duzenle = (user, payload, createdAt) => op('SHELF_ARRANGE', user, { no: 'RD-T1', depot: 1, ...payload }, createdAt);
const satir = (shelf, productId, counted, system = 0) => ({ shelf, productId, system, counted });
const kullanici = (ad, izinler, depolar = '*') =>
  db.run('INSERT INTO app_user(username, name, salt, pin_hash, active, created_at, perms, depots) VALUES(?,?,?,?,1,0,?,?)', ad, ad, 's', 'h', izinler, depolar);

test('rafta duran mal rafa tanımlanır: raf stoku okutulana çekilir, adresi olmayan ürünün adresi o raf olur', () => {
  const r = depo.islemler('TRM-01', 'ali', [
    duzenle('ali', { shelves: ['A-01-01'], lines: [satir('A-01-01', '101', 25), satir('A-01-01', '102', 4)] }),
  ]);
  assert.deepStrictEqual(r.map((x) => x.ok), [true], JSON.stringify(r));
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 25);
  assert.strictEqual(depo.miktar(1, '102', 'A-01-01'), 4);
  assert.deepStrictEqual(depo.zimmetler(1, '101').map((z) => [z.shelf, z.source]), [['A-01-01', 'TERMINAL']]);
  assert.ok(depo.zimmetler(1, '102').some((z) => z.shelf === 'A-01-01'));
  // Hareket "Raf düzenleme" türünde, kullanıcı ve cihazla yazılır.
  const h = db.get("SELECT * FROM movement WHERE kind='ARRANGE' AND product_id='101' ORDER BY id DESC");
  assert.strictEqual(h.delta, 25);
  assert.strictEqual(h.after, 25);
  assert.strictEqual(h.user, 'ali');
  assert.strictEqual(h.device, 'TRM-01');
  assert.strictEqual(h.ref, 'RD-T1');
});

test('sayım gibi sayım oturumu açmaz, onay beklemez, Vega fişi için kayıt tutmaz', () => {
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM count_session').n, 0);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM count_line').n, 0);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM count_shelf').n, 0);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM transfer').n, 0);
  // Sayım olsaydı sunucu "olması gereken" hesabını kendi raf stokundan yapardı; Vega stoku olduğu gibi kalır.
  assert.strictEqual(depo.vegaStok('101', 1), 40);
  assert.strictEqual(db.get('SELECT ok FROM op WHERE id=?', 'rd-1').ok, 1);
});

test('rafta olup okutulmayan ürün raftan çıkar, çıkınca terminal adresi de kalkar; boş raf işaretlenebilir', () => {
  const r = depo.islemler('TRM-01', 'ali', [
    duzenle('ali', { shelves: ['A-01-01'], lines: [satir('A-01-01', '101', 20, 25)] }, Date.now() + 1000),
  ]);
  assert.ok(r[0].ok);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 20);
  assert.strictEqual(depo.miktar(1, '102', 'A-01-01'), 0, 'okutulmayan 102 raftan çıktı');
  assert.ok(!depo.zimmetler(1, '102').some((z) => z.shelf === 'A-01-01'));
  assert.ok(depo.zimmetler(1, '101').some((z) => z.shelf === 'A-01-01'));
  // Boş raf: satır yok, yalnız raf gönderilir; raftaki her şey çıkar.
  const bos = depo.islemler('TRM-01', 'ali', [duzenle('ali', { shelves: ['A-01-01'], lines: [] }, Date.now() + 2000)]);
  assert.ok(bos[0].ok);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 0);
  assert.ok(!depo.zimmetler(1, '101').some((z) => z.shelf === 'A-01-01'));
});

test('ürünün başka adresi varsa o da korunur, düzenlenen raf ek adres olur (Vega kartına yazılan adres); Excel/yönetici adresi raf boşalınca silinmez', () => {
  db.run('DELETE FROM product_home');
  depo.zimmetEkle(1, '103', 'B-01-01', 'IMPORT');
  depo.islemler('TRM-01', 'ali', [duzenle('ali', { shelves: ['A-01-02'], lines: [satir('A-01-02', '103', 3)] }, Date.now() + 3000)]);
  assert.strictEqual(depo.miktar(1, '103', 'A-01-02'), 3);
  assert.deepStrictEqual(
    depo.zimmetler(1, '103').map((z) => [z.shelf, z.source]),
    [['A-01-02', 'TERMINAL'], ['B-01-01', 'IMPORT']],
    'adresi olan ürüne de düzenlenen raf adres olur (Toybelen: B2B liste kopyası her ürüne adres vermişti, Vega\'ya yazılmıyordu)',
  );
  depo.islemler('TRM-01', 'ali', [duzenle('ali', { shelves: ['B-01-01'], lines: [] }, Date.now() + 4000)]);
  assert.deepStrictEqual(depo.zimmetler(1, '103').map((z) => z.shelf), ['A-01-02', 'B-01-01'], 'IMPORT adresi raf boş sayılınca silinmez');
  // Düzenlenen raf sonradan boşaltılırsa yalnız terminalden gelen adres kalkar.
  depo.islemler('TRM-01', 'ali', [duzenle('ali', { shelves: ['A-01-02'], lines: [] }, Date.now() + 4500)]);
  assert.deepStrictEqual(depo.zimmetler(1, '103').map((z) => z.shelf), ['B-01-01']);
});

test('Toybelen: B2B liste kopyası adres verse de Raf Düzenle ile konan raf Vega kartına yazılacak adrese (product_home) girer', () => {
  db.run('DELETE FROM product_home');
  depo.zimmetEkle(108, '101', 'A-LISTE-1', 'IMPORT');
  depo.zimmetEkle(1, '101', 'A-LISTE-1', 'IMPORT');
  const r = depo.islemler('TRM-01', 'ali', [
    op('SHELF_ARRANGE', 'ali', { no: 'RD-T9', depot: 108, shelves: ['T-01-01'], lines: [satir('T-01-01', '101', 4)] }, Date.now() + 5200),
  ]);
  assert.ok(r[0].ok, JSON.stringify(r));
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), 4);
  // rafYazCalistir tüm depoların product_home kayıtlarını birleştirir: T-01-01 listeye girmiş olmalı.
  const yazilacak = db.all('SELECT DISTINCT shelf FROM product_home WHERE product_id=? ORDER BY shelf', '101').map((z) => z.shelf);
  assert.deepStrictEqual(yazilacak, ['A-LISTE-1', 'T-01-01']);
});

test('açılışta bir kez: eskiden adres almamış Raf Düzenle rafları adreslenir; silinmiş adrese, boşalmış rafa dokunulmaz', () => {
  // Önceki testlerin raf stoku ve hareketleri karışmasın.
  db.run('DELETE FROM product_home');
  db.run('DELETE FROM location');
  db.run('DELETE FROM movement');
  // Eski davranışı kur: ürünün Merkez'de başka adresi var; düzenleme rafı adres yapmamış.
  depo.zimmetEkle(1, '102', 'B-01-01', 'IMPORT');
  depo.zimmetEkle(1, '103', 'B-01-01', 'IMPORT');
  depo.zimmetEkle(1, '101', 'B-01-01', 'IMPORT');
  db.tx(() => {
    depo.miktarAyarla(1, '102', 'A-01-01', 6, { kind: 'ARRANGE', ref: 'RD-ESKI' });
    depo.miktarAyarla(1, '103', 'A-01-01', 2, { kind: 'ARRANGE', ref: 'RD-ESKI' });
    depo.miktarAyarla(1, '101', 'A-01-01', 5, { kind: 'ARRANGE', ref: 'RD-ESKI' });
    depo.miktarAyarla(1, '101', 'A-01-01', 0, { kind: 'ARRANGE', ref: 'RD-ESKI' }); // sonradan boşaltılmış
  });
  // 103: terminalden bu adres bilinçli silinmiş.
  db.run("INSERT INTO op(id, type, payload, device, user, created_at, received_at, ok) VALUES('rd-sil','HOME_REMOVE',?, 'TRM-01','ali',1,1,1)", JSON.stringify({ productId: '103', shelf: 'A-01-01', depot: 1 }));
  db.run("DELETE FROM meta WHERE key='rafDuzenleAdres'");
  assert.strictEqual(depo.rafDuzenleAdresleri(), 1);
  assert.deepStrictEqual(depo.zimmetler(1, '102').map((z) => [z.shelf, z.source]), [['A-01-01', 'TERMINAL'], ['B-01-01', 'IMPORT']]);
  assert.deepStrictEqual(depo.zimmetler(1, '103').map((z) => z.shelf), ['B-01-01'], 'silinmiş adres geri gelmez');
  assert.deepStrictEqual(depo.zimmetler(1, '101').map((z) => z.shelf), ['B-01-01'], 'boşalmış rafa adres verilmez');
  // İkinci kez çalışmaz.
  db.run("DELETE FROM product_home WHERE shelf='A-01-01'");
  assert.strictEqual(depo.rafDuzenleAdresleri(), 0);
});

test('tanımsız raf açılır, birden çok raf bir gönderimde düzenlenir, bilinmeyen ürün satırı atlanır', () => {
  const r = depo.islemler('TRM-01', 'ali', [
    duzenle('ali', {
      shelves: ['z-09', 'B-01-01'],
      lines: [satir('z-09', '101', 2), satir('B-01-01', '102', 7), satir('B-01-01', 'YOK-9', 5)],
    }, Date.now() + 5000),
  ]);
  assert.ok(r[0].ok, JSON.stringify(r));
  assert.ok(depo.rafVarMi(1, 'Z-09'));
  assert.strictEqual(depo.miktar(1, '101', 'Z-09'), 2);
  assert.strictEqual(depo.miktar(1, '102', 'B-01-01'), 7);
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM location WHERE product_id='YOK-9'").n, 0);
  assert.strictEqual(db.get("SELECT source FROM shelf WHERE depo=1 AND code='Z-09'").source, 'TERMINAL');
});

test('okutma sonrası başka terminalin rafa koyduğu mal silinmez; öncekiler okutulmadıysa 0 kabul edilir', () => {
  const t0 = Date.now();
  depo.islemler('TRM-01', 'ali', [op('PUTAWAY', 'ali', { productId: '102', shelf: 'A-01-02', qty: 4, depot: 1 }, t0)]);
  // Düzenleme t0'dan önce başlamış (createdAt eski): sonradan rafa konan 102'ye dokunulmaz.
  depo.islemler('TRM-02', 'veli', [duzenle('veli', { shelves: ['A-01-02'], lines: [satir('A-01-02', '103', 1)] }, t0 - 60_000)]);
  assert.strictEqual(depo.miktar(1, '102', 'A-01-02'), 4);
  assert.strictEqual(depo.miktar(1, '103', 'A-01-02'), 1);
});

test('aynı işlem kimliği ikinci kez gelirse yeniden işlenmez', () => {
  const o = duzenle('ali', { shelves: ['B-01-01'], lines: [satir('B-01-01', '101', 9)] }, Date.now() + 6000);
  depo.islemler('TRM-01', 'ali', [o]);
  const onceki = db.get("SELECT COUNT(*) AS n FROM movement WHERE kind='ARRANGE'").n;
  // Terminal aynı işlemi tekrar yollar (cevap kayboldu); bu arada raf başka yolla değişmiş olsa bile ezilmez.
  depo.miktarAyarla(1, '101', 'B-01-01', 3, { ts: Date.now(), kind: 'ADJUST' });
  const r = depo.islemler('TRM-01', 'ali', [o]);
  assert.deepStrictEqual(r, [{ id: o.id, ok: true }]);
  assert.strictEqual(depo.miktar(1, '101', 'B-01-01'), 3);
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM movement WHERE kind='ARRANGE'").n, onceki);
});

test('hatalı gönderim kalıcı ret alır: raf yok, geçersiz raf kodu, geçersiz miktar', () => {
  const r = depo.islemler('TRM-01', 'ali', [
    duzenle('ali', { shelves: [], lines: [] }),
    duzenle('ali', { shelves: ['.;X'], lines: [] }),
    duzenle('ali', { shelves: ['A-01-01'], lines: [satir('A-01-01', '101', 'abc')] }),
  ]);
  assert.deepStrictEqual(r.map((x) => x.ok), [false, false, false]);
  assert.match(r[0].error, /Düzenlenecek raf yok/);
  assert.match(r[1].error, /Geçersiz raf kodu/);
  assert.match(r[2].error, /Sayılan geçersiz/);
});

test('yetki: raf düzenle izni ister (code YETKI), depo sınırına uyar; izin katalogda ve depo görevlisi şablonunda', () => {
  kullanici('okur', 'pick');
  kullanici('duzenci', 'shelf_arrange');
  kullanici('toy', 'shelf_arrange', '108');
  const once = depo.miktar(1, '101', 'A-01-01');

  let r = depo.islemler('TRM-01', 'okur', [duzenle('okur', { shelves: ['A-01-01'], lines: [satir('A-01-01', '101', 11)] }, Date.now() + 7000)]);
  assert.deepStrictEqual([r[0].ok, r[0].code], [false, 'YETKI']);
  assert.match(r[0].error, /"Raf düzenle" yetkisi yok/);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), once, 'reddedilen düzenleme uygulanmadı');

  r = depo.islemler('TRM-01', 'duzenci', [duzenle('duzenci', { shelves: ['A-01-01'], lines: [satir('A-01-01', '101', 11)] }, Date.now() + 8000)]);
  assert.strictEqual(r[0].ok, true, JSON.stringify(r));
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 11);

  // Toybelen kullanıcısı Merkez rafını düzenleyemez, kendi deposunu düzenler.
  r = depo.islemler('TRM-05', 'toy', [
    duzenle('toy', { depot: 1, shelves: ['A-01-01'], lines: [satir('A-01-01', '101', 1)] }, Date.now() + 9000),
    duzenle('toy', { depot: 108, shelves: ['T-01-01'], lines: [satir('T-01-01', '101', 6)] }, Date.now() + 9500),
  ]);
  assert.deepStrictEqual(r.map((x) => [x.ok, x.code]), [[false, 'YETKI'], [true, undefined]]);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 11, 'Merkez rafı değişmedi');
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), 6);

  assert.ok(yetki.IZINLER.some((i) => i.id === 'shelf_arrange' && i.grup === 'Raf işlemleri'));
  assert.ok(yetki.SABLONLAR.find((s) => s.id === 'depocu').izinler.includes('shelf_arrange'));
  assert.strictEqual(yetki.ISLEM_IZNI.SHELF_ARRANGE, 'shelf_arrange');
});

test('düzenleme ana veriye yansır: terminal bir sonraki eşitlemede yeni raf stokunu alır', () => {
  const m = JSON.parse(depo.master().json);
  const yer = m.locations.find((l) => l.productId === '101' && l.shelf === 'B-01-01');
  assert.ok(yer, 'B-01-01 konumu ana veride');
  assert.strictEqual(yer.qty, 3);
});

test('"okutulmayana dokunma" modu: okutulan ürün rafa yazılır, rafta duran diğer ürünler yerinde kalır; satırsız (boş) raf yine boşalır', () => {
  depo.rafEkle(1, 'K-KEEP');
  const kur = () => {
    depo.miktarAyarla(1, '101', 'K-KEEP', 5, { ts: 1, kind: 'PUTAWAY' });
    depo.miktarAyarla(1, '102', 'K-KEEP', 3, { ts: 1, kind: 'PUTAWAY' });
  };
  kur();
  // İade gelen tek ürün (103) dolu rafa tanımlanır: diğerleri silinmez.
  let r = depo.islemler('TRM-01', 'ali', [duzenle('ali', { keepOthers: true, shelves: ['K-KEEP'], lines: [satir('K-KEEP', '103', 1)] }, Date.now() + 10000)]);
  assert.ok(r[0].ok, JSON.stringify(r));
  assert.deepStrictEqual(['101', '102', '103'].map((p) => depo.miktar(1, p, 'K-KEEP')), [5, 3, 1]);
  // Okutulan ürünün miktarı yine okutulana eşitlenir (iki ürün okutuldu, üçüncüye dokunulmadı).
  r = depo.islemler('TRM-01', 'ali', [duzenle('ali', { keepOthers: true, shelves: ['K-KEEP'], lines: [satir('K-KEEP', '101', 8, 5), satir('K-KEEP', '103', 0, 1)] }, Date.now() + 11000)]);
  assert.ok(r[0].ok);
  assert.deepStrictEqual(['101', '102', '103'].map((p) => depo.miktar(1, p, 'K-KEEP')), [8, 3, 0], 'açıkça 0 yazılan çıkar, okutulmayan 102 kalır');
  // Eski terminal / mod kapalı: alan yok, raf okutulana eşitlenir (102 çıkar).
  r = depo.islemler('TRM-01', 'ali', [duzenle('ali', { shelves: ['K-KEEP'], lines: [satir('K-KEEP', '101', 8, 8)] }, Date.now() + 12000)]);
  assert.ok(r[0].ok);
  assert.deepStrictEqual(['101', '102'].map((p) => depo.miktar(1, p, 'K-KEEP')), [8, 0]);
  // "Raf boş" bildirimi (satır yok) mod açıkken de rafı boşaltır: açık bir boşaltma isteğidir.
  kur();
  r = depo.islemler('TRM-01', 'ali', [duzenle('ali', { keepOthers: true, shelves: ['K-KEEP'], lines: [] }, Date.now() + 13000)]);
  assert.ok(r[0].ok);
  assert.deepStrictEqual(['101', '102'].map((p) => depo.miktar(1, p, 'K-KEEP')), [0, 0]);
  // Okutmadan sonra başka terminalin koyduğu mal her iki modda da silinmez (mevcut kural).
  kur();
  r = depo.islemler('TRM-01', 'ali', [duzenle('ali', { keepOthers: true, shelves: ['K-KEEP'], lines: [satir('K-KEEP', '103', 2)] }, Date.now() + 14000)]);
  assert.ok(r[0].ok);
  assert.strictEqual(depo.miktar(1, '101', 'K-KEEP'), 5);
});

test('aynı rafı aynı anda iki terminal düzenler: ikisinin eklediği de kalır (relative), eski terminal mutlak yazmaya devam eder', () => {
  depo.miktarAyarla(1, '103', 'B-01-01', 12, { ts: 1, kind: 'PUTAWAY' });
  const keep = { keepOthers: true, relative: true };
  // İki terminal de rafta 12 görüyor; A +2 (14), B +3 (15) ekledi.
  let r = depo.islemler('TRM-01', 'ali', [duzenle('ali', { ...keep, shelves: ['B-01-01'], lines: [satir('B-01-01', '103', 14, 12)] })])
    .concat(depo.islemler('TRM-02', 'veli', [duzenle('veli', { ...keep, shelves: ['B-01-01'], lines: [satir('B-01-01', '103', 15, 12)] })]));
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.strictEqual(depo.miktar(1, '103', 'B-01-01'), 17, '12 + 2 + 3');
  // Başka bir terminal bu arada rafa kaldırma yaptı (+5), düzenleyen +1 ekledi: ikisi de kalır.
  depo.islemler('TRM-03', 'ayşe', [op('PUTAWAY', 'ayşe', { productId: '103', shelf: 'B-01-01', qty: 5, depot: 1 })]);
  r = depo.islemler('TRM-01', 'ali', [duzenle('ali', { ...keep, shelves: ['B-01-01'], lines: [satir('B-01-01', '103', 18, 17)] })]);
  assert.ok(r[0].ok);
  assert.strictEqual(depo.miktar(1, '103', 'B-01-01'), 23, '17 + 5 + 1');
  // Elle düşürme (miktar kutusu): fark negatif. Sıfır yazmak "rafta yok" demektir, mutlak sıfır.
  depo.islemler('TRM-01', 'ali', [duzenle('ali', { ...keep, shelves: ['B-01-01'], lines: [satir('B-01-01', '103', 21, 23)] })]);
  assert.strictEqual(depo.miktar(1, '103', 'B-01-01'), 21);
  depo.islemler('TRM-01', 'ali', [duzenle('ali', { ...keep, shelves: ['B-01-01'], lines: [satir('B-01-01', '103', 0, 21)] })]);
  assert.strictEqual(depo.miktar(1, '103', 'B-01-01'), 0);
  // Rafta olmayan ürün: sistem 0, eklenen kadar yazılır.
  depo.islemler('TRM-01', 'ali', [duzenle('ali', { ...keep, shelves: ['B-01-01'], lines: [satir('B-01-01', '103', 4, 0)] })]);
  assert.strictEqual(depo.miktar(1, '103', 'B-01-01'), 4);
  // relative alanı yoksa (1.12.1 terminal) eski mutlak davranış.
  depo.islemler('TRM-01', 'ali', [duzenle('ali', { keepOthers: true, shelves: ['B-01-01'], lines: [satir('B-01-01', '103', 9, 4)] })]);
  depo.islemler('TRM-02', 'veli', [duzenle('veli', { keepOthers: true, shelves: ['B-01-01'], lines: [satir('B-01-01', '103', 7, 4)] })]);
  assert.strictEqual(depo.miktar(1, '103', 'B-01-01'), 7, 'mutlak: son yazan kazanır');
});
