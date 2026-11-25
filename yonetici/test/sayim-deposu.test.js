// Yalnız sayım yapılan depolar (config.vega.sayimDepolar; Ortaş: 110 ZİNCİRDEPO, İsmail isteği 2026-11-23).
// Depo kullanılan depolar arasında durur (sayımda, terminalde seçilir, Vega stoku okunur) ama mal kabul işi üretmez,
// rafları KOD10'a yazılmaz, B2B raf listesi kopyalanmaz. Vega'sız; görüntü elle verilir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-sayimdepo-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const iceaktar = require('../server/iceaktar');
const vega = require('../server/vega');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

const belge = (id, d, satirlar) => ({
  id, izahat: '20', tur: 'Alış faturası', docNo: id, supplier: 'Tedarikçi', date: '20.11.2026', ts: 1, depo: d, depoAd: String(d),
  lines: satirlar.map(([pid, accepted]) => ({ id: `${id}-${pid}`, productId: pid, accepted })),
});
const kur = () =>
  depo._goruntuKur({
    surum: 2,
    at: Date.now(),
    depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 108, ad: 'TOYBELEN SANAYİ' }, { ind: 110, ad: 'ZİNCİRDEPO' }],
    products: [
      { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
      { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
    ],
    stock: { 1: { 101: 5 }, 110: { 101: 7, 102: 3 } },
    moved: [],
    barcodes: {},
    receipts: [belge('FAT-M', 1, [['101', 5]]), belge('FAT-Z', 110, [['101', 7], ['102', 3]])],
  }, true);

test('ayar yokken Zincir de mal kabul işi üretir (eski davranış)', () => {
  kur();
  assert.deepStrictEqual(depo.sayimDepolari(), new Set());
  assert.strictEqual(depo.bekleyenKabul(110).get('101'), 7);
});

test('yalnız sayım: depo listede ve stokta kalır, belgesi ve rafa bekleyeni çıkmaz', () => {
  config.update({ vega: { sayimDepolar: [110] } });
  kur();
  assert.ok(depo.depolar().some((d) => d.ind === 110), 'sayımda ve terminalde seçilebilir');
  assert.strictEqual(depo.vegaStok('101', 110), 7, 'Vega stoku okunur (genel sayım, sayım farkı)');
  assert.strictEqual(depo.bekleyenKabul(110).size, 0);
  assert.strictEqual(depo.bekleyenKabul(1).get('101'), 5, 'öteki depolar etkilenmez');
  assert.ok(!depo.belgeler().some((r) => r.depo === 110));
  assert.ok(!JSON.parse(depo.master().json).depots.every((d) => d.id !== 110), 'terminal depo listesinde');
  assert.deepStrictEqual(depo.bekleyenListe().ozet.depolar.map((d) => d.depo), [1]);
});

test('varsayılan depo ayarda yoksa yalnız sayım deposu seçilmez', () => {
  config.update({ vega: { depo: null, sayimDepolar: [1] } });
  kur();
  assert.strictEqual(depo.varsayilanDepo(), 108);
  config.update({ vega: { depo: 1, sayimDepolar: [110] } });
  kur();
  assert.strictEqual(depo.varsayilanDepo(), 1);
});

test('Zincir rafları stok kartının raf adresine (KOD10) yazılmaz', async () => {
  const yazilan = [];
  const eskiYaz = vega.kartAlanYaz;
  const eskiUz = vega.kartAlanUzunluk;
  vega.kartAlanUzunluk = async () => 50;
  vega.kartAlanYaz = async (cfg, alan, satirlar, bitti) => {
    yazilan.push(...satirlar.map((s) => [s.id, s.deger]));
    bitti(satirlar);
    return satirlar.length;
  };
  try {
    db.run('DELETE FROM product_home');
    config.update({ rafAdresi: { alan: 'KOD10', depo: 1, yaz: true, tumDepolar: true } });
    depo.goruntu().rafAlan = 'KOD10';
    depo.zimmetEkle(1, '101', 'A-01-01');
    depo.zimmetEkle(110, '101', 'Z-01-01');
    depo.zimmetEkle(110, '102', 'Z-02-02');
    const s = await depo.vegaRafYaz();
    assert.deepStrictEqual(yazilan, [['101', 'A-01-01']]);
    assert.strictEqual(s.adres, 1);
    // Zincir yalnız sayımdan çıkarılınca rafları da yazılır (durum anahtarı ayarı içerir).
    yazilan.length = 0;
    config.update({ vega: { sayimDepolar: [] } });
    await depo.vegaRafYaz();
    assert.deepStrictEqual(yazilan.sort(), [['101', 'A-01-01, Z-01-01'], ['102', 'Z-02-02']]);
  } finally {
    vega.kartAlanYaz = eskiYaz;
    vega.kartAlanUzunluk = eskiUz;
    config.update({ rafAdresi: { alan: '', yaz: false }, vega: { sayimDepolar: [110] } });
    depo.goruntu().rafAlan = null;
    db.run('DELETE FROM product_home');
  }
});

test('paketle gelen B2B raf listesi Zincir\'e kopyalanmaz', () => {
  config.update({ vega: { sayimDepolar: [110] } });
  kur();
  const dosya = path.join(dir, 'b2b.tsv');
  fs.writeFileSync(dosya, 'YF-1042\tA-01-01\n');
  const r = iceaktar.otomatik({ dosya });
  assert.deepStrictEqual(r.depolar, [1, 108]);
  assert.deepStrictEqual(depo.zimmetler(110, '101'), []);
  assert.deepStrictEqual(depo.zimmetler(1, '101').map((z) => z.shelf), ['A-01-01']);
});

// 2026-11-25 Ortaş: 106'ya (bekleme deposu) giren alışlar Merkez'de bekleyen olmadı, terminalde "Belgesiz" çıktı; tanı "Programdaki
// Vega görüntüsünde yok" dedi. Bekleme depolarının hedefi yalnız sayım işaretlenirse 106 belgesi hedefe taşınıp orada süzülüyordu.
test('bekleme hedefi (Merkez) yalnız sayım işaretli olsa da bekleme deposunun alışı Merkez\'de rafa bekler', async () => {
  config.update({ vega: { depo: null, sayimDepolar: [1, 110] }, bekleme: { aktif: true, hedef: 1, depolar: [106] } });
  const g = {
    surum: 2,
    at: Date.now(),
    depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 106, ad: 'TRANSFER SPCT 106' }, { ind: 108, ad: 'TOYBELEN SANAYİ' }, { ind: 110, ad: 'ZİNCİRDEPO' }],
    products: [{ id: '101', code: 'KALE-1', name: 'Fren balata', unit: 'Adet' }],
    stock: { 106: { 101: 5 } },
    moved: [],
    barcodes: {},
    receipts: [belge('FAT-106', 106, [['101', 5]]), belge('FAT-Z', 110, [['101', 2]])],
  };
  const eski = vega.stokTani;
  try {
    depo._goruntuKur(g, true);
    assert.deepStrictEqual(depo.sayimDepolari(), new Set([110]));
    assert.strictEqual(depo.bekleyenKabul(1).get('101'), 5);
    assert.ok(depo.belgeler().some((r) => r.id === 'FAT-106'));
    assert.ok(!depo.belgeler().some((r) => r.id === 'FAT-Z'));

    // Tanı: yalnız sayım deposunun girişi nedeniyle gösterilir, görüntüde olmayan giriş son okuma saatiyle.
    const giris = (x) => ({ tur: 'Alış faturası', tarih: '', gun: '2026-11-23', iade: false, iptal: false, tip: 20, ...x });
    config.update({ kabul: { izahat: ['20'], baslangic: '2026-10-31' } });
    vega.stokTani = async () => ({
      depolar: g.depolar,
      kartlar: [{
        id: '101', kod: 'KALE-1', ad: 'Fren balata', suzgec: [], pasifAd: false, stok: { 106: 5, 110: 2 },
        girisler: [giris({ depo: 110, belgeInd: 7, belgeNo: 'Z7', miktar: 2 }), giris({ depo: 106, belgeInd: 8, belgeNo: 'Y8', miktar: 5 })],
        cikislar: [],
      }],
    });
    const k = (await depo.stokTani('KALE-1')).kartlar[0];
    assert.match(k.girisler[0].neden, /ZİNCİRDEPO yalnız sayım deposu/);
    assert.match(k.girisler[1].neden, /görüntüsünde yok \(son Vega okuması/);
    assert.strictEqual(k.depolar.find((d) => d.depo === 1).bekleyen, 5);
  } finally {
    vega.stokTani = eski;
    config.update({ vega: { depo: 1, sayimDepolar: [110] }, bekleme: { aktif: false } });
    kur();
  }
});
