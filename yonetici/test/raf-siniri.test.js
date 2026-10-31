// Kullanıcının raf sınırı (yetki.js `shelves`): Toybelen personeli yalnız "TK*" raflarını görür ve işlem yapar.
// Sunucu her raf kodu taşıyan işlemde sınırı denetler; hiçbir işlem yarım uygulanmaz.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-rafsiniri-'));
const sunucu = require('../server/index');
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const transfer = require('../server/transfer');
const yetki = require('../server/yetki');

let port;
test.before(async () => {
  port = await sunucu.baslat({ veriKlasoru: dir, port: 0, host: '127.0.0.1', arayuz: dir });
  config.update({ vega: { depo: 1 }, transfer: { aktif: true, cift: [1, 108] } });
  depo._goruntuKur({
    surum: 2, at: Date.now(), depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 108, ad: 'TOYBELEN' }],
    products: [
      { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
      { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
    ],
    stock: { 1: { 101: 24, 102: 10 }, 108: { 101: 6, 102: 13 } }, moved: [], barcodes: {}, receipts: [],
  });
  depo.rafEkle(1, 'A-01-01');
  for (const r of ['TK-01-01', 'TK-01-02', 'TK2-HY1', 'TKB-01-01', 'X-09-01']) depo.rafEkle(108, r);
});
test.after(async () => {
  await sunucu.durdur();
});

const api = async (yol, metod = 'GET', govde) => {
  const r = await fetch(`http://127.0.0.1:${port}/yonetim/api${yol}`, {
    method: metod,
    headers: { 'Content-Type': 'application/json' },
    body: govde === undefined ? undefined : JSON.stringify(govde),
  });
  return { durum: r.status, govde: await r.json() };
};

let n = 0;
const op = (type, user, payload) => ({ id: `rs-${++n}`, type, createdAt: Date.now(), payload: { user, device: 'TRM-05', ...payload } });
const sevkHazirla = (sevkler = []) =>
  transfer._gorunum({ at: Date.now(), yolda: 3, depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 3, ad: 'TRANSFER' }, { ind: 108, ad: 'TOYBELEN' }], sevkler, ozet: 'x' });
const uygula = (kullanici, ...islemler) => depo.islemler('TRM-05', kullanici, islemler);
const red = (r) => [r.ok, r.code];

test('kullanıcı: raf sınırı kaydedilir, düzeltilir, bozuk önek reddedilir, ana veriye gider', async () => {
  let r = await api('/kullanicilar', 'POST', { username: 'tk', name: 'Toybelen TK', pin: '1234', depots: [108], shelves: ['tk*'] });
  assert.strictEqual(r.durum, 200, JSON.stringify(r.govde));
  r = await api('/kullanicilar', 'POST', { username: 'serbest', name: 'Serbest', pin: '1234' });
  assert.strictEqual(r.durum, 200);
  r = await api('/kullanicilar', 'POST', { username: 'kotu', pin: '1234', shelves: ['T K!'] });
  assert.strictEqual(r.durum, 400);
  assert.match(r.govde.error, /Kapsam öneki uygun değil/);

  let liste = (await api('/kullanicilar')).govde;
  assert.deepStrictEqual(liste.find((u) => u.username === 'tk').shelves, ['TK*'], 'büyük harfe çevrilir');
  assert.strictEqual(liste.find((u) => u.username === 'serbest').shelves, null, 'verilmezse tüm raflar');

  // Ana veri: terminal raf önekini alır, sınırsız kullanıcıda null.
  const kullanicilar = JSON.parse(depo.master().json).users;
  assert.deepStrictEqual(kullanicilar.find((u) => u.username === 'tk').shelves, ['TK*']);
  assert.strictEqual(kullanicilar.find((u) => u.username === 'serbest').shelves, null);

  // Sonradan değişir: iki önek; '*' ve boş liste sınırı kaldırır; yalnız ad değişince sınır korunur.
  await api('/kullanici/tk', 'PUT', { shelves: ['tk*', 'kat-1'] });
  liste = (await api('/kullanicilar')).govde;
  assert.deepStrictEqual(liste.find((u) => u.username === 'tk').shelves, ['TK*', 'KAT-1']);
  await api('/kullanici/tk', 'PUT', { name: 'Toybelen TK 2' });
  assert.deepStrictEqual((await api('/kullanicilar')).govde.find((u) => u.username === 'tk').shelves, ['TK*', 'KAT-1']);
  await api('/kullanici/tk', 'PUT', { shelves: [] });
  assert.strictEqual((await api('/kullanicilar')).govde.find((u) => u.username === 'tk').shelves, null);
  await api('/kullanici/tk', 'PUT', { shelves: ['TK*'] });
  assert.deepStrictEqual((await api('/kullanicilar')).govde.find((u) => u.username === 'tk').shelves, ['TK*']);
});

test('işlemler: sınır dışı rafa dokunan işlem YETKI koduyla reddedilir, sınır içi geçer', () => {
  // Rafa kaldırma
  let r = uygula('tk',
    op('PUTAWAY', 'tk', { productId: '101', shelf: 'TK-01-01', qty: 5, depot: 108 }),
    op('PUTAWAY', 'tk', { productId: '101', shelf: 'TK2-HY1', qty: 2, depot: 108 }),
    op('PUTAWAY', 'tk', { productId: '101', shelf: 'x-09-01', qty: 4, depot: 108 }),
  );
  assert.deepStrictEqual(r.map(red), [[true, undefined], [true, undefined], [false, 'YETKI']]);
  assert.match(r[2].error, /tk X-09-01 rafında işlem yapamaz \(yetkili raflar: TK\*\)/);
  assert.strictEqual(depo.miktar(108, '101', 'TK-01-01'), 5);
  assert.strictEqual(depo.miktar(108, '101', 'TK2-HY1'), 2);
  assert.strictEqual(depo.miktar(108, '101', 'X-09-01'), 0, 'sınır dışı rafa mal girmedi');

  // Raf transferi: iki ucu da sınır içinde olmalı.
  r = uygula('tk',
    op('TRANSFER', 'tk', { productId: '101', from: 'TK-01-01', to: 'X-09-01', qty: 1, depot: 108 }),
    op('TRANSFER', 'tk', { productId: '101', from: 'X-09-01', to: 'TK-01-01', qty: 1, depot: 108 }),
    op('TRANSFER', 'tk', { productId: '101', from: 'TK-01-01', to: 'TK-01-02', qty: 1, depot: 108 }),
  );
  assert.deepStrictEqual(r.map(red), [[false, 'YETKI'], [false, 'YETKI'], [true, undefined]]);
  assert.strictEqual(depo.miktar(108, '101', 'TK-01-01'), 4);
  assert.strictEqual(depo.miktar(108, '101', 'TK-01-02'), 1);

  // Raftan alma ve raf adresi silme
  depo.miktarAyarla(108, '101', 'X-09-01', 7, { ts: 1, kind: 'PUTAWAY' });
  r = uygula('tk',
    op('PICK', 'tk', { productId: '101', shelf: 'X-09-01', qty: 2, depot: 108 }),
    op('PICK', 'tk', { productId: '101', shelf: 'TK-01-02', qty: 1, depot: 108 }),
    op('HOME_REMOVE', 'tk', { productId: '101', shelf: 'X-09-01', depot: 108 }),
  );
  assert.deepStrictEqual(r.map(red), [[false, 'YETKI'], [true, undefined], [false, 'YETKI']]);
  assert.strictEqual(depo.miktar(108, '101', 'X-09-01'), 7, 'sınır dışı rafın stoku değişmedi');

  // Terminalden raf ekleme
  r = uygula('tk', op('SHELF_ADD', 'tk', { code: 'X-10-01', depot: 108 }), op('SHELF_ADD', 'tk', { code: 'TK-05-01', depot: 108 }));
  assert.deepStrictEqual(r.map(red), [[false, 'YETKI'], [true, undefined]]);
  assert.strictEqual(depo.rafVarMi(108, 'X-10-01'), false);
  assert.strictEqual(depo.rafVarMi(108, 'TK-05-01'), true);

  // Sınırsız kullanıcı aynı işlemleri yapar.
  r = uygula('serbest', op('PICK', 'serbest', { productId: '101', shelf: 'X-09-01', qty: 2, depot: 108 }));
  assert.deepStrictEqual(r.map(red), [[true, undefined]]);
  assert.strictEqual(depo.miktar(108, '101', 'X-09-01'), 5);
});

test('sayım ve raf düzenleme: gönderimde sınır dışı tek raf varsa hiçbir raf uygulanmaz', () => {
  const once = depo.miktar(108, '101', 'TK-01-01');
  const karisik = (extra) => ({ depot: 108, shelves: ['TK-01-01', 'X-09-01'], lines: [{ shelf: 'TK-01-01', productId: '101', system: once, counted: 40 }, { shelf: 'X-09-01', productId: '101', system: 5, counted: 1 }], ...extra });
  let r = uygula('tk',
    op('COUNT_SUBMIT', 'tk', karisik({ sessionId: 'LOCAL-RS1', no: 'S-1', title: 'Serbest' })),
    op('SHELF_ARRANGE', 'tk', karisik({ sessionId: 'LOCAL-RD-RS2', no: 'RD-T1', title: 'Raf düzenleme' })),
  );
  assert.deepStrictEqual(r.map(red), [[false, 'YETKI'], [false, 'YETKI']]);
  assert.strictEqual(depo.miktar(108, '101', 'TK-01-01'), once, 'sınır içi raf da yarım uygulanmadı');
  assert.strictEqual(depo.miktar(108, '101', 'X-09-01'), 5);
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM count_session WHERE id='LOCAL-RS1'").n, 0, 'sayım oturumu açılmadı');

  // Yalnız sınır içi raflar: uygulanır.
  r = uygula('tk',
    op('SHELF_ARRANGE', 'tk', { depot: 108, no: 'RD-T2', shelves: ['TK-01-01'], lines: [{ shelf: 'TK-01-01', productId: '101', system: once, counted: 9 }] }),
    op('COUNT_SUBMIT', 'tk', { sessionId: 'LOCAL-RS3', no: 'S-3', title: 'Serbest', depot: 108, shelves: ['TK-01-02'], lines: [] }),
  );
  assert.deepStrictEqual(r.map(red), [[true, undefined], [true, undefined]]);
  assert.strictEqual(depo.miktar(108, '101', 'TK-01-01'), 9);
});

test('"TK" öneki harfle süren TKB-… rafını kapsamaz, "TK*" kapsar; TK2-HY ikisinde de var', async () => {
  await api('/kullanicilar', 'POST', { username: 'tkdar', name: 'Dar', pin: '1234', depots: [108], shelves: ['TK'] });
  const put = (kullanici, raf) => uygula(kullanici, op('PUTAWAY', kullanici, { productId: '102', shelf: raf, qty: 1, depot: 108 }))[0];
  assert.strictEqual(put('tkdar', 'TK-01-01').ok, true);
  assert.strictEqual(put('tkdar', 'TK2-HY1').ok, true);
  assert.deepStrictEqual(red(put('tkdar', 'TKB-01-01')), [false, 'YETKI']);
  assert.strictEqual(put('tk', 'TKB-01-01').ok, true);
});

test('depolar arası: seçilen raflar sınır içinde olmalı; otomatik raf seçimi sınır dışı rafa dokunmaz', () => {
  sevkHazirla();
  db.run("DELETE FROM location WHERE depo=108 AND product_id='102'"); // önceki testlerin kalıntısı
  depo.miktarAyarla(108, '102', 'TK-01-02', 4, { ts: 1, kind: 'PUTAWAY' });
  depo.miktarAyarla(108, '102', 'X-09-01', 9, { ts: 1, kind: 'PUTAWAY' });
  let r = uygula('tk', op('TRANSFER_SEND', 'tk', { from: 108, to: 1, lines: [{ productId: '102', qty: 2, shelf: 'X-09-01' }] }));
  assert.deepStrictEqual(r.map(red), [[false, 'YETKI']]);
  assert.strictEqual(depo.miktar(108, '102', 'X-09-01'), 9);
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM transfer WHERE user='tk'").n, 0, 'Vega yazım kaydı açılmadı');

  // Rafsız satır: sunucu rafı kendi seçer ama yalnız kullanıcının rafları arasından; kalan rafsız geçer.
  r = uygula('tk', op('TRANSFER_SEND', 'tk', { from: 108, to: 1, lines: [{ productId: '102', qty: 6 }] }));
  assert.strictEqual(r[0].ok, true, JSON.stringify(r));
  assert.strictEqual(depo.miktar(108, '102', 'TK-01-02'), 0);
  assert.strictEqual(depo.miktar(108, '102', 'X-09-01'), 9, 'görmediği rafın stoku düşmedi');
  const satirlar = db.all("SELECT shelf, qty FROM transfer_line WHERE transfer_id=(SELECT id FROM transfer WHERE user='tk' ORDER BY created_at DESC LIMIT 1) ORDER BY shelf").map((x) => ({ ...x }));
  assert.deepStrictEqual(satirlar, [{ shelf: '', qty: 2 }, { shelf: 'TK-01-02', qty: 4 }]);

  // Kabul: Toybelen'e gelen gönderimi sınır içi rafa alır, sınır dışı rafa alamaz.
  const gelen = (ind) => ({ ind, no: `A0000${ind}`, tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [{ productId: '101', sent: 3, open: 3 }] });
  sevkHazirla([gelen(901), gelen(902)]);
  r = uygula('tk',
    op('TRANSFER_RECEIVE', 'tk', { sevkId: '901', lines: [{ productId: '101', qty: 3, shelf: 'X-09-01' }] }),
    op('TRANSFER_RECEIVE', 'tk', { sevkId: '902', lines: [{ productId: '101', qty: 3, shelf: 'TK-01-02' }] }),
  );
  assert.deepStrictEqual(r.map(red), [[false, 'YETKI'], [true, undefined]]);
  assert.strictEqual(depo.miktar(108, '101', 'TK-01-02'), 3);
});

test('yetki modülü: raf sınırı normalleşir, denetim mesaj verir, kayıtsız sütun sınırsızdır', () => {
  assert.strictEqual(yetki.raflariDogrula(['tk*', 'TK*', ' kat-1 ']), 'TK*,KAT-1');
  assert.strictEqual(yetki.raflariDogrula('tk*, kat-1'), 'TK*,KAT-1');
  assert.strictEqual(yetki.raflariDogrula([]), '*');
  assert.strictEqual(yetki.raflariDogrula('*'), '*');
  assert.strictEqual(yetki.raflariDogrula(undefined), '*');
  assert.throws(() => yetki.raflariDogrula(['a b?']), /Kapsam öneki uygun değil/);

  const b = yetki.baglam({ username: 'x', perms: '*', depots: '*', shelves: 'TK*,KAT-1' });
  assert.strictEqual(b.rafVar('TK-1-2'), true);
  assert.strictEqual(b.rafVar('KAT-1-A-2'), true);
  assert.strictEqual(b.rafVar('KAT-10-A'), false, 'KAT-1 öneki KAT-10\'u bölmez');
  assert.strictEqual(b.denetle(null, null, 'TK-1-2'), null);
  assert.match(b.denetle(null, null, 'A-01'), /x A-01 rafında işlem yapamaz \(yetkili raflar: TK\*, KAT-1\)/);
  // Raf verilmeyen denetim (yalnız izin/depo) sınırı sormaz.
  assert.strictEqual(b.denetle('pick', 1), null);

  const eski = yetki.baglam({ username: 'eski', perms: '*', depots: '*' });
  assert.strictEqual(eski.rafVar('HERHANGI-1'), true);
  assert.strictEqual(eski.denetle(null, null, 'HERHANGI-1'), null);
  assert.deepStrictEqual(yetki.terminalGorunumu({ role: 'tam', perms: '*', depots: '*', shelves: 'TK*' }).shelves, ['TK*']);
  assert.strictEqual(yetki.terminalGorunumu({ role: 'tam', perms: '*', depots: '*' }).shelves, null);
});
