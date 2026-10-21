const test = require('node:test');
const assert = require('node:assert');
const fuzzy = require('../server/fuzzy');

const urunler = [
  { id: '1', code: 'YF-1042', name: 'Yağ filtresi' },
  { id: '2', code: 'HF-0310', name: 'Hava filtresi' },
  { id: '3', code: 'AM-3301', name: 'Amortisör ön sağ' },
  { id: '4', code: 'FB-2210', name: 'Fren balatası ön takım' },
  { id: '5', code: 'BJ-1450', name: 'Buji iridyum' },
];

function ara(q) {
  const qt = fuzzy.tokens(q);
  const c = qt.join('');
  return urunler
    .map((u) => ({ u, s: fuzzy.puan(qt, c, fuzzy.kayit(u)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.u.id);
}

test('Türkçe harfler sadeleşir', () => {
  assert.strictEqual(fuzzy.norm('Amortisör ÖN Sağ'), 'amortisor on sag');
  assert.strictEqual(fuzzy.norm('IŞIK-12'), 'isik 12');
});

test('yazım hatası tolere edilir', () => {
  assert.strictEqual(ara('yag filitre')[0], '1');
  assert.strictEqual(ara('amortisor')[0], '3');
  assert.strictEqual(ara('balata')[0], '4');
  assert.strictEqual(ara('bujı')[0], '5');
});

test('kod ile tam eşleşme en üstte', () => {
  assert.deepStrictEqual(ara('hf0310'), ['2']);
  assert.strictEqual(ara('YF-1042')[0], '1');
});

test('alakasız sorgu sonuç vermez', () => {
  assert.deepStrictEqual(ara('televizyon'), []);
});

test('ortak kelime iki ürünü de getirir', () => {
  assert.deepStrictEqual(ara('filtre').sort(), ['1', '2']);
});
