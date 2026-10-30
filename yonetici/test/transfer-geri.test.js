// Transferi geri alma (yönetici): Vega fişi silinir, raf stoku eski haline döner, kabulü başlamış gönderim geri alınmaz.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-transfer-geri-'));
const config = require('../server/config');
const db = require('../server/db');
const vega = require('../server/vega');
const depo = require('../server/depo');
const transfer = require('../server/transfer');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 }, transfer: { aktif: true, cift: [1, 108] } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const DEPOLAR = [{ ind: 1, ad: 'MERKEZ' }, { ind: 3, ad: 'TRANSFER' }, { ind: 108, ad: 'TOYBELEN' }];
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

let n = 0;
const op = (type, payload) => ({ id: `g-${++n}`, type, createdAt: Date.now(), payload: { user: 'ali', device: 'TRM-01', ...payload } });

// Vega taklidi: yazma, silme ve okuma.
let sayac = 7000;
const silinenler = [];
let silmeHata = null;
let okunan = { sevkler: [], havuz: [] };
vega.transferYaz = async (cfg, p) => ({ ind: ++sayac, belgeNo: `A${String(sayac).padStart(7, '0')}`, kalem: p.kalemler.length, tutar: 0, userno: 100, negatif: 0, firmaDonem: 'F0101D0020' });
vega.transferGeriAl = async (cfg, p) => {
  if (silmeHata) throw new Error(silmeHata);
  silinenler.push(p);
  return { satir: 1, envanter: 2 };
};
vega.hazirMi = () => true;
vega.depolar = async () => DEPOLAR;
vega.transferOku = async () => okunan;

const sevkOku = (t, miktar, alinan = 0) => ({
  sevkler: [{ ind: t.vega_ind, no: t.belge_no, tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [{ stokno: '101', miktar }] }],
  havuz: [{ kaynak: 1, hedef: 108, stokno: '101', gonderilen: miktar, alinan }],
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('yazılmamış gönderim geri alınır: raf stoku döner, Vega\'ya hiç yazılmaz, ikinci kez geri alınamaz', async () => {
  depo.miktarAyarla(1, '101', 'A-01-01', 10, { ts: 1, kind: 'PUTAWAY' });
  transfer._gorunum({ at: Date.now(), yolda: 3, depolar: DEPOLAR, sevkler: [], ozet: 'x' });
  const o = op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '101', qty: 4, shelf: 'A-01-01' }] });
  assert.ok(depo.islemler('TRM-01', 'ali', [o])[0].ok);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 6);

  const r = await transfer.geriAl(o.id, 'yönetici', 'yanlış depo');
  assert.deepStrictEqual([r.vegaSilindi, r.uyarilar], [false, []]);
  assert.strictEqual(silinenler.length, 0, 'Vega\'da silinecek bir şey yoktu');
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 10);
  const t = db.get('SELECT durum, geri_user, geri_not FROM transfer WHERE id=?', o.id);
  assert.deepStrictEqual({ ...t }, { durum: 'GERI', geri_user: 'yönetici', geri_not: 'yanlış depo' });
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM movement WHERE kind='TRANSFER_GERI' AND op_id IS NULL").n, 1);

  // Geri alınan kayıt Vega'ya yazılmaz.
  await transfer.yaz();
  assert.strictEqual(db.get('SELECT durum FROM transfer WHERE id=?', o.id).durum, 'GERI');
  await assert.rejects(() => transfer.geriAl(o.id), /zaten geri alınmış/);
  await assert.rejects(() => transfer.geriAl('yok'), /bulunamadı/);
});

test('yazılmış gönderim: Vega fişi silinir ve raf stoku döner; Vega silemezse hiçbir şey değişmez', async () => {
  depo.miktarAyarla(1, '101', 'A-01-01', 10, { ts: 2, kind: 'PUTAWAY' });
  const o = op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '101', qty: 4, shelf: 'A-01-01' }] });
  assert.ok(depo.islemler('TRM-01', 'ali', [o])[0].ok);
  await transfer.yaz();
  const t = db.get('SELECT * FROM transfer WHERE id=?', o.id);
  assert.strictEqual(t.durum, 'YAZILDI');
  assert.strictEqual(t.firma_donem, 'F0101D0020');
  okunan = sevkOku(t, 4);

  silmeHata = 'Vega\'da bulunamadı';
  await assert.rejects(() => transfer.geriAl(o.id), /Vega'da bulunamadı/);
  assert.strictEqual(db.get('SELECT durum FROM transfer WHERE id=?', o.id).durum, 'YAZILDI');
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 6, 'Vega silinemeyince program stoku da değişmedi');
  silmeHata = null;

  const r = await transfer.geriAl(o.id, 'yönetici');
  assert.strictEqual(r.vegaSilindi, true);
  assert.deepStrictEqual(silinenler.at(-1), { tip: 128, ind: t.vega_ind, belgeNo: t.belge_no, firmaDonem: 'F0101D0020' });
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 10);
  assert.strictEqual(db.get('SELECT durum FROM transfer WHERE id=?', o.id).durum, 'GERI');
});

test('kabulü başlamış gönderim geri alınmaz; önce kabul geri alınmalı', async () => {
  depo.miktarAyarla(1, '101', 'A-01-01', 10, { ts: 3, kind: 'PUTAWAY' });
  const o = op('TRANSFER_SEND', { from: 1, to: 108, lines: [{ productId: '101', qty: 4, shelf: 'A-01-01' }] });
  assert.ok(depo.islemler('TRM-01', 'ali', [o])[0].ok);
  await transfer.yaz();
  const t = db.get('SELECT * FROM transfer WHERE id=?', o.id);
  const silinen = silinenler.length;
  // Vega'ya göre 1 adet alınmış: açık miktar 3.
  okunan = sevkOku(t, 4, 1);
  await assert.rejects(() => transfer.geriAl(o.id), /1 adedi kabul edilmiş; önce kabul fişini geri alın/);
  // Gönderim hiç açık görünmüyorsa (tamamen alınmış ya da kapatılmış) de reddedilir.
  okunan = { sevkler: [], havuz: [] };
  await assert.rejects(() => transfer.geriAl(o.id), /açık görünmüyor/);
  assert.strictEqual(silinenler.length, silinen, 'Vega\'dan bir şey silinmedi');
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 6);
  // Temizlik: sonraki testler bu gönderimi görmesin.
  okunan = sevkOku(t, 4);
  await transfer.geriAl(o.id, 'yönetici');
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 10);
});

test('yazılmış kabul geri alınır: Vega 129 silinir, rafa giren düşer, eksik kaydı ve kapalı işareti kalkar, gönderim yeniden açılır', async () => {
  const sevk = { ind: 900, no: 'A0000900', tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [{ productId: '101', sent: 5, open: 5 }, { productId: '102', sent: 2, open: 2 }] };
  transfer._gorunum({ at: Date.now(), yolda: 3, depolar: DEPOLAR, sevkler: [sevk], ozet: 'x' });
  // Kabulde 101'den 4 adet T-01-01'e alınır, 1 adet gelmez; 102 hiç gelmez (ikisi de eksik kaydı olur, gönderim kapanır).
  const o = op('TRANSFER_RECEIVE', { sevkId: '900', lines: [{ productId: '101', qty: 4, shelf: 'T-01-01' }] });
  assert.ok(depo.islemler('TRM-02', 'veli', [o])[0].ok);
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), 4);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM transfer_fark WHERE transfer_id=?', o.id).n, 2);
  assert.ok(db.get('SELECT 1 FROM transfer_kapali WHERE sevk_ind=900'));
  await transfer.yaz();
  const t = db.get('SELECT * FROM transfer WHERE id=?', o.id);
  assert.strictEqual(t.durum, 'YAZILDI');
  assert.ok(depo.belgeler().some((b) => b.id === `TRF-${o.id}`), 'rafa kaldırılacak/yerleşmiş kabul belgesi var');

  // Vega 129 silindiğinde gönderim yine tamamen açık okunur.
  okunan = { sevkler: [{ ind: 900, no: 'A0000900', tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [{ stokno: '101', miktar: 5 }, { stokno: '102', miktar: 2 }] }], havuz: [{ kaynak: 1, hedef: 108, stokno: '101', gonderilen: 5, alinan: 0 }, { kaynak: 1, hedef: 108, stokno: '102', gonderilen: 2, alinan: 0 }] };
  const r = await transfer.geriAl(o.id, 'yönetici', 'yanlış gönderim kabul edildi');
  assert.strictEqual(r.vegaSilindi, true);
  assert.deepStrictEqual(r.uyarilar, []);
  assert.strictEqual(silinenler.at(-1).tip, 129);
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), 0, 'rafa giren geri düşüldü');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM transfer_fark WHERE transfer_id=?', o.id).n, 0);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM transfer_kapali WHERE sevk_ind=900').n, 0);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM receipt_shelved WHERE receipt_id=?', `TRF-${o.id}`).n, 0);
  assert.ok(!depo.belgeler().some((b) => b.id === `TRF-${o.id}`), 'geri alınan kabul belgesi kalktı');
  await transfer.yenile();
  assert.deepStrictEqual(
    transfer.terminalGorunumu().incoming.map((s) => [s.id, s.lines.map((l) => [l.productId, l.open])]),
    [['900', [['101', 5], ['102', 2]]]],
    'gönderim terminallerde yeniden açık',
  );
});

test('kabul geri alınırken raftaki miktar azalmışsa olan kadarı düşülür ve uyarı verilir', async () => {
  const sevk = { ind: 901, no: 'A0000901', tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [{ productId: '101', sent: 3, open: 3 }] };
  transfer._gorunum({ at: Date.now(), yolda: 3, depolar: DEPOLAR, sevkler: [sevk], ozet: 'x' });
  const o = op('TRANSFER_RECEIVE', { sevkId: '901', lines: [{ productId: '101', qty: 3, shelf: 'T-01-02' }] });
  assert.ok(depo.islemler('TRM-02', 'veli', [o])[0].ok);
  await transfer.yaz();
  // Mal rafta satıldı/alındı: raf 3'ten 1'e düştü.
  depo.miktarEkle(108, '101', 'T-01-02', -2, { ts: 5, kind: 'PICK' });
  okunan = { sevkler: [], havuz: [] };
  const r = await transfer.geriAl(o.id, 'yönetici');
  assert.strictEqual(r.uyarilar.length, 1);
  assert.match(r.uyarilar[0], /HF-0310|YF-1042/);
  assert.match(r.uyarilar[0], /3 adet girmişti, rafta 1 vardı/);
  assert.strictEqual(depo.miktar(108, '101', 'T-01-02'), 0);
});

test('Vega\'ya yazılmamış kabul (bekleyen) geri alınır; kısmi kabulden sonra boş bitirme (Vega fişi yok) da geri alınabilir', async () => {
  const sevk = { ind: 902, no: 'A0000902', tarih: new Date('2026-10-28T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [{ productId: '101', sent: 2, open: 2 }] };
  transfer._gorunum({ at: Date.now(), yolda: 3, depolar: DEPOLAR, sevkler: [sevk], ozet: 'x' });
  const kismi = op('TRANSFER_RECEIVE', { sevkId: '902', partial: true, lines: [{ productId: '101', qty: 1, shelf: 'T-01-01' }] });
  assert.ok(depo.islemler('TRM-02', 'veli', [kismi])[0].ok);
  const bitir = op('TRANSFER_RECEIVE', { sevkId: '902', lines: [] });
  assert.ok(depo.islemler('TRM-02', 'veli', [bitir])[0].ok);
  assert.strictEqual(db.get('SELECT durum FROM transfer WHERE id=?', bitir.id).durum, 'YAZILDI');
  assert.strictEqual(db.get('SELECT vega_ind FROM transfer WHERE id=?', bitir.id).vega_ind, null);
  const silinen = silinenler.length;
  const r1 = await transfer.geriAl(bitir.id, 'yönetici');
  assert.strictEqual(r1.vegaSilindi, false, 'boş bitirmenin Vega fişi yok');
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM transfer_kapali WHERE sevk_ind=902').n, 0);
  // Henüz yazılmamış kısmi kabul.
  assert.strictEqual(db.get('SELECT durum FROM transfer WHERE id=?', kismi.id).durum, 'BEKLIYOR');
  const r2 = await transfer.geriAl(kismi.id, 'yönetici');
  assert.strictEqual(r2.vegaSilindi, false);
  assert.strictEqual(silinenler.length, silinen);
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), 0);
  await transfer.yaz();
  assert.strictEqual(db.get('SELECT durum FROM transfer WHERE id=?', kismi.id).durum, 'GERI', 'geri alınan kabul Vega\'ya yazılmaz');
});

test('liste: geri alınan kayıt durumuyla görünür', () => {
  const l = transfer.liste();
  const geri = l.transferler.filter((t) => t.durum === 'GERI');
  assert.ok(geri.length >= 5);
  assert.ok(geri.every((t) => t.geri_user === 'yönetici' && t.geri_at));
});
