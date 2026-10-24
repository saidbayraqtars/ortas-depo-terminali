// Toplu raf oluşturmada kalıptan raf kodları (client/src/kalip.mjs).
const test = require('node:test');
const assert = require('node:assert');

const yukle = () => import('../client/src/kalip.mjs');

test('kalıp: aralık, harf, liste ve iki haneli sayı açılır', async () => {
  const { kaliptan } = await yukle();
  assert.deepStrictEqual(kaliptan('TK[1-2]-H[1-3]'), ['TK1-H1', 'TK1-H2', 'TK1-H3', 'TK2-H1', 'TK2-H2', 'TK2-H3']);
  assert.deepStrictEqual(kaliptan('kat-[1-2]-[a-b]1-[08-10]').slice(0, 4), ['KAT-1-A1-08', 'KAT-1-A1-09', 'KAT-1-A1-10', 'KAT-1-B1-08']);
  assert.deepStrictEqual(kaliptan('KO-[2,5]-[F,Z]4'), ['KO-2-F4', 'KO-2-Z4', 'KO-5-F4', 'KO-5-Z4']);
  assert.deepStrictEqual(kaliptan('DEPO-1-VİTRİN'), ['DEPO-1-VİTRİN']);
  assert.deepStrictEqual(kaliptan('TK[0-1]'), ['TK0', 'TK1']);
  assert.deepStrictEqual(kaliptan('A[]'), []);
  assert.deepStrictEqual(kaliptan(''), []);
});

test('kalıp: en çok 5001 kod üretir; uygun olmayan kod desene takılır', async () => {
  const { kaliptan, RAF_DESEN } = await yukle();
  assert.strictEqual(kaliptan('A[1-100]-[1-100]').length, 5001);
  const depo = require('../server/depo');
  assert.strictEqual(RAF_DESEN.source, /^[A-Z0-9ÇĞİÖŞÜ][A-Z0-9ÇĞİÖŞÜ\-./ ]{0,23}$/.source);
  for (const k of ['TK2-H1', '.;TK2', '-A1', 'KAT-1-A1-20/3', 'X'.repeat(25)]) assert.strictEqual(RAF_DESEN.test(k), depo.rafKoduGecerli(k), k);
  assert.ok(!RAF_DESEN.test(kaliptan('TK[1-')[0]));
});
