// Depolar arası transfer (Vega'sız): terminal işlemleri, açık gönderim hesabı, fark kaydı, Vega yazıcısı (transferYaz taklit).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-transfer-'));
const config = require('../server/config');
const db = require('../server/db');
const vega = require('../server/vega');
const depo = require('../server/depo');
const transfer = require('../server/transfer');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 }, transfer: { aktif: true } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const DEPOLAR = [{ ind: 1, ad: 'MERKEZ' }, { ind: 2, ad: 'ŞUBE' }, { ind: 3, ad: 'TRANSFER' }, { ind: 108, ad: 'TOYBELEN' }];
depo._goruntuKur({
  surum: 2, at: Date.now(), depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 108, ad: 'TOYBELEN' }],
  products: [
    { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
    { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
    { id: '103', code: 'AN-0040', name: 'Antifriz 4 L', unit: 'Adet' },
  ],
  stock: { 1: { 101: 24, 102: 10, 103: 5 } }, moved: [], barcodes: {},
  receipts: [
    { id: 'D129-900-108', izahat: 'D129', tur: 'Gönderim kabulü', docNo: 'A0006800', supplier: 'MERKEZ deposundan', date: '28.10.2026', ts: 1, depo: 108, depoAd: 'TOYBELEN', lines: [{ id: 'D129-900-108-101', productId: '101', accepted: 3 }] },
    { id: 'D129-901-108', izahat: 'D129', tur: 'Gönderim kabulü', docNo: 'A0006801', supplier: 'MERKEZ deposundan', date: '28.10.2026', ts: 2, depo: 108, depoAd: 'TOYBELEN', lines: [{ id: 'D129-901-108-102', productId: '102', accepted: 2 }] },
  ],
});
for (const r of ['A-01-01', 'A-01-02']) depo.rafEkle(1, r);
for (const r of ['T-01-01', 'T-01-02']) depo.rafEkle(108, r);
depo.miktarAyarla(1, '101', 'A-01-01', 10, { ts: 1, kind: 'PUTAWAY' });

let n = 0;
const op = (type, payload) => ({ id: `t-${++n}`, type, createdAt: Date.now(), payload: { user: 'ali', device: 'TRM-01', ...payload } });
const hazir = (sevkler = []) => transfer._gorunum({ at: Date.now(), yolda: 3, depolar: DEPOLAR, sevkler, ozet: 'x' });
const yazilanlar = [];
let vegaHata = null;
let vegaSayac = 5000;
vega.transferYaz = async (cfg, p) => {
  yazilanlar.push(p);
  if (vegaHata) throw new Error(vegaHata);
  return { ind: ++vegaSayac, belgeNo: `A${String(vegaSayac).padStart(7, '0')}`, kalem: p.kalemler.length, tutar: 0, userno: 100, negatif: 0 };
};

test('gönderim: gönderen depoda raf düşer, transfer bekleyen kayıt olur; kapalıyken ya da hatalı depoda reddedilir', async () => {
  hazir();
  config.update({ transfer: { aktif: false } });
  let r = depo.islemler('TRM-01', 'ali', [op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '101', qty: 2, shelf: 'A-01-01' }] })]);
  assert.strictEqual(r[0].ok, false);
  assert.match(r[0].error, /açık değil/);
  config.update({ transfer: { aktif: true } });

  r = depo.islemler('TRM-01', 'ali', [
    op('TRANSFER_SEND', { from: 1, to: 1, lines: [{ productId: '101', qty: 1 }] }),
    op('TRANSFER_SEND', { from: 1, to: 3, lines: [{ productId: '101', qty: 1 }] }),
    op('TRANSFER_SEND', { from: 1, to: 777, lines: [{ productId: '101', qty: 1 }] }),
    op('TRANSFER_SEND', { from: 1, to: 108, lines: [] }),
    op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '999', qty: 1 }] }),
  ]);
  assert.ok(r.every((x) => x.ok === false), JSON.stringify(r));
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 10);

  r = depo.islemler('TRM-01', 'ali', [op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '101', qty: 4, shelf: 'a-01-01' }, { productId: '102', qty: 1 }] })]);
  assert.ok(r[0].ok, JSON.stringify(r));
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 6);
  const t = db.get("SELECT * FROM transfer WHERE kind='SEND'");
  assert.strictEqual(t.durum, 'BEKLIYOR');
  assert.deepStrictEqual([t.from_depo, t.to_depo], [1, 108]);
  assert.strictEqual(db.all('SELECT * FROM transfer_line WHERE transfer_id=?', t.id).length, 2);
});

test('yazıcı: gönderim Vega\'ya 128 olarak, satırlar ürün başına toplanıp yazılır', async () => {
  await transfer.yaz();
  const p = yazilanlar.at(-1);
  assert.strictEqual(p.tip, 128);
  assert.deepStrictEqual([p.depo, p.karsi, p.yolda], [1, 108, 3]);
  assert.deepStrictEqual(p.kalemler, [{ stokno: 101, miktar: 4 }, { stokno: 102, miktar: 1 }]);
  const t = db.get("SELECT * FROM transfer WHERE kind='SEND'");
  assert.strictEqual(t.durum, 'YAZILDI');
  assert.ok(t.vega_ind && t.belge_no);
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM transfer WHERE durum='BEKLIYOR'").n, 0);
});

test('Vega hatası: bekleyen kalır, 5 denemeden sonra HATA olur, yeniden denenince yazılır', async () => {
  depo.islemler('TRM-01', 'ali', [op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '103', qty: 1 }] })]);
  const t = db.get("SELECT * FROM transfer WHERE durum='BEKLIYOR'");
  vegaHata = 'bağlantı koptu';
  await transfer.yaz();
  let x = db.get('SELECT * FROM transfer WHERE id=?', t.id);
  assert.strictEqual(x.durum, 'BEKLIYOR');
  assert.strictEqual(x.deneme, 1);
  assert.match(x.hata, /bağlantı koptu/);
  for (let i = 0; i < 4; i++) await transfer.yaz();
  x = db.get('SELECT * FROM transfer WHERE id=?', t.id);
  assert.strictEqual(x.durum, 'HATA');
  vegaHata = null;
  assert.ok(transfer.yenidenDene(t.id));
  await transfer.yaz();
  assert.strictEqual(db.get('SELECT durum FROM transfer WHERE id=?', t.id).durum, 'YAZILDI');
});

test('açık gönderim: havuz bakiyesi en yeni gönderimden dağıtılır; kayıtlı eksik düşer, "bulundu" düşmez', () => {
  const bas = new Date('2026-10-01T00:00:00');
  const sevk = (ind, gun, kalemler) => ({ ind, no: `A${ind}`, tarih: new Date(`2026-10-${gun}T00:00:00`), kaynak: 1, hedef: 108, kalemler });
  const oku = {
    sevkler: [sevk(10, '20', [{ stokno: '101', miktar: 5 }]), sevk(11, '25', [{ stokno: '101', miktar: 4 }, { stokno: '102', miktar: 2 }])],
    havuz: [
      { kaynak: 1, hedef: 108, stokno: '101', gonderilen: 9, alinan: 5 },
      { kaynak: 1, hedef: 108, stokno: '102', gonderilen: 2, alinan: 0 },
    ],
  };
  let acik = transfer._acikHesapla(oku, bas);
  // Bakiye 4: en yeni gönderim (11) tamamen açık, eski (10) kapanmış sayılır.
  assert.deepStrictEqual(acik.map((s) => s.ind), [11]);
  assert.deepStrictEqual(acik[0].satirlar.map((l) => [l.productId, l.open]), [['101', 4], ['102', 2]]);

  db.run("INSERT INTO transfer_fark(transfer_id, sevk_ind, from_depo, to_depo, product_id, sent, received, eksik, created_at) VALUES('x', 11, 1, 108, '102', 2, 0, 2, ?)", Date.now());
  acik = transfer._acikHesapla(oku, bas);
  assert.deepStrictEqual(acik[0].satirlar.map((l) => l.productId), ['101'], 'kayıtlı eksik yeniden açık görünmez');
  db.run("UPDATE transfer_fark SET durum='BULUNDU' WHERE transfer_id='x'");
  acik = transfer._acikHesapla(oku, bas);
  assert.deepStrictEqual(acik[0].satirlar.map((l) => l.productId), ['101', '102'], 'bulunan mal Vega\'da kabul edilecek, tekrar açık');
  db.run("DELETE FROM transfer_fark WHERE transfer_id='x'");
});

test('kabul: gelen kadar rafa girer, fazla ve gönderimde olmayan ürün reddedilir, eksik kayıtlı kalır, gönderim kapanır, 129 yazılır', async () => {
  const sevk = { ind: 700, no: 'A0000700', tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [
    { productId: '101', sent: 4, open: 4 },
    { productId: '102', sent: 3, open: 3 },
  ] };
  hazir([sevk]);
  let r = depo.islemler('TRM-02', 'veli', [
    op('TRANSFER_RECEIVE', { sevkId: '700', lines: [{ productId: '101', qty: 5, shelf: 'T-01-01' }] }),
    op('TRANSFER_RECEIVE', { sevkId: '700', lines: [{ productId: '103', qty: 1, shelf: 'T-01-01' }] }),
    op('TRANSFER_RECEIVE', { sevkId: '999', lines: [{ productId: '101', qty: 1 }] }),
    op('TRANSFER_RECEIVE', { sevkId: '700', lines: [] }),
  ]);
  assert.ok(r.every((x) => x.ok === false), JSON.stringify(r));
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), 0);

  r = depo.islemler('TRM-02', 'veli', [op('TRANSFER_RECEIVE', { sevkId: '700', lines: [{ productId: '101', qty: 4, shelf: 'T-01-01' }, { productId: '102', qty: 1, shelf: 'T-01-02' }] })]);
  assert.ok(r[0].ok, JSON.stringify(r));
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), 4);
  assert.strictEqual(depo.miktar(108, '102', 'T-01-02'), 1);

  const f = db.all('SELECT * FROM transfer_fark ORDER BY id');
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual([f[0].product_id, f[0].sent, f[0].received, f[0].eksik, f[0].durum, f[0].from_depo, f[0].to_depo, f[0].sevk_no], ['102', 3, 1, 2, 'ACIK', 1, 108, 'A0000700']);
  assert.ok(db.get('SELECT 1 FROM transfer_kapali WHERE sevk_ind=700'));
  assert.strictEqual(transfer.terminalGorunumu().incoming.length, 0, 'gönderim terminallerde kapandı');

  // Aynı gönderim ikinci kez kabul edilemez.
  r = depo.islemler('TRM-02', 'veli', [op('TRANSFER_RECEIVE', { sevkId: '700', lines: [{ productId: '102', qty: 2, shelf: 'T-01-02' }] })]);
  assert.strictEqual(r[0].ok, false);

  await transfer.yaz();
  const p = yazilanlar.at(-1);
  assert.strictEqual(p.tip, 129);
  assert.deepStrictEqual([p.depo, p.karsi, p.yolda], [108, 1, 3]);
  assert.deepStrictEqual(p.kalemler, [{ stokno: 101, miktar: 4 }, { stokno: 102, miktar: 1 }]);
});

test('yönetici: fark çözülür / yeniden açılır; programın yazdığı 129 mal kabulde ikinci kez çıkmaz', () => {
  const f = db.get('SELECT * FROM transfer_fark');
  assert.ok(transfer.farkCoz(f.id, 'KAYIP', 'sayımda bulunamadı', 'yönetici'));
  assert.strictEqual(db.get('SELECT durum FROM transfer_fark WHERE id=?', f.id).durum, 'KAYIP');
  assert.throws(() => transfer.farkCoz(f.id, 'ŞU', '', 'x'), /Çözüm türü/);
  assert.ok(transfer.farkAc(f.id));
  assert.strictEqual(db.get('SELECT durum FROM transfer_fark WHERE id=?', f.id).durum, 'ACIK');

  // Vega'da 900 numaralı 129'u program yazdı (kayıtlı), 901'i Vega'da elle yapıldı.
  db.run("INSERT INTO transfer(id, kind, from_depo, to_depo, sevk_ind, durum, vega_ind, created_at) VALUES('p129', 'RECEIVE', 1, 108, 1, 'YAZILDI', 900, ?)", Date.now());
  const b = depo.belgeler();
  assert.strictEqual(b.find((x) => x.id === 'D129-900-108').acik, false);
  assert.strictEqual(b.find((x) => x.id === 'D129-901-108').acik, true);
  const l = transfer.liste();
  assert.ok(l.transferler.length >= 3 && l.farklar.length === 1 && l.acikFark.n === 1);
});

test('ana veri: transfer bölümü hedef depoları (yoldaki hariç) ve açık gönderimleri taşır; kapalıyken yalnız on:false', () => {
  hazir([{ ind: 800, no: 'A0000800', tarih: new Date('2026-10-28T00:00:00'), kaynak: 108, hedef: 1, kalemler: [], satirlar: [{ productId: '101', sent: 2, open: 2 }] }]);
  const m = JSON.parse(depo.master().json).transfer;
  assert.strictEqual(m.on, true);
  assert.strictEqual(m.yolda, 3);
  assert.deepStrictEqual(m.depots.map((d) => d.id), [1, 2, 108]);
  assert.deepStrictEqual(m.incoming[0], { id: '800', no: 'A0000800', date: '28.10.2026', from: 108, fromName: 'TOYBELEN', to: 1, toName: 'MERKEZ', lines: [{ productId: '101', sent: 2, open: 2 }] });
  config.update({ transfer: { aktif: false } });
  assert.deepStrictEqual(transfer.terminalGorunumu(), { on: false });
  config.update({ transfer: { aktif: true } });
});

test('yönetici açık gönderimi kapatır: kalan miktar kayıp eksik olur, gönderim terminallerden kalkar', () => {
  hazir([{ ind: 950, no: 'A0000950', tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [{ productId: '101', sent: 3, open: 3 }, { productId: '102', sent: 1, open: 1 }] }]);
  assert.strictEqual(transfer.acikKapat(999, 'yönetici'), false);
  assert.ok(transfer.acikKapat(950, 'yönetici'));
  const f = db.all("SELECT product_id, eksik, durum, cozum FROM transfer_fark WHERE sevk_ind=950 ORDER BY product_id");
  assert.deepStrictEqual(f.map((x) => [x.product_id, x.eksik, x.durum]), [['101', 3, 'KAYIP'], ['102', 1, 'KAYIP']]);
  assert.ok(db.get('SELECT 1 FROM transfer_kapali WHERE sevk_ind=950'));
  assert.strictEqual(transfer.terminalGorunumu().incoming.length, 0);
});

test('rafsız kabul: mal rafa kaldırılacak belge olarak bekler, rafla alınan kısım yerleşmiş sayılır, belgeden rafa kaldırılır', () => {
  hazir([{ ind: 710, no: 'A0000710', tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [
    { productId: '101', sent: 4, open: 4 },
    { productId: '103', sent: 2, open: 2 },
  ] }]);
  const o = op('TRANSFER_RECEIVE', { sevkId: '710', lines: [{ productId: '101', qty: 3, shelf: '' }, { productId: '101', qty: 1, shelf: 'T-01-01' }, { productId: '103', qty: 2 }] });
  const r = depo.islemler('TRM-02', 'veli', [o]);
  assert.ok(r[0].ok, JSON.stringify(r));

  const fis = depo.belgeler().find((b) => b.id === `TRF-${o.id}`);
  assert.ok(fis, 'kabul belgesi rafa kaldırılacaklar arasında');
  assert.deepStrictEqual([fis.depo, fis.izahat, fis.supplier, fis.acik, fis.kalan], [108, 'D129', 'MERKEZ deposundan', true, 5]);
  assert.deepStrictEqual(fis.lines.map((l) => [l.productId, l.accepted, l.shelved]), [['101', 4, 1], ['103', 2, 0]]);
  assert.strictEqual(depo.bekleyenKabul(108).get('101'), 3);
  const m = JSON.parse(depo.master().json);
  assert.ok(m.receipts.some((x) => x.id === fis.id && x.depot === 108 && x.lines.length === 2));

  // Rafa kaldır: belge satırı üzerinden (terminal PUTAWAY).
  const satir = fis.lines.find((l) => l.productId === '101');
  const p = depo.islemler('TRM-02', 'veli', [op('PUTAWAY', { receiptId: fis.id, lineId: satir.id, productId: '101', shelf: 'T-01-02', qty: 3, depot: 108 })]);
  assert.ok(p[0].ok, JSON.stringify(p));
  assert.strictEqual(depo.miktar(108, '101', 'T-01-02'), 3);
  const son = depo.belgeler().find((b) => b.id === fis.id);
  assert.deepStrictEqual(son.lines.map((l) => [l.productId, l.shelved]), [['101', 4], ['103', 0]]);
  assert.strictEqual(son.kalan, 2);
  assert.strictEqual(depo.bekleyenKabul(108).get('101'), undefined);
});
