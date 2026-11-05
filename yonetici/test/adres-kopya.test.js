// B2B raf listesi (IMPORT) her kullanılan depoya kopyalanır. Toybelen'de silinen TK2-L15 Merkez'deki kopyası yüzünden
// terminalde "MERKEZ deposunda adresi" diye görünmeye ve Vega kartında kalmaya devam ediyordu (2026-11-05).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-adres-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });
depo._goruntuKur({
  surum: 2,
  at: Date.now(),
  depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 108, ad: 'TOYBELEN SANAYİ' }],
  products: [
    { id: '184552', code: 'KORJAP-15387030', name: 'Yağ soğutucu', unit: 'Adet' },
    { id: '8835', code: 'KORE-23212-21000', name: 'Kasnak', unit: 'Adet' },
  ],
  stock: { 1: {}, 108: { 184552: 2 } },
  moved: [],
  barcodes: {},
  receipts: [],
});
for (const d of [1, 108]) for (const r of ['TK2-L15', 'TK2-M21', 'KAT-1-01']) depo.rafEkle(d, r);
const op = (id, type, payload, depot = 108) => ({ id, type, createdAt: Date.now(), payload: { user: 'batuhan', device: 'TOYBELEN', depot, ...payload } });
const adresler = (pid) => db.all('SELECT depo, shelf, source FROM product_home WHERE product_id=? ORDER BY depo, shelf', pid).map((z) => `${z.depo}:${z.shelf}:${z.source}`);

test('terminalden silinen adresin öteki depolardaki liste kopyası da kalkar; elle verilen adrese ve stoklu rafa dokunulmaz', () => {
  for (const d of [1, 108]) depo.zimmetEkle(d, '184552', 'TK2-L15', 'IMPORT');
  depo.zimmetEkle(1, '184552', 'KAT-1-01', 'IMPORT');
  const r = depo.islemler('TOYBELEN', 'batuhan', [op('h1', 'HOME_REMOVE', { productId: '184552', shelf: 'TK2-L15' })]);
  assert.ok(r[0].ok, r[0].error);
  assert.deepStrictEqual(adresler('184552'), ['1:KAT-1-01:IMPORT'], 'Merkez kopyası da silindi, başka adres kaldı');

  // Merkez'de aynı adres elle verilmişse (ADMIN) ya da o rafta Merkez stoku varsa silinmez.
  depo.zimmetEkle(108, '8835', 'TK2-M21', 'IMPORT');
  depo.zimmetEkle(1, '8835', 'TK2-M21', 'ADMIN');
  depo.zimmetEkle(1, '8835', 'KAT-1-01', 'IMPORT');
  depo.zimmetEkle(108, '8835', 'KAT-1-01', 'IMPORT');
  db.tx(() => depo.miktarAyarla(108, '8835', 'KAT-1-01', 3, { kind: 'ADJUST' }));
  depo.islemler('MERKEZ-1', 'ismail', [op('h2', 'HOME_REMOVE', { productId: '8835', shelf: 'TK2-M21' }), op('h3', 'HOME_REMOVE', { productId: '8835', shelf: 'KAT-1-01' }, 1)]);
  assert.deepStrictEqual(adresler('8835'), ['1:TK2-M21:ADMIN', '108:KAT-1-01:IMPORT']);
});

test('yönetici ekranından silme de kopyaları kaldırır; Merkez\'de olmayan adres silinmek istenince yalnız kopya gider', () => {
  for (const d of [1, 108]) depo.zimmetEkle(d, '184552', 'TK2-M21', 'IMPORT');
  const s = depo.adresSil(108, '184552', 'TK2-M21');
  assert.deepStrictEqual(s, { ok: true, kopya: 1 });
  depo.zimmetEkle(1, '184552', 'TK2-L15', 'IMPORT');
  // Eski terminal (≤2.1.x) Merkez adresini kendi deposundan silmeye çalışınca: Toybelen'de yok, Merkez kopyası kalkar.
  const r = depo.islemler('TOYBELEN', 'batuhan', [op('h4', 'HOME_REMOVE', { productId: '184552', shelf: 'TK2-L15' })]);
  assert.ok(r[0].ok);
  assert.ok(!adresler('184552').includes('1:TK2-L15:IMPORT'));
});

test('ilk açılışta geçmişte silinmiş adreslerin kalan kopyaları bir kez temizlenir; sonradan yeniden verilen adrese dokunulmaz', () => {
  // Eski sürüm silmeyi yalnız kendi deposunda yapmıştı: Merkez kopyaları duruyor.
  db.run("INSERT INTO op(id, type, payload, device, user, created_at, received_at, ok) VALUES('eski-1','HOME_REMOVE',?, 'TOYBELEN','batuhan',1,1,1)", JSON.stringify({ productId: '184552', shelf: 'TK2-L15', depot: 108 }));
  db.run("INSERT INTO op(id, type, payload, device, user, created_at, received_at, ok) VALUES('eski-2','HOME_REMOVE',?, 'TOYBELEN','batuhan',2,2,1)", JSON.stringify({ productId: '8835', shelf: 'TK2-M21', depot: 108 }));
  depo.zimmetEkle(1, '184552', 'TK2-L15', 'IMPORT');
  depo.zimmetEkle(1, '8835', 'TK2-M21', 'IMPORT');
  depo.zimmetEkle(108, '8835', 'TK2-M21', 'TERMINAL'); // Toybelen'de sonradan yeniden rafa kaldırıldı
  db.run("DELETE FROM meta WHERE key='importKopyaTemizlik'");
  assert.strictEqual(depo.silinenAdresKopyalari(), 1);
  assert.ok(!adresler('184552').includes('1:TK2-L15:IMPORT'));
  assert.ok(adresler('8835').includes('1:TK2-M21:ADMIN'));
  // İkinci kez çalışmaz.
  depo.zimmetEkle(1, '184552', 'TK2-L15', 'IMPORT');
  assert.strictEqual(depo.silinenAdresKopyalari(), 0);
});
