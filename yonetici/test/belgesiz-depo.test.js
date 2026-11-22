// Rafa Kaldır'ın belgeye bağlı olmadığı depolar (config.belgesizDepolar; Ortaş: 108 Toybelen, Batuhan isteği 2026-11-20).
// Sunucu listeyi ana veriyle terminale gönderir; terminal o depoda belgede olmayan ürünü de okutur ve Vega stoku sınırı
// uygulamaz. Sunucu belgesiz rafa kaldırmayı zaten sınırlamaz: Vega stokundan fazlası da raf stokuna girer.
// Vega'sız; görüntü elle verilir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-belgesiz-'));
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
  products: [{ id: '101', code: 'BJ-77', name: 'Buji', unit: 'Adet' }],
  stock: { 1: { 101: 5 }, 108: { 101: 2 } },
  moved: [],
  barcodes: {},
  receipts: [],
});
depo.rafEkle(108, 'TK1-BJ-77');

let n = 0;
const op = (type, payload) => ({ id: `bz-${++n}`, type, createdAt: Date.now(), payload: { user: 'batuhan', device: 'TRM-01', ...payload } });

test('varsayılan: Toybelen (108) belgesiz depo olarak ana veriyle gider', () => {
  assert.deepStrictEqual(depo.belgesizDepolar(), [108]);
  assert.deepStrictEqual(JSON.parse(depo.master().json).freePutAwayDepots, [108]);
});

test('belgesiz depoda Vega stokundan fazlası da rafa kalkar (Vega 2, rafa 6)', () => {
  const r = depo.islemler('TRM-01', 'batuhan', [op('PUTAWAY', { productId: '101', shelf: 'TK1-BJ-77', qty: 6, depot: 108 })]);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.strictEqual(depo.miktar(108, '101', 'TK1-BJ-77'), 6);
});

test('liste ayardan gelir: geçersiz değerler ayıklanır, boşaltılırsa hiçbir depo belgesiz değildir', () => {
  config.update({ belgesizDepolar: ['108', 3, 'x', -1, 3] });
  assert.deepStrictEqual(depo.belgesizDepolar(), [3, 108]);
  config.update({ belgesizDepolar: [] });
  assert.deepStrictEqual(JSON.parse(depo.master().json).freePutAwayDepots, []);
});
