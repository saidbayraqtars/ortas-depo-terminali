// Kabulde belgeden fazla gelen mal: yönetici onayına düşer, stok ve belge onaya kadar değişmez; onaylanınca alıcı depoda
// rafa kaldırılacak belge olur. Ürün sayımı (stok kodundan raf) ve çalışan raporu özeti de burada.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-fazla-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const transfer = require('../server/transfer');
const calisan = require('../server/calisan');
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
  stock: { 1: { 101: 24, 102: 10 } }, moved: [], barcodes: { 101: ['8690001'] }, receipts: [],
});
depo.rafEkle(1, 'A-01-01');
depo.rafEkle(1, 'A-01-02');
depo.rafEkle(108, 'T-01-01');
depo.miktarAyarla(1, '101', 'A-01-01', 10, { ts: 1, kind: 'PUTAWAY' });
depo.miktarAyarla(1, '101', 'A-01-02', 3, { ts: 1, kind: 'PUTAWAY' });

let n = 0;
const op = (type, payload) => ({ id: `f-${++n}`, type, createdAt: Date.now(), payload: { user: 'ali', device: 'TRM-01', ...payload } });

test('fazla: kabulde fazla okutulan miktar onaya düşer, stok değişmez; onaylanınca alıcıya belge olarak eklenir', () => {
  const sevk = { ind: 800, no: 'A0000800', tarih: new Date('2026-11-02T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [{ productId: '101', sent: 2, open: 2 }] };
  transfer._gorunum({ at: Date.now(), yolda: 3, depolar: DEPOLAR, sevkler: [sevk], ozet: 'x' });
  const r = depo.islemler('TRM-02', 'veli', [op('TRANSFER_RECEIVE', { sevkId: '800', lines: [{ productId: '101', qty: 2, shelf: 'T-01-01' }], extra: [{ productId: '101', qty: 1 }] })]);
  assert.ok(r[0].ok, JSON.stringify(r));
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), 2, 'yalnız gönderilen kadar girer');
  let f = db.get('SELECT * FROM transfer_fazla');
  assert.deepStrictEqual([f.product_id, f.qty, f.sent, f.durum, f.from_depo, f.to_depo], ['101', 1, 2, 'BEKLIYOR', 1, 108]);
  assert.strictEqual(transfer.liste().bekleyenFazla.n, 1);
  assert.ok(!depo.belgeler().some((b) => b.docNo.includes('(fazla)')), 'onaya kadar belge yok');

  assert.ok(transfer.fazlaOnayla(f.id, 'yönetici'));
  f = db.get('SELECT * FROM transfer_fazla');
  assert.strictEqual(f.durum, 'ONAYLANDI');
  const b = depo.belgeler().find((x) => x.docNo.includes('(fazla)'));
  assert.ok(b, 'rafa kaldırılacak fazla belgesi çıktı');
  assert.deepStrictEqual([b.depo, b.kabul, b.kalan], [108, 1, 1]);
  assert.throws(() => transfer.fazlaOnayla(f.id), /zaten karara/);
  // Açık gönderim havuzuna dokunmaz: transfer kind='FAZLA' kabul sayılmaz.
  assert.strictEqual(db.all("SELECT 1 FROM transfer WHERE kind='RECEIVE' AND durum='BEKLIYOR' AND id LIKE 'FAZLA-%'").length, 0);
});

test('fazla: reddedilirse yalnız kayıt kalır', () => {
  const sevk = { ind: 801, no: 'A0000801', tarih: new Date('2026-11-02T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [{ productId: '102', sent: 1, open: 1 }] };
  transfer._gorunum({ at: Date.now(), yolda: 3, depolar: DEPOLAR, sevkler: [sevk], ozet: 'y' });
  const r = depo.islemler('TRM-02', 'veli', [op('TRANSFER_RECEIVE', { sevkId: '801', lines: [{ productId: '102', qty: 1, shelf: 'T-01-01' }], extra: [{ productId: '102', qty: 2 }] })]);
  assert.ok(r[0].ok, JSON.stringify(r));
  const f = db.get("SELECT * FROM transfer_fazla WHERE product_id='102'");
  assert.ok(transfer.fazlaReddet(f.id, 'yönetici', 'sayım hatası'));
  assert.strictEqual(db.get('SELECT durum, karar_not FROM transfer_fazla WHERE id=?', f.id).durum, 'REDDEDILDI');
  assert.ok(!depo.belgeler().some((b) => b.docNo.includes('A0000801') && b.docNo.includes('fazla')));
});

test('ürün sayımı: stok kodu ya da barkoddan ürünün depodaki rafları bulunur', () => {
  const u = depo.urunRaflari(1, 'yf-1042\n8690001\nHF-0310\nYOK-1');
  assert.deepStrictEqual(u.raflar, ['A-01-01', 'A-01-02']);
  assert.strictEqual(u.bulunan.length, 1, 'aynı ürün iki kez sayılmaz');
  assert.deepStrictEqual(u.bulunamayan, ['YOK-1']);
  assert.deepStrictEqual(u.rafsiz, ['HF-0310']);
});

test('çalışan raporu: kullanıcı başına satır/adet, türe göre kırılım, geri alma toplama girmez', () => {
  const t = new Date('2026-11-02T10:00:00').getTime();
  const r = calisan.ozetle([
    { user: 'ali', kind: 'PUTAWAY', product_id: '101', delta: 5, ts: t },
    { user: 'ali', kind: 'PUTAWAY', product_id: '102', delta: 2, ts: t + 1000 },
    { user: 'ali', kind: 'PUTAWAY_GERI', product_id: '102', delta: -2, ts: t + 2000 },
    { user: 'veli', kind: 'TRANSFER_OUT_DEPO', product_id: '101', delta: -3, ts: t + 86400000 },
    { user: 'veli', kind: 'ADJUST', product_id: '101', delta: 9, ts: t },
    { user: null, kind: 'PUTAWAY', product_id: '101', delta: 1, ts: t },
  ]);
  assert.deepStrictEqual(r.calisanlar.map((c) => c.user), ['ali', 'veli']);
  const ali = r.calisanlar[0];
  assert.deepStrictEqual([ali.satir, ali.adet, ali.urun, ali.aktifGun], [2, 7, 2, 1]);
  assert.strictEqual(ali.turler.PUTAWAY_GERI.satir, 1);
  assert.strictEqual(r.calisanlar[1].adet, 3, 'düzeltme (ADJUST) rapora girmez');
  assert.strictEqual(r.gunluk.length, 3);
});

test('çalışan raporu: Excel dosyası üretilir', async () => {
  const buf = await calisan.excel(calisan.ozetle([{ user: 'ali', kind: 'PUTAWAY', product_id: '101', delta: 5, ts: Date.now() }]), { bas: '2026-11-01', bit: '2026-11-03', depoAd: 'MERKEZ' });
  assert.ok(Buffer.from(buf).length > 1000);
  assert.strictEqual(Buffer.from(buf).subarray(0, 2).toString(), 'PK');
});

test('reddet: kabul geri alınır, raf girişi düşer, not kaydedilir; terminale not gider; kabul yenilenince not silinir', async () => {
  const sevk = { ind: 802, no: 'A0000802', tarih: new Date('2026-11-02T00:00:00'), kaynak: 1, hedef: 108, kalemler: [], satirlar: [{ productId: '101', sent: 2, open: 2 }, { productId: '102', sent: 3, open: 3 }] };
  transfer._gorunum({ at: Date.now(), yolda: 3, depolar: DEPOLAR, sevkler: [sevk], ozet: 'z' });
  const once = depo.miktar(108, '101', 'T-01-01');
  const r = depo.islemler('TRM-02', 'veli', [op('TRANSFER_RECEIVE', { sevkId: '802', lines: [{ productId: '101', qty: 2, shelf: 'T-01-01' }, { productId: '102', qty: 1, shelf: 'T-01-01' }], extra: [{ productId: '101', qty: 1 }] })]);
  assert.ok(r[0].ok, JSON.stringify(r));
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), once + 2);
  const fazla = db.get("SELECT * FROM transfer_fazla WHERE sevk_ind=802");
  const eksik = db.get("SELECT * FROM transfer_fark WHERE sevk_ind=802");
  assert.ok(eksik && fazla);

  const s = await transfer.tekrarIste('fazla', fazla.id, 'yönetici', 'Bu ürün kaç olmalıydı?');
  assert.strictEqual(s.vegaSilindi, false, 'Vega\'ya yazılmamıştı');
  assert.strictEqual(depo.miktar(108, '101', 'T-01-01'), once, 'raf girişi düştü');
  assert.strictEqual(db.get('SELECT durum FROM transfer_fazla WHERE id=?', fazla.id).durum, 'REDDEDILDI');
  assert.strictEqual(db.all('SELECT * FROM transfer_fark WHERE sevk_ind=802').length, 0, 'eksik kaydı kalktı');
  assert.strictEqual(db.get('SELECT note FROM transfer_not WHERE sevk_ind=802').note, 'Bu ürün kaç olmalıydı?');

  // Gönderim Vega'dan yeniden okununca (burada elle) terminal notu görür.
  transfer._gorunum({ sevkler: [sevk] });
  assert.strictEqual(transfer.terminalGorunumu().incoming.find((x) => x.id === 'URUN-1-108').note, 'Bu ürün kaç olmalıydı?');
  assert.strictEqual(await transfer.tekrarIste('fazla', 99999), null);

  // Yeniden doğru girilince not kalkar.
  const r2 = depo.islemler('TRM-02', 'veli', [op('TRANSFER_RECEIVE', { sevkId: '802', lines: [{ productId: '101', qty: 2, shelf: 'T-01-01' }, { productId: '102', qty: 3, shelf: 'T-01-01' }] })]);
  assert.ok(r2[0].ok, JSON.stringify(r2));
  assert.strictEqual(db.get('SELECT 1 FROM transfer_not WHERE sevk_ind=802'), undefined);
});
