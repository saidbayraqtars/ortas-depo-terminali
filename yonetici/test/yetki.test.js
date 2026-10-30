// Kullanıcı yetkisi (yetki.js): izin ve depo sınırı, YETKI kodu, ana veri, yönetici uçları.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-yetki-'));
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
    stock: { 1: { 101: 24, 102: 10 } }, moved: [], barcodes: {}, receipts: [],
  });
  for (const r of ['A-01-01', 'A-01-02']) depo.rafEkle(1, r);
  for (const r of ['T-01-01', 'T-01-02']) depo.rafEkle(108, r);
  depo.miktarAyarla(1, '101', 'A-01-01', 10, { ts: 1, kind: 'PUTAWAY' });
  depo.miktarAyarla(108, '101', 'T-01-01', 10, { ts: 1, kind: 'PUTAWAY' });
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
const op = (type, user, payload) => ({ id: `y-${++n}`, type, createdAt: Date.now(), payload: { user, device: 'TRM-01', ...payload } });
const sevkHazirla = (sevkler = []) =>
  transfer._gorunum({ at: Date.now(), yolda: 3, depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 3, ad: 'TRANSFER' }, { ind: 108, ad: 'TOYBELEN' }], sevkler, ozet: 'x' });

test('katalog: izinler, şablonlar ve depolar gelir; şablon izinleri katalogda var', async () => {
  const r = await api('/izinler');
  assert.strictEqual(r.durum, 200);
  const kimlikler = new Set(r.govde.izinler.map((i) => i.id));
  assert.ok(['putaway', 'pick', 'depot_send', 'depot_receive', 'label', 'queue_manage'].every((i) => kimlikler.has(i)));
  for (const s of r.govde.sablonlar) if (s.izinler !== '*') assert.ok(s.izinler.every((i) => kimlikler.has(i)), s.id);
  assert.deepStrictEqual(r.govde.depolar.map((d) => d.ind), [1, 108]);
});

test('kullanıcı: yetki verilmezse tam yetkili; izin ve depo kaydedilir, bilinmeyen izin ve bozuk depo reddedilir', async () => {
  let r = await api('/kullanicilar', 'POST', { username: 'tam', name: 'Tam', pin: '1234' });
  assert.strictEqual(r.durum, 200);
  r = await api('/kullanicilar', 'POST', { username: 'toy', name: 'Toybelen', pin: '1234', role: 'sube', perms: ['pick', 'transfer', 'depot_receive', 'depot_send'], depots: [108] });
  assert.strictEqual(r.durum, 200, JSON.stringify(r.govde));
  r = await api('/kullanicilar', 'POST', { username: 'kotu', pin: '1234', perms: ['uçmak'] });
  assert.strictEqual(r.durum, 400);
  assert.match(r.govde.error, /Bilinmeyen izin/);
  r = await api('/kullanicilar', 'POST', { username: 'kotu2', pin: '1234', perms: [], depots: ['merkez'] });
  assert.strictEqual(r.durum, 400);

  const liste = (await api('/kullanicilar')).govde;
  const tam = liste.find((u) => u.username === 'tam');
  const toy = liste.find((u) => u.username === 'toy');
  assert.deepStrictEqual([tam.role, tam.perms, tam.depots], ['tam', null, null]);
  assert.deepStrictEqual([toy.role, toy.perms, toy.depots], ['sube', ['depot_receive', 'depot_send', 'pick', 'transfer'], [108]]);

  // Ana veri: terminal izin ve depo listesini alır (null = sınırsız).
  const head = JSON.parse(depo.master().json).users;
  assert.deepStrictEqual(head.find((u) => u.username === 'tam').perms, null);
  assert.deepStrictEqual(head.find((u) => u.username === 'toy').depots, [108]);

  // Yetki sonradan değişir; büyük harfli ad da bulunur. Boş liste = hiçbir izin yok (yalnız sorgu).
  r = await api('/kullanici/TOY', 'PUT', { perms: [], role: 'sorgu' });
  assert.strictEqual(r.durum, 200);
  assert.deepStrictEqual({ ...db.get("SELECT role, perms FROM app_user WHERE username='toy'") }, { role: 'sorgu', perms: '' });
  r = await api('/kullanici/toy', 'PUT', { perms: ['pick', 'transfer', 'depot_receive', 'depot_send'], role: 'sube' });
  assert.strictEqual(r.durum, 200);
  // '*' tam yetki demektir ve rolü 'tam' yapar.
  await api('/kullanici/tam', 'PUT', { perms: ['pick'] });
  await api('/kullanici/tam', 'PUT', { perms: '*', role: 'depocu' });
  assert.deepStrictEqual({ ...db.get("SELECT role, perms FROM app_user WHERE username='tam'") }, { role: 'tam', perms: '*' });
});

test('izin yoksa işlem YETKI koduyla reddedilir, işlem uygulanmaz; aynı işlem yeniden gelince aynı kod döner', async () => {
  await api('/kullanicilar', 'POST', { username: 'okur', name: 'Okur', pin: '1234', perms: ['pick'] });
  const once = depo.miktar(1, '101', 'A-01-01');
  const put = op('PUTAWAY', 'okur', { productId: '101', shelf: 'A-01-01', qty: 2, depot: 1 });
  let r = depo.islemler('TRM-01', 'okur', [put, op('PICK', 'okur', { productId: '101', shelf: 'A-01-01', qty: 1, depot: 1 })]);
  assert.deepStrictEqual([r[0].ok, r[0].code], [false, 'YETKI']);
  assert.match(r[0].error, /"Rafa kaldır" yetkisi yok/);
  assert.strictEqual(r[1].ok, true);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), once - 1, 'reddedilen rafa kaldırma uygulanmadı, alma uygulandı');
  // Aynı kimlik tekrar gelir (terminal "yeniden dene" dedi): sonuç ve kod aynı, işlem yine uygulanmaz.
  r = depo.islemler('TRM-01', 'okur', [put]);
  assert.deepStrictEqual([r[0].ok, r[0].code], [false, 'YETKI']);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), once - 1);
  // Başka nedenli ret kod taşımaz.
  r = depo.islemler('TRM-01', 'okur', [op('PICK', 'okur', { productId: '999', shelf: 'A-01-01', qty: 1, depot: 1 })]);
  assert.strictEqual(r[0].ok, false);
  assert.strictEqual(r[0].code, undefined);
});

test('serbest sayım ayrı izin ister; yönetici sayımına gönderim yalnız sayım izni ister', async () => {
  await api('/kullanicilar', 'POST', { username: 'sayici', name: 'Sayıcı', pin: '1234', perms: ['count'] });
  const sayim = op('COUNT_SUBMIT', 'sayici', { sessionId: 'LOCAL-1', no: 'S-1', title: 'Serbest', depot: 1, shelves: ['A-01-02'], lines: [] });
  let r = depo.islemler('TRM-01', 'sayici', [sayim]);
  assert.deepStrictEqual([r[0].ok, r[0].code], [false, 'YETKI']);
  assert.match(r[0].error, /Serbest sayım başlat/);
  await api('/kullanici/sayici', 'PUT', { perms: ['count', 'count_free'] });
  r = depo.islemler('TRM-01', 'sayici', [op('COUNT_SUBMIT', 'sayici', { sessionId: 'LOCAL-2', no: 'S-2', title: 'Serbest', depot: 1, shelves: ['A-01-02'], lines: [] })]);
  assert.strictEqual(r[0].ok, true, JSON.stringify(r));
});

test('depo sınırı: Toybelen kullanıcısı Merkez\'de işlem yapamaz, kendi deposunda yapar', async () => {
  const merkez = depo.miktar(1, '101', 'A-01-01');
  const toy = depo.miktar(108, '101', 'T-01-01');
  let r = depo.islemler('TRM-05', 'toy', [
    op('PICK', 'toy', { productId: '101', shelf: 'A-01-01', qty: 1, depot: 1 }),
    op('TRANSFER', 'toy', { productId: '101', from: 'A-01-01', to: 'A-01-02', qty: 1, depot: 1 }),
    op('PICK', 'toy', { productId: '101', shelf: 'T-01-01', qty: 1, depot: 108 }),
  ]);
  assert.deepStrictEqual(r.map((x) => [x.ok, x.code]), [[false, 'YETKI'], [false, 'YETKI'], [true, undefined]]);
  assert.match(r[0].error, /MERKEZ deposunda işlem yapamaz \(yetkili depo: TOYBELEN\)/);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), merkez, 'Merkez stoku değişmedi');
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), toy - 1);
});

test('depolar arası: Toybelen kullanıcısı Merkez\'den gönderemez, Toybelen\'den gönderir; kabul yalnız kendi deposuna', async () => {
  sevkHazirla();
  const merkez = depo.miktar(1, '101', 'A-01-01');
  let r = depo.islemler('TRM-05', 'toy', [op('TRANSFER_SEND', 'toy', { from: 1, to: 108, lines: [{ productId: '101', qty: 2, shelf: 'A-01-01' }] })]);
  assert.deepStrictEqual([r[0].ok, r[0].code], [false, 'YETKI']);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), merkez, 'Merkez raf stoku düşmedi');
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM transfer WHERE user='toy'").n, 0, 'Vega yazım kaydı açılmadı');

  r = depo.islemler('TRM-05', 'toy', [op('TRANSFER_SEND', 'toy', { from: 108, to: 1, lines: [{ productId: '101', qty: 2, shelf: 'T-01-01' }] })]);
  assert.strictEqual(r[0].ok, true, JSON.stringify(r));

  // Kabul: Merkez'e gelen gönderimi Toybelen kullanıcısı alamaz; Toybelen'e geleni alır.
  const gelenMerkez = { ind: 801, no: 'A0000801', tarih: new Date('2026-10-28T00:00:00'), kaynak: 108, hedef: 1, kalemler: [], satirlar: [{ productId: '101', sent: 3, open: 3 }] };
  const gelenToy = { ind: 802, no: 'A0000802', tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [{ productId: '101', sent: 3, open: 3 }] };
  sevkHazirla([gelenMerkez, gelenToy]);
  r = depo.islemler('TRM-05', 'toy', [
    op('TRANSFER_RECEIVE', 'toy', { sevkId: '801', lines: [{ productId: '101', qty: 3, shelf: 'A-01-02' }] }),
    op('TRANSFER_RECEIVE', 'toy', { sevkId: '802', lines: [{ productId: '101', qty: 3, shelf: 'T-01-02' }] }),
  ]);
  assert.deepStrictEqual(r.map((x) => [x.ok, x.code]), [[false, 'YETKI'], [true, undefined]]);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-02'), 0);
  assert.strictEqual(depo.miktar(108, '101', 'T-01-02'), 3);
});

test('kayıtlı olmayan ya da boş kullanıcı adı sınırsız sayılır (silinen kullanıcının kuyruğu kaybolmaz)', () => {
  const r = depo.islemler('TRM-09', '', [
    op('PICK', 'silinmis-kullanici', { productId: '101', shelf: 'A-01-01', qty: 1, depot: 1 }),
    op('PICK', '', { productId: '101', shelf: 'A-01-01', qty: 1, depot: 1 }),
  ]);
  assert.deepStrictEqual(r.map((x) => x.ok), [true, true]);
});

test('yetki modülü: kayıt metni normalleşir, izin ve depo denetimi mesaj verir', () => {
  assert.strictEqual(yetki.metinListe(['pick', 'count', 'pick']), 'count,pick');
  assert.strictEqual(yetki.metinListe('*'), '*');
  assert.strictEqual(yetki.metinListe([]), '');
  assert.strictEqual(yetki.depolariDogrula([108, '1', 108]), '1,108');
  const b = yetki.baglam({ username: 'x', perms: 'pick', depots: '108' }, (d) => `D${d}`);
  assert.strictEqual(b.denetle('pick', 108), null);
  assert.match(b.denetle('putaway'), /yetkisi yok/);
  assert.match(b.denetle('pick', 1), /D1 deposunda işlem yapamaz \(yetkili depo: D108\)/);
  assert.strictEqual(yetki.baglam(null), null);
  assert.deepStrictEqual(yetki.terminalGorunumu({ role: 'tam', perms: '*', depots: '*' }), { role: 'tam', perms: null, depots: null });
});
