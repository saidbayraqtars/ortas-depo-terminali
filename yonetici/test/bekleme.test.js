// Sanal bekleme depoları (bekleme.js): 106, 109 → Merkez. Vega'sız; görüntü elle verilir. Rakamlar Ortaş'ın gerçek akışından:
// fatura 109'a girer, muhasebe günde bir 37 ile Merkez'e geçirir, 109→106 da olur, Toybelen 108→1 gerçek bir mal hareketidir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-bekleme-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const bekleme = require('../server/bekleme');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const DEPOLAR = [{ ind: 1, ad: 'MERKEZ' }, { ind: 106, ad: 'TRANSFER SPCT 106' }, { ind: 108, ad: 'TOYBELEN' }, { ind: 109, ad: 'TRANSFER PCC 109' }];
const urunler = [
  { id: '101', code: 'YF-1', name: 'Yağ filtresi', unit: 'Adet' },
  { id: '102', code: 'HF-2', name: 'Hava filtresi', unit: 'Adet' },
  { id: '103', code: 'BJ-3', name: 'Buji', unit: 'Adet' },
];
const belge = (izahat, ind, d, docNo, ts, satirlar, ek = {}) => {
  const id = `${izahat}-${ind}-${d}`;
  return { id, izahat, tur: 'Belge', docNo, supplier: 'x', date: '01.10.2026', ts, depo: d, depoAd: DEPOLAR.find((x) => x.ind === d).ad, ...ek, lines: Object.entries(satirlar).map(([p, q]) => ({ id: `${id}-${p}`, productId: p, accepted: q })) };
};
const gor = (stock, receipts) => ({ surum: 2, at: Date.now(), depolar: DEPOLAR, products: urunler, stock, moved: [], barcodes: {}, receipts });

const F1 = belge('20', 500, 109, 'FAT-1', 1000, { 101: 100 });
const F2 = belge('20', 501, 109, 'FAT-2', 2000, { 102: 30 });
const F3 = belge('20', 502, 106, 'FAT-3', 3000, { 103: 40 });
const T37 = belge('D37', 900, 1, 'TRF-1', 4000, { 101: 100 }, { kaynakDepo: 109 }); // muhasebe faturayı geçirdi
const T106 = belge('D37', 901, 106, 'TRF-2', 4100, { 102: 30 }, { kaynakDepo: 109 }); // iki bekleme deposu arasında
const TOY = belge('D37', 902, 1, 'TRF-3', 4200, { 103: 5 }, { kaynakDepo: 108 }); // Toybelen'den gerçek gönderim

let n = 0;
const op = (type, payload) => ({ id: `op-${++n}`, type, createdAt: Date.now(), payload: { user: 'ali', device: 'TRM-01', ...payload } });
const calistir = (...ops) => {
  const r = depo.islemler('TRM-01', 'ali', ops);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  return ops.map((o) => db.get('SELECT id FROM movement WHERE op_id=? AND delta>0', o.id)?.id);
};
const putaway = (b, pid, shelf, qty, ek = {}) => op('PUTAWAY', { receiptId: b.id, lineId: `${b.id}-${pid}`, productId: pid, shelf, qty, depot: b.depo, ...ek });
const kalan = (id) => {
  const b = depo.belgeler().find((x) => x.id === id);
  return b ? b.kalan : null;
};
const ac = () => bekleme.ac({ depolar: [106, 109], hedef: 1 });
const sifirla = () => {
  for (const t of ['location', 'shelf', 'product_home', 'movement', 'receipt_shelved', 'bekleme_mahsup', 'receipt_state', 'count_line', 'count_shelf', 'count_session', 'op']) db.run(`DELETE FROM ${t}`);
  config.update({ bekleme: { aktif: false, depolar: [], hedef: null, gecis: null } });
};

test.beforeEach(() => {
  sifirla();
  depo._goruntuKur(gor({ 1: { 103: 5 }, 106: { 103: 40 }, 109: { 101: 100, 102: 30 } }, [F1, F2, F3]));
});

test('kapalıyken hiçbir şey değişmez: belge kendi deposunda, 37 ayrı iş', () => {
  depo._goruntuKur(gor({ 1: { 101: 100 } }, [F1, T37]));
  assert.deepStrictEqual(depo.depolar().map((d) => d.ind), [1, 106, 108, 109]);
  assert.strictEqual(depo.belgeler().find((b) => b.id === F1.id).depo, 109);
  assert.strictEqual(kalan(T37.id), 100);
  assert.strictEqual(depo.depoCoz(109), 109);
  assert.deepStrictEqual(bekleme.grupDepolari(1), [1]);
});

test('açıkken fatura Merkez belgesi olur, çalışan Merkez rafına kaldırır, bekleme deposu terminalden kalkar', () => {
  ac();
  assert.deepStrictEqual(depo.depolar().map((d) => d.ind), [1, 108]);
  const b = depo.belgeler().find((x) => x.id === F1.id);
  assert.strictEqual(b.depo, 1);
  assert.strictEqual(b.vegaDepo, 109);
  assert.strictEqual(b.depoAd, 'MERKEZ · TRANSFER PCC 109');
  // Terminal: Merkez'de stok ve belge görünür, 109 yok.
  const m = JSON.parse(depo.master().json);
  assert.deepStrictEqual(m.depots.map((d) => d.id), [1, 108]);
  assert.strictEqual(m.receipts.find((r) => r.id === F1.id).depot, 1);
  assert.strictEqual(m.products.find((p) => p.id === '101').stocks['1'], 100);
  assert.strictEqual(m.products.find((p) => p.id === '101').stocks['109'], undefined);

  calistir(putaway(F1, '101', 'A-01', 95));
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 95);
  assert.strictEqual(depo.miktar(109, '101', 'A-01'), 0);
  assert.ok(depo.rafVarMi(1, 'A-01'));
  assert.strictEqual(kalan(F1.id), 5);
});

test('asıl hata: rafa kaldırıldıktan sonra kesilen 37 ikinci kez iş çıkarmaz, 100 → 200 olmaz', () => {
  ac();
  calistir(putaway(F1, '101', 'A-01', 100));
  // Muhasebe 37 kesti: Vega'da mal Merkez'e geçti.
  depo._goruntuKur(gor({ 1: { 101: 100, 103: 5 }, 106: { 103: 40 }, 109: { 102: 30 } }, [F1, F2, F3, T37]));
  assert.strictEqual(depo.belgeler().find((b) => b.id === T37.id), undefined);
  assert.strictEqual(depo.bekleyenKabul(1).get('101') || 0, 0);
  assert.strictEqual(depo.vegaStok('101', 1), 100);
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 100);
});

test('ters sıra: 37 önce kesilse de iş tek belgede kalır, 95/100 ise 5 açık kalır', () => {
  ac();
  depo._goruntuKur(gor({ 1: { 101: 100 } }, [F1, T37]));
  assert.strictEqual(kalan(F1.id), 100);
  calistir(putaway(F1, '101', 'A-01', 95));
  assert.strictEqual(kalan(F1.id), 5);
  assert.strictEqual(depo.bekleyenKabul(1).get('101'), 5);
});

test('iki bekleme deposu arasındaki 37 iş üretmez, gerçek gönderim (108→1) normal belge kalır', () => {
  ac();
  depo._goruntuKur(gor({ 1: { 103: 5 }, 106: { 103: 40, 102: 30 } }, [F1, F2, F3, T106, TOY]));
  const idler = depo.belgeler().map((b) => b.id);
  assert.ok(!idler.includes(T106.id));
  assert.ok(idler.includes(TOY.id));
  assert.strictEqual(depo.vegaStok('102', 1), 30);
});

test('Vega görüntüsü ayarla yeniden yorumlanır: kapatınca 37 geri gelir, raf kaydı Merkez\'de kalır', () => {
  depo._goruntuKur(gor({ 1: { 101: 100 } }, [F1, T37]));
  ac();
  calistir(putaway(F1, '101', 'A-01', 10));
  assert.strictEqual(depo.belgeler().find((b) => b.id === T37.id), undefined);
  bekleme.kapat();
  assert.strictEqual(depo.belgeler().find((b) => b.id === F1.id).depo, 109);
  assert.strictEqual(kalan(T37.id), 100);
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 10);
  assert.ok(depo.depolar().some((d) => d.ind === 109));
});

test('geçiş: 109\'daki raf kaydı, raf tanımı ve adres Merkez\'e taşınır, hareket izi kalır', () => {
  calistir(putaway(F1, '101', 'B-02', 60)); // eski davranış: 109 deposunda rafa kalktı
  depo.zimmetEkle(109, '102', 'B-03', 'ADMIN');
  assert.strictEqual(depo.miktar(109, '101', 'B-02'), 60);
  const o = bekleme.onizle({ depolar: [106, 109], hedef: 1 });
  assert.deepStrictEqual(o.engeller, []);
  assert.deepStrictEqual({ ...o.raf }, { satir: 1, urun: 1, adet: 60 });
  assert.strictEqual(depo.miktar(109, '101', 'B-02'), 60, 'önizleme dokunmaz');

  ac();
  assert.strictEqual(depo.miktar(109, '101', 'B-02'), 0);
  assert.strictEqual(depo.miktar(1, '101', 'B-02'), 60);
  assert.ok(depo.rafVarMi(1, 'B-02'));
  assert.ok(!depo.rafVarMi(109, 'B-02'));
  assert.strictEqual(depo.zimmetler(1, '102')[0].shelf, 'B-03');
  assert.strictEqual(depo.zimmetler(109, '102').length, 0);
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM movement WHERE kind='DEPO_BIRLESTIR'").n, 2);
  assert.strictEqual(kalan(F1.id), 40, 'fatura ilerlemesi korunur');
});

test('geçiş: Merkez 37\'sinden rafa kalkan miktar açık faturadan düşülür, iş iki kez görünmez', () => {
  depo._goruntuKur(gor({ 1: { 101: 100 } }, [F1, T37]));
  calistir(putaway(T37, '101', 'A-01', 60));
  assert.strictEqual(kalan(F1.id), 100);
  assert.strictEqual(kalan(T37.id), 40);
  const o = bekleme.onizle({ depolar: [106, 109], hedef: 1 });
  assert.deepStrictEqual({ ...o.mahsup }, { satir: 1, urun: 1, adet: 60 });
  ac();
  assert.strictEqual(kalan(F1.id), 40);
  assert.strictEqual(depo.bekleyenKabul(1).get('101'), 40);
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 60);
  // İkinci açılış aynı miktarı bir daha yazmaz.
  bekleme.kapat();
  ac();
  assert.strictEqual(kalan(F1.id), 40);
});

test('çift rafa kaldırılmış mal listelenir, Geri al ile düşer ve listeden çıkar', () => {
  depo._goruntuKur(gor({ 1: { 101: 100 } }, [F1, T37]));
  calistir(putaway(F1, '101', 'B-02', 100));
  const [hareket] = calistir(putaway(T37, '101', 'A-01', 100));
  ac();
  assert.strictEqual(depo.miktar(1, '101', 'B-02') + depo.miktar(1, '101', 'A-01'), 200);
  const c = bekleme.rapor().cift;
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].fazla, 100);
  assert.strictEqual(c[0].hareketler[0].id, hareket);
  assert.strictEqual(depo.rafaKaldirmaGeriAl(hareket, 'yönetici', 'çift kayıt').belgeSatiri, false, 'gizli belge yeniden açılmaz');
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 0);
  assert.strictEqual(depo.miktar(1, '101', 'B-02'), 100);
  assert.strictEqual(bekleme.rapor().cift.length, 0);
  assert.strictEqual(kalan(F1.id), 0, 'fatura kapalı kalır');
});

test('açık faturadan düşülmüş rafa kaldırma geri alınınca fatura satırı da geri döner; çift sayılmaz', () => {
  depo._goruntuKur(gor({ 1: { 101: 100 } }, [F1, T37]));
  calistir(putaway(F1, '101', 'B-02', 30));
  const [h] = calistir(putaway(T37, '101', 'A-01', 50));
  ac();
  assert.strictEqual(kalan(F1.id), 20);
  assert.strictEqual(bekleme.rapor().cift.length, 0);
  depo.rafaKaldirmaGeriAl(h);
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 0);
  assert.strictEqual(kalan(F1.id), 70);
});

test('terminal eşitlemeden gelen eski işlemler doğru yere düşer', () => {
  depo._goruntuKur(gor({ 1: { 101: 100 } }, [F1, T37]));
  ac();
  // Gizlenen 37 belgesinden rafa kaldırma: miktar faturadan düşer, iş iki kez kalmaz.
  calistir(putaway(T37, '101', 'A-01', 10, { depot: 1 }));
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 10);
  assert.strictEqual(kalan(F1.id), 90);
  // Depo 109 seçili terminalden belgesiz rafa kaldırma ve raftan alma.
  calistir(op('PUTAWAY', { productId: '102', shelf: 'A-02', qty: 3, depot: 109 }));
  assert.strictEqual(depo.miktar(1, '102', 'A-02'), 3);
  calistir(op('PICK', { productId: '102', shelf: 'A-02', qty: 1, depot: 109 }));
  assert.strictEqual(depo.miktar(1, '102', 'A-02'), 2);
});

test('yalnız 109\'a yetkili kullanıcı geçişte Merkez\'e çevrilir, yetkisi sunucuda da geçer', () => {
  db.run("INSERT INTO app_user(username, name, salt, pin_hash, role, active, perms, depots, created_at) VALUES('veli','Veli','s','h','ozel',1,'*','109',1)");
  db.run("INSERT INTO app_user(username, name, salt, pin_hash, role, active, perms, depots, created_at) VALUES('can','Can','s','h','ozel',1,'*','108',1)");
  assert.deepStrictEqual(bekleme.onizle({ depolar: [106, 109], hedef: 1 }).kullanici, ['veli']);
  ac();
  assert.strictEqual(db.get("SELECT depots FROM app_user WHERE username='veli'").depots, '1');
  assert.strictEqual(db.get("SELECT depots FROM app_user WHERE username='can'").depots, '108');
  const r = depo.islemler('TRM-01', 'veli', [op('PUTAWAY', { user: 'veli', productId: '102', shelf: 'A-03', qty: 1, depot: 1 })]);
  assert.ok(r[0].ok, JSON.stringify(r));
  db.run("DELETE FROM app_user WHERE username IN ('veli','can')");
});

test('açılamayan durumlar: eksik seçim, transfer çifti, bekleme deposunda sonuçlanmamış sayım', () => {
  assert.match(bekleme.onizle({ depolar: [], hedef: 1 }).engeller.join(), /En az bir bekleme/);
  assert.match(bekleme.onizle({ depolar: [109], hedef: 109 }).engeller.join(), /bekleme deposu olamaz/);
  assert.match(bekleme.onizle({ depolar: [999], hedef: 1 }).engeller.join(), /kullanılan depolar/);
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, note, created_at, depo) VALUES('S1','S-1','x',0,'RAF','OPEN','ADMIN','',1,109)");
  assert.throws(() => ac(), /S-1 sayımı bekleme deposunda açık/);
  assert.strictEqual(bekleme.ayar(), null);
  db.run("DELETE FROM count_session WHERE id='S1'");
  config.update({ transfer: { cift: [1, 109] } });
  assert.match(bekleme.onizle({ depolar: [109], hedef: 1 }).engeller.join(), /transfer çiftinde/);
  config.update({ transfer: { cift: [] } });
});

test('rapor: fiyat bekleyen mal kaç gündür bekliyor, Merkez\'e geçip rafa kalkmayan mal', () => {
  const gun = 86400000;
  const eski = belge('20', 600, 109, 'FAT-E', Date.now() - 10 * gun, { 101: 20 });
  const yeni = belge('20', 601, 109, 'FAT-Y', Date.now() - 2 * gun, { 101: 15 });
  const gecen = belge('20', 602, 106, 'FAT-G', Date.now() - gun, { 103: 8 });
  depo._goruntuKur(gor({ 1: { 103: 8 }, 109: { 101: 30 } }, [eski, yeni, gecen]));
  ac();
  calistir(putaway(yeni, '101', 'A-01', 12));
  const r = bekleme.rapor();
  assert.strictEqual(r.aktif, true);
  // Stok 30: 15'i yeni, 15'i eski girişten kalır; en eski bekleyen 10 günlük.
  const b = r.bekleyen.find((x) => x.productId === '101');
  assert.deepStrictEqual({ vega: b.vega, rafta: b.rafta, gun: b.gun, depo: b.depo }, { vega: 30, rafta: 12, gun: 10, depo: 109 });
  // 103 muhasebe tarafından geçirilmiş (bekleme stoğu yok) ama hâlâ rafa kalkmamış.
  const h = r.hazir.find((x) => x.productId === '103');
  assert.strictEqual(h.miktar, 8);
  assert.deepStrictEqual(h.belgeler, ['FAT-G']);
  assert.strictEqual(r.hazir.find((x) => x.productId === '101'), undefined, 'bekleme stoğu kadarı henüz hazır değil');
});

test('sayım: fiyat bekleyen mal Merkez rafında sayılınca sahte fark çıkmaz, fiş grup toplamına göre hesaplanır', async () => {
  const vega = require('../server/vega');
  ac();
  calistir(putaway(F1, '101', 'A-01', 100));
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, note, created_at, depo) VALUES('S2','S-2','x',0,'RAF','OPEN','ADMIN','',?,1)", Date.now());
  depo.islemler('TRM-01', 'ali', [op('COUNT_SUBMIT', { sessionId: 'S2', shelves: ['A-01'], lines: [{ shelf: 'A-01', productId: '101', counted: 100, system: 100 }] })]);
  const o = depo.sayimOzet('S2');
  const u = o.urunler.find((x) => x.productId === '101');
  assert.strictEqual(u.vegaStock, 100);
  assert.strictEqual(u.fark, 0);
  const eski = vega.sayimYaz;
  let cagri = null;
  vega.sayimYaz = async (cfg, kalemler, sec) => {
    cagri = { kalemler, sec };
    return { docs: [], lines: [] };
  };
  try {
    await depo.sayimOnayla('S2', { vegaYaz: true });
  } finally {
    vega.sayimYaz = eski;
  }
  assert.strictEqual(cagri.sec.depo, 1);
  assert.deepStrictEqual(cagri.sec.stokDepolari, [1, 106, 109]);
  assert.strictEqual(cagri.kalemler[0].hedef, 100);
});

test('geçiş: 37 kendinden sonra gelen faturayı kapatmaz; eski çift kayıt yeni iş silmez', () => {
  const eski = belge('20', 700, 109, 'FAT-E', 1000, { 101: 5 });
  const t = belge('D37', 910, 1, 'TRF-E', 2000, { 101: 5 }, { kaynakDepo: 109 });
  const yeni = belge('20', 701, 106, 'FAT-Y', 3000, { 101: 5 });
  depo._goruntuKur(gor({ 1: { 101: 5 }, 106: { 101: 5 } }, [eski, t, yeni]));
  calistir(putaway(eski, '101', 'A-01', 5));
  calistir(putaway(t, '101', 'A-02', 5)); // aynı mal ikinci kez
  ac();
  assert.strictEqual(kalan(yeni.id), 5, 'yeni fatura açık kalır');
  calistir(putaway(yeni, '101', 'A-03', 5));
  // Yeni fatura da kalkınca toplam 15 kayıt, 10 giriş: 5'i çift olarak görünür.
  assert.strictEqual(bekleme.rapor().cift[0].fazla, 5);
});

test('gruptan dışarı giden mal faturadan düşer; Merkez olmayan malı istemez', () => {
  DEPOLAR.push({ ind: 110, ad: 'ZİNCİRDEPO' });
  try {
    const f = belge('20', 710, 106, 'FAT-S', 1000, { 101: 10 });
    const f2 = belge('20', 711, 106, 'FAT-T', 2000, { 101: 4 });
    const cik = belge('D37', 920, 110, 'TRF-Z', 3000, { 101: 6 }, { kaynakDepo: 106 });
    depo._goruntuKur(gor({ 106: { 101: 8 }, 110: { 101: 6 } }, [f, f2, cik]));
    ac();
    assert.strictEqual(kalan(f2.id), null, 'en yeni giriş önce düşer, satırı kalmayan belge görünmez');
    assert.strictEqual(kalan(f.id), 8);
    assert.strictEqual(depo.bekleyenKabul(1).get('101'), 8);
    assert.strictEqual(kalan(cik.id), 6, 'mal gittiği depoda normal belge');
  } finally {
    DEPOLAR.pop();
  }
});

test('Merkez\'den bekleme deposuna geri gelen 37 iş üretmez, gruba dışarıdan giren 37 tek belge olur', () => {
  const geri = belge('D37', 930, 109, 'TRF-G', 1000, { 101: 3 }, { kaynakDepo: 1 });
  const dis = belge('D37', 931, 109, 'TRF-D', 2000, { 102: 7 }, { kaynakDepo: 108 });
  const sonra = belge('D37', 932, 1, 'TRF-S', 3000, { 102: 7 }, { kaynakDepo: 109 });
  depo._goruntuKur(gor({ 1: { 102: 7 }, 109: { 101: 3 } }, [geri, dis, sonra]));
  ac();
  assert.strictEqual(depo.belgeler().find((b) => b.id === geri.id), undefined);
  assert.strictEqual(depo.belgeler().find((b) => b.id === sonra.id), undefined);
  const b = depo.belgeler().find((x) => x.id === dis.id);
  assert.strictEqual(b.depo, 1);
  assert.strictEqual(depo.bekleyenKabul(1).get('102'), 7);
});

test('kullanıcı hatası: aynı işlem iki kez gelir, fazla okutulur, hatalı girdi gönderilir', () => {
  ac();
  const o = putaway(F1, '101', 'A-01', 10);
  calistir(o);
  calistir(o);
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 10, 'aynı kimlik ikinci kez işlenmez');
  calistir(putaway(F1, '101', 'A-01', 95)); // belgede 90 kalmıştı
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 105, 'mal fiziken kondu, kayıt kaybolmaz');
  assert.strictEqual(kalan(F1.id), 0);
  const ret = depo.islemler('TRM-01', 'ali', [
    putaway(F2, '102', 'A-02', -3),
    putaway(F2, '102', '', 1),
    op('PUTAWAY', { receiptId: F2.id, productId: '999', shelf: 'A-02', qty: 1 }),
    op('PICK', { productId: '101', shelf: 'A-01', qty: 0, depot: 109 }),
  ]);
  assert.ok(ret.every((x) => !x.ok), JSON.stringify(ret));
  assert.strictEqual(kalan(F2.id), 30);
});

test('kullanıcı hatası: raftan fazla alma eksiye düşmez, depo 109 seçili terminal Merkez rafından düşer', () => {
  ac();
  calistir(putaway(F1, '101', 'A-01', 4));
  calistir(op('PICK', { productId: '101', shelf: 'A-01', qty: 50, depot: 109 }));
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 0);
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM location WHERE depo IN (106,109)").n, 0);
});

test('kullanıcı hatası: Toybelen\'e yetkili kullanıcı Merkez\'e dönüşen belgeyi kaldıramaz', () => {
  db.run("INSERT INTO app_user(username, name, salt, pin_hash, role, active, perms, depots, created_at) VALUES('toy','T','s','h','ozel',1,'*','108',1)");
  ac();
  const r = depo.islemler('TRM-01', 'toy', [{ ...putaway(F1, '101', 'A-01', 1), payload: { ...putaway(F1, '101', 'A-01', 1).payload, user: 'toy' } }]);
  assert.strictEqual(r[0].ok, false);
  assert.strictEqual(r[0].code, 'YETKI');
  assert.strictEqual(kalan(F1.id), 100);
  db.run("DELETE FROM app_user WHERE username='toy'");
});

test('kullanıcı hatası: gizlenen belgeden eski terminal, yeni faturanın işini de kapatır (mal şimdi kondu)', () => {
  const t = belge('D37', 940, 1, 'TRF-K', 1000, { 101: 5 }, { kaynakDepo: 109 });
  const f = belge('20', 720, 109, 'FAT-K', 2000, { 101: 5 });
  depo._goruntuKur(gor({ 1: { 101: 5 }, 109: { 101: 5 } }, [t, f]));
  ac();
  calistir(putaway(t, '101', 'A-01', 5, { depot: 1 }));
  assert.strictEqual(kalan(f.id), 0);
});

test('kullanıcı hatası: kapatıp bir gün çalışınca yeniden açmak kayıtları toparlar', () => {
  depo._goruntuKur(gor({ 1: { 101: 100 } }, [F1, T37]));
  ac();
  calistir(putaway(F1, '101', 'A-01', 10));
  bekleme.kapat();
  // Kapalıyken terminaller eski düzende: 109 belgesi 109 rafına, 37 Merkez rafına.
  calistir(putaway(F1, '101', 'B-01', 20));
  calistir(putaway(T37, '101', 'A-02', 30));
  assert.strictEqual(depo.miktar(109, '101', 'B-01'), 20);
  ac();
  assert.strictEqual(depo.miktar(1, '101', 'B-01'), 20);
  assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM location WHERE depo IN (106,109)").n, 0);
  assert.strictEqual(kalan(F1.id), 40, '100 − 30 fatura − 30 transfer');
});

test('yönetici hatası: ikinci kez açılamaz, varsayılan depo bekleme deposu seçilemez, hedef olmayan yerden çift açılmaz', () => {
  ac();
  assert.match(bekleme.onizle({ depolar: [106, 109], hedef: 1 }).engeller.join(), /zaten açık/);
  assert.throws(() => ac(), /zaten açık/);
  bekleme.kapat();
  assert.match(bekleme.onizle({ depolar: [1], hedef: 109 }).engeller.join(), /Varsayılan depo/);
  assert.strictEqual(bekleme.ayar(), null);
});

test('yönetici: elle kapatılmış faturaya mahsup yazılmaz, kapalı belge açık sayılmaz', () => {
  depo._goruntuKur(gor({ 1: { 101: 100 } }, [F1, T37]));
  calistir(putaway(T37, '101', 'A-01', 60));
  db.run("INSERT INTO receipt_state(receipt_id, closed, closed_at, note) VALUES(?,1,1,'x')", F1.id);
  ac();
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM bekleme_mahsup').n, 0);
  assert.strictEqual(depo.belgeler().find((b) => b.id === F1.id).acik, false);
});

test('Vega\'dan silinen fatura: raf kaydı kalır, iş kaybolur, işlem hatası vermez', () => {
  ac();
  calistir(putaway(F1, '101', 'A-01', 40));
  depo._goruntuKur(gor({ 109: { 102: 30 } }, [F2]));
  assert.strictEqual(depo.belgeler().find((b) => b.id === F1.id), undefined);
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 40);
  calistir(op('PUTAWAY', { receiptId: F1.id, lineId: `${F1.id}-101`, productId: '101', shelf: 'A-01', qty: 1, depot: 109 }));
  assert.strictEqual(depo.miktar(1, '101', 'A-01'), 41);
});

test('stok tanısı: grup toplamı ve bekleyen tek satırda', () => {
  assert.deepStrictEqual(bekleme.birlestir({ 1: 5, 106: 2, 109: 3, 108: 1 }, { hedef: 1, depolar: new Set([106, 109]) }), { 1: 10, 108: 1 });
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
