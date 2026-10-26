// Terminal işlemlerinin sunucudaki etkisi (Vega'sız; Vega görüntüsü elle verilir). İki depo: 1 MERKEZ, 2 ŞUBE.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortas-test-'));
const config = require('../server/config');
const db = require('../server/db');
const depo = require('../server/depo');
const iceaktar = require('../server/iceaktar');
config.init(path.join(dir, 'config.json'));
config.update({ vega: { depo: 1 } });
db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });

depo._goruntuKur({
  surum: 2,
  at: Date.now(),
  depolar: [{ ind: 1, ad: 'MERKEZ' }, { ind: 2, ad: 'ŞUBE' }],
  products: [
    { id: '101', code: 'YF-1042', name: 'Yağ filtresi', unit: 'Adet' },
    { id: '102', code: 'HF-0310', name: 'Hava filtresi', unit: 'Adet' },
    { id: '103', code: 'AN-0040', name: 'Antifriz 4 L', unit: 'Adet' },
  ],
  stock: { 1: { 101: 24, 102: 10, 103: 5 }, 2: { 101: 6 } },
  moved: [],
  barcodes: { 101: ['8691234500412'] },
  receipts: [
    { id: '26-9-1', izahat: '26', tur: 'Alış irsaliyesi', docNo: 'IRS-9', supplier: 'Tedarikçi', date: '21.10.2026', ts: 1, depo: 1, depoAd: 'MERKEZ', lines: [
      { id: '26-9-1-101', productId: '101', accepted: 24 },
      { id: '26-9-1-102', productId: '102', accepted: 10 },
    ] },
    { id: '20-5-2', izahat: '20', tur: 'Alış faturası', docNo: 'FAT-5', supplier: 'Tedarikçi', date: '21.10.2026', ts: 2, depo: 2, depoAd: 'ŞUBE', lines: [
      { id: '20-5-2-101', productId: '101', accepted: 6 },
    ] },
  ],
});
for (const r of ['A-01-01', 'A-01-02', 'B-01-01']) depo.rafEkle(1, r);
depo.rafEkle(2, 'A-01-01');

let n = 0;
const op = (type, payload, createdAt = Date.now()) => ({ id: `op-${++n}`, type, createdAt, payload: { user: 'ali', device: 'TRM-01', ...payload } });

test('rafa kaldırma raf stokunu ve belge ilerlemesini artırır', () => {
  const r = depo.islemler('TRM-01', 'ali', [
    op('PUTAWAY', { receiptId: '26-9-1', lineId: '26-9-1-101', productId: '101', shelf: 'A-01-01', qty: 20 }),
    op('PUTAWAY', { receiptId: '26-9-1', lineId: '26-9-1-101', productId: '101', shelf: 'a-01-02', qty: 4 }),
  ]);
  assert.ok(r.every((x) => x.ok));
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 20);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-02'), 4);
  const m = JSON.parse(depo.master().json);
  const belge = m.receipts.find((x) => x.id === '26-9-1');
  assert.strictEqual(belge.lines.find((l) => l.id === '26-9-1-101').shelved, 24);
  assert.strictEqual(depo.bekleyenKabul(1).get('101'), undefined);
  assert.strictEqual(depo.bekleyenKabul(1).get('102'), 10);
});

test('belge kendi deposunda rafa kalkar (terminalin seçili deposu farklı olsa da)', () => {
  const r = depo.islemler('TRM-01', 'ali', [op('PUTAWAY', { receiptId: '20-5-2', lineId: '20-5-2-101', productId: '101', shelf: 'A-01-01', qty: 6, depot: 1 })]);
  assert.ok(r[0].ok);
  assert.strictEqual(depo.miktar(2, '101', 'A-01-01'), 6);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 20);
});

test('aynı işlem ikinci kez gelirse yeniden işlenmez', () => {
  const o = op('PUTAWAY', { receiptId: '26-9-1', lineId: '26-9-1-102', productId: '102', shelf: 'B-01-01', qty: 3 });
  depo.islemler('TRM-01', 'ali', [o]);
  const r = depo.islemler('TRM-01', 'ali', [o]);
  assert.deepStrictEqual(r, [{ id: o.id, ok: true }]);
  assert.strictEqual(depo.miktar(1, '102', 'B-01-01'), 3);
});

test('tanımsız rafa gelen mal kaybolmaz, raf seçili depoda açılır', () => {
  depo.islemler('TRM-01', 'ali', [op('PUTAWAY', { productId: '103', shelf: 'Z-09', qty: 2, depot: 2 })]);
  assert.ok(depo.rafVarMi(2, 'Z-09'));
  assert.ok(!depo.rafVarMi(1, 'Z-09'));
  assert.strictEqual(depo.miktar(2, '103', 'Z-09'), 2);
});

test('transfer seçili depoda; kaynağı eksiye düşürmez', () => {
  depo.islemler('TRM-01', 'ali', [op('TRANSFER', { productId: '101', from: 'A-01-02', to: 'B-01-01', qty: 10, depot: 1 })]);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-02'), 0);
  assert.strictEqual(depo.miktar(1, '101', 'B-01-01'), 10);
});

test('hatalı işlem kalıcı ret alır', () => {
  const r = depo.islemler('TRM-01', 'ali', [op('TRANSFER', { productId: '101', from: 'A', to: 'A', qty: 1 }), op('XYZ', {}), op('PUTAWAY', { productId: 'P1', shelf: 'A-01-01', qty: 1 })]);
  assert.deepStrictEqual(r.map((x) => x.ok), [false, false, false]);
});

test('sayım sayımın deposunda; rafı sayılan değere çeker, sayılmayan ürün sıfırlanır', () => {
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, created_at, depo) VALUES('C1','SAY-0001','Deneme',1,'GENEL','OPEN','ADMIN',?,1)", Date.now());
  const r = depo.islemler('TRM-01', 'ali', [
    op('COUNT_SUBMIT', { sessionId: 'C1', no: 'SAY-0001', shelves: ['B-01-01'], lines: [{ shelf: 'B-01-01', productId: '102', system: 3, counted: 5 }] }, Date.now() + 1000),
  ]);
  assert.ok(r[0].ok);
  assert.strictEqual(depo.miktar(1, '102', 'B-01-01'), 5);
  assert.strictEqual(depo.miktar(1, '101', 'B-01-01'), 0);
  const o = depo.sayimOzet('C1');
  const u102 = o.urunler.find((u) => u.productId === '102');
  // MERKEZ: raflar 5 + bekleyen (10 − 3) = 12; Vega 10 → +2
  assert.strictEqual(u102.hedef, 12);
  assert.strictEqual(u102.fark, 2);
  const u101 = o.urunler.find((u) => u.productId === '101');
  // 101 MERKEZ: A-01-01'de 20 kaldı (ŞUBE'deki 6 sayılmaz); Vega MERKEZ 24 → −4
  assert.strictEqual(u101.hedef, 20);
  assert.strictEqual(u101.fark, -4);
});

test('terminalde başlatılan serbest sayım terminalin deposunda, onay bekleyen olarak açılır', () => {
  depo.islemler('TRM-01', 'ali', [op('COUNT_SUBMIT', { sessionId: 'LOCAL-abc', no: 'SAY-T1', title: 'Serbest', depot: 2, shelves: ['A-01-01'], lines: [{ shelf: 'A-01-01', productId: '101', system: 6, counted: 6 }] })]);
  const s = db.get("SELECT * FROM count_session WHERE id='LOCAL-abc'");
  assert.strictEqual(s.status, 'CLOSED');
  assert.strictEqual(s.depo, 2);
});

test('ana veri: depolar, depo bazlı raf/konum/belge/stok; ETag değişiklikle değişir', () => {
  const e1 = depo.master().etag;
  db.run("INSERT INTO app_user(username, name, salt, pin_hash, active, created_at) VALUES('ali','Ali','s','h',1,0)");
  depo.degisti();
  const m = depo.master();
  assert.notStrictEqual(m.etag, e1);
  const j = JSON.parse(m.json);
  assert.deepStrictEqual(j.depots, [{ id: 1, name: 'MERKEZ' }, { id: 2, name: 'ŞUBE' }]);
  assert.strictEqual(j.defaultDepot, 1);
  assert.deepStrictEqual(j.users.map((u) => u.username), ['ali']);
  assert.deepStrictEqual(j.counts.map((c) => [c.id, c.depot]), [['C1', 1]]);
  const p = j.products.find((x) => x.id === '101');
  assert.deepStrictEqual(p.stocks, { 1: 24, 2: 6 });
  assert.strictEqual(p.vegaStock, 30);
  assert.ok(j.shelves.some((s) => s.depot === 2 && s.code === 'A-01-01'));
  assert.ok(j.locations.some((l) => l.depot === 2 && l.productId === '101' && l.qty === 6));
  assert.ok(!j.receipts.some((r) => r.id === '20-5-2'), 'tamamlanan belge gitmez');
});

test('ürün listesi isimle yakın eşleşmeyi bulur; depo süzgeci', () => {
  const r = depo.urunListesi({ q: 'antfiriz' });
  assert.deepStrictEqual(r.liste.map((u) => u.id), ['103']);
  assert.strictEqual(depo.urunListesi({ q: '8691234500412' }).liste[0].id, '101');
  const sube = depo.urunListesi({ depo: 2 }).liste.find((u) => u.id === '101');
  assert.strictEqual(sube.vegaStock, 6);
  assert.strictEqual(sube.raf, 6);
});

test('Excel içe aktarma: depo adı eşleşir, raf açılır, miktar ve asıl raf yazılır, hatalı satır atlanır', async () => {
  const csv = 'Depo;Raf;Bölge;Ürün kodu;Miktar\nmerkez;C-01-01;C;YF-1042;7\nŞube;C-02-01;C;8691234500412;\nOLMAYAN;C-03-01;;;\n1;C-04-01;;XX-YOK;\n';
  const t = await iceaktar.oku('raflar.csv', Buffer.from(csv));
  const es = iceaktar.tahminEt(t.basliklar);
  assert.deepStrictEqual(es, { depo: 0, raf: 1, bolge: 2, urun: 3, miktar: 4 });
  const c = iceaktar.coz({ ...t, eslesme: es });
  assert.strictEqual(c.satirlar.length, 2);
  assert.deepStrictEqual(c.hatalar.map((h) => h.satir), [4, 5]);
  const s = iceaktar.uygula(c);
  assert.deepStrictEqual(s, { yeniRaf: 2, miktar: 1, asilRaf: 1 });
  assert.strictEqual(depo.miktar(1, '101', 'C-01-01'), 7);
  assert.strictEqual(db.get("SELECT shelf FROM product_home WHERE depo=2 AND product_id='101'").shelf, 'C-02-01');
  // Elle eşleme: OLMAYAN → 2
  const c2 = iceaktar.coz({ ...t, eslesme: es, depoEslesme: { OLMAYAN: 2 } });
  assert.strictEqual(c2.hatalar.length, 1);
});

test('Excel içe aktarma: B2B raf adresi ; ile çoklu, uygun olmayan parça atlanır; bütün depolara yazılabilir', async () => {
  const csv = 'Stok Kodu;Stok Adı;Minimum Adet;Durum;Raf Adresi\nHF-0310;Hava filtresi;1;Aktif;.;TK2-H1\nAN-0040;Antifriz;1;Aktif;TK2-H2, TK3-A1\nYF-1042;Yağ filtresi;1;Aktif;.\n';
  // Raf Adresi hücresindeki ; ayraçla karışmasın diye tırnaklı
  const t = await iceaktar.oku('b2b.csv', Buffer.from(csv.replace(/;(\.;TK2-H1|TK2-H2, TK3-A1|\.)\n/g, ';"$1"\n')));
  const es = iceaktar.tahminEt(t.basliklar);
  assert.deepStrictEqual(es, { raf: 4, urun: 0 });
  const c = iceaktar.coz({ ...t, eslesme: es, sabitDepo: iceaktar.HEPSI });
  assert.deepStrictEqual(c.hatalar.map((h) => h.satir), [4]);
  assert.deepStrictEqual(c.satirlar.map((s) => `${s.depo}|${s.raf}|${s.productId}`), [
    '1|TK2-H1|102', '2|TK2-H1|102', '1|TK2-H2|103', '1|TK3-A1|103', '2|TK2-H2|103', '2|TK3-A1|103',
  ]);
  assert.strictEqual(iceaktar.ozet(c).satir, 2);
  const s = iceaktar.uygula(c);
  assert.deepStrictEqual(s, { yeniRaf: 6, miktar: 0, asilRaf: 6 });
  assert.ok(depo.rafVarMi(2, 'TK2-H1'));
  assert.deepStrictEqual(depo.zimmetler(2, '103').map((z) => z.shelf), ['TK2-H2', 'TK3-A1']);
  // Çok raflı satıra miktar yazılmaz: hangi rafa olduğu belirsiz.
  const c2 = iceaktar.coz({ satirlar: [['HF-0310', 'TK2-H1;TK2-H2', '5']], eslesme: { urun: 0, raf: 1, miktar: 2 }, sabitDepo: 1 });
  assert.strictEqual(c2.satirlar.length, 0);
  assert.strictEqual(c2.hatalar.length, 1);
  for (const d of [1, 2]) for (const r of ['TK2-H1', 'TK2-H2', 'TK3-A1']) {
    db.run('DELETE FROM product_home WHERE depo=? AND shelf=?', d, r);
    db.run('DELETE FROM shelf WHERE depo=? AND code=?', d, r);
  }
});

test('ürün birden çok rafa zimmetlenir; boş zimmetli raf detayda beklenen olarak görünür', () => {
  depo.zimmetEkle(1, '103', 'A-01-01');
  depo.zimmetEkle(1, '103', 'A-01-02');
  assert.deepStrictEqual(depo.zimmetler(1, '103').map((z) => z.shelf), ['A-01-01', 'A-01-02']);
  const d = depo.rafDetay(1, 'A-01-02');
  const z = d.icerik.find((x) => x.productId === '103');
  assert.strictEqual(z.qty, 0);
  assert.strictEqual(z.zimmet, 'ADMIN');
  const r = depo.raflar(1).find((x) => x.code === 'A-01-02');
  assert.strictEqual(r.zimmet, 1);
  assert.strictEqual(r.bekleyen, 1);
  const homes = JSON.parse(depo.master().json).homes.filter((h) => h.productId === '103');
  assert.deepStrictEqual(homes.map((h) => h.shelf), ['A-01-01', 'A-01-02']);
});

test('Vega kartındaki raf adresleri zimmet olur; karttan silinen adres zimmetten de kalkar', () => {
  config.update({ rafAdresi: { alan: 'KOD14', depo: 1, yeniRafAc: true } });
  const g = depo.goruntu();
  g.rafAlan = 'KOD14';
  g.products.find((p) => p.id === '102').raf = 'r-01, R-02;bad*kod';
  let s = depo.vegaZimmetEsitle();
  assert.deepStrictEqual(depo.zimmetler(1, '102').map((z) => [z.shelf, z.source]), [['R-01', 'VEGA'], ['R-02', 'VEGA']]);
  assert.ok(depo.rafVarMi(1, 'R-01'));
  assert.strictEqual(s.gecersiz.length, 1);
  assert.throws(() => depo.zimmetSil(1, '102', 'R-01'), /Vega/);
  g.products.find((p) => p.id === '102').raf = 'R-02';
  s = depo.vegaZimmetEsitle();
  assert.deepStrictEqual(depo.zimmetler(1, '102').map((z) => z.shelf), ['R-02']);
  delete g.products.find((p) => p.id === '102').raf;
  depo.vegaZimmetEsitle();
  assert.strictEqual(depo.zimmetler(1, '102').length, 0);
  // Varsayılan: yalnız tanımlı raflar; alandaki raf olmayan bilgi (araç modeli) zimmet olmaz.
  config.update({ rafAdresi: { yeniRafAc: false } });
  g.products.find((p) => p.id === '102').raf = 'PASSAT, B-01-01';
  s = depo.vegaZimmetEsitle();
  assert.deepStrictEqual(depo.zimmetler(1, '102').map((z) => z.shelf), ['B-01-01']);
  assert.ok(!depo.rafVarMi(1, 'PASSAT'));
  assert.deepStrictEqual(s.tanimsizListe, [{ adres: 'PASSAT', kart: 1 }]);
  delete g.products.find((p) => p.id === '102').raf;
  depo.vegaZimmetEsitle();
});

test('raf adresi yazma: alandaki eski bilgi silinir, zimmetler yazılır, ilk değer saklanır', async () => {
  const vega = require('../server/vega');
  const yazilan = [];
  const eskiYaz = vega.kartAlanYaz;
  const eskiUz = vega.kartAlanUzunluk;
  vega.kartAlanUzunluk = async () => 20;
  vega.kartAlanYaz = async (cfg, alan, satirlar, bitti) => {
    yazilan.push(...satirlar.map((s) => [alan, s.id, s.deger]));
    bitti(satirlar);
    return satirlar.length;
  };
  try {
    config.update({ rafAdresi: { alan: 'KOD10', depo: 1, yaz: true } });
    const g = depo.goruntu();
    g.rafAlan = 'KOD10';
    const p101 = g.products.find((p) => p.id === '101');
    const p102 = g.products.find((p) => p.id === '102');
    p101.raf = 'ASYA';
    p102.raf = 'AVRUPA';
    depo.zimmetEkle(1, '102', 'B-01-01');
    depo.zimmetEkle(1, '102', 'R-LONG-0001');
    depo.zimmetEkle(1, '102', 'R-LONG-0002');
    const s = await depo.vegaRafYaz();
    // 101 zimmetsiz: ASYA silinir. 102: 20 karaktere iki raf sığar.
    assert.deepStrictEqual(yazilan.find((y) => y[1] === '101'), ['KOD10', '101', '']);
    assert.deepStrictEqual(yazilan.find((y) => y[1] === '102'), ['KOD10', '102', 'B-01-01, R-LONG-0001']);
    assert.strictEqual(s.sigmayan, 1);
    assert.strictEqual(p101.raf, undefined);
    assert.strictEqual(db.get("SELECT eski FROM vega_alan WHERE alan='KOD10' AND product_id='101'").eski, 'ASYA');
    // Değişmeyen kart yeniden yazılmaz; eski değer ikinci yazmada ezilmez.
    yazilan.length = 0;
    depo.zimmetSil(1, '102', 'R-LONG-0002');
    depo.zimmetSil(1, '102', 'R-LONG-0001');
    await depo.vegaRafYaz();
    assert.deepStrictEqual(yazilan, [['KOD10', '102', 'B-01-01']]);
    assert.strictEqual(db.get("SELECT eski FROM vega_alan WHERE alan='KOD10' AND product_id='102'").eski, 'AVRUPA');
    // Vega'da elle değiştirilen kart: program zimmeti geçerli, sayısı bildirilir.
    yazilan.length = 0;
    p102.raf = 'ELLE';
    const s2 = await depo.vegaRafYaz();
    assert.deepStrictEqual(yazilan, [['KOD10', '102', 'B-01-01']]);
    assert.strictEqual(s2.elle, 1);
  } finally {
    vega.kartAlanYaz = eskiYaz;
    vega.kartAlanUzunluk = eskiUz;
    config.update({ rafAdresi: { alan: '', yaz: false } });
    depo.goruntu().rafAlan = null;
    depo.zimmetSil(1, '102', 'B-01-01');
  }
});

test('taşı: miktar ve zimmet hedef rafa geçer; raf boşaltma her şeyi aktarır', () => {
  // 101 MERKEZ: A-01-01'de 20, B-01-01'de 10
  depo.zimmetEkle(1, '101', 'A-01-01');
  depo.tasi(1, '101', 'A-01-01', 'A-01-02', 5);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 15);
  assert.strictEqual(depo.miktar(1, '101', 'A-01-02'), 5);
  assert.throws(() => depo.tasi(1, '101', 'A-01-01', 'A-01-02', 99), /taşınamaz/);
  depo.tasi(1, '101', 'A-01-01', 'C-09', null, { zimmetTasi: true });
  assert.strictEqual(depo.miktar(1, '101', 'A-01-01'), 0);
  assert.strictEqual(depo.miktar(1, '101', 'C-09'), 15);
  assert.ok(depo.zimmetler(1, '101').some((z) => z.shelf === 'C-09'));
  assert.ok(!depo.zimmetler(1, '101').some((z) => z.shelf === 'A-01-01'));
  // A-01-02: 101 × 5 ve 103 zimmeti
  const b = depo.rafBosalt(1, 'A-01-02', 'D-01');
  assert.deepStrictEqual(b, { urun: 1, zimmet: 1 });
  assert.strictEqual(depo.miktar(1, '101', 'D-01'), 5);
  assert.ok(depo.zimmetler(1, '103').some((z) => z.shelf === 'D-01'));
  assert.strictEqual(depo.rafDetay(1, 'A-01-02').icerik.length, 0);
});

test('adresi olmayan ürünler: Vega stoku var, rafta yok, zimmeti yok', () => {
  const ids = depo.urunListesi({ filtre: 'adressiz', depo: 1 }).liste.map((u) => u.id);
  // 102 B-01-01'de; 101 rafta; 103 zimmetli
  assert.deepStrictEqual(ids, []);
  depo.zimmetSil(1, '103', 'A-01-01');
  depo.zimmetSil(1, '103', 'D-01');
  assert.deepStrictEqual(depo.urunListesi({ filtre: 'adressiz', depo: 1 }).liste.map((u) => u.id), ['103']);
});

test('pasif kart terminale gitmez; belgedeki satırı da gitmez, rafta duruyorsa gider', () => {
  const { PASIF_AD } = require('../server/vega');
  assert.ok(PASIF_AD.test('(PASİF OLMUŞTUR)MUSLUK KALORİFER'));
  assert.ok(PASIF_AD.test('( PASİF OLMUŞTUR ) SALINCAK ALT SAĞ'));
  assert.ok(PASIF_AD.test('KEÇE KRANK ARKA 90X110X9 PASİF'));
  assert.ok(PASIF_AD.test('TAKOZ MOTOR ARKA ASTRA HPASİF'));
  assert.ok(!PASIF_AD.test('SALINCAK ALT SAĞ'));
  const g = depo.goruntu();
  g.products.push({ id: '109', code: 'PS-1', name: '(PASİF OLMUŞTUR) Eski filtre', unit: 'Adet', pasif: true });
  g.stock[1]['109'] = 3;
  g.receipts.push({ id: '26-7-1', izahat: '26', tur: 'Alış irsaliyesi', docNo: 'IRS-7', supplier: 'T', date: '22.10.2026', ts: 3, depo: 1, depoAd: 'MERKEZ', lines: [
    { id: '26-7-1-109', productId: '109', accepted: 3 },
  ] });
  try {
    depo._goruntuKur(g);
    depo.degisti();
    let m = JSON.parse(depo.master().json);
    assert.ok(!m.products.some((p) => p.id === '109'));
    assert.ok(!m.receipts.some((r) => r.id === '26-7-1'));
    // Programda rafta duran pasif kart raf stoku görünsün diye gider.
    depo.islemler('TRM-01', 'ali', [op('PUTAWAY', { receiptId: '26-7-1', lineId: '26-7-1-109', productId: '109', shelf: 'B-01-01', qty: 3 })]);
    m = JSON.parse(depo.master().json);
    assert.ok(m.products.some((p) => p.id === '109'));
  } finally {
    g.products.pop();
    delete g.stock[1]['109'];
    g.receipts.pop();
    db.run("DELETE FROM location WHERE product_id='109'");
    depo._goruntuKur(g);
    depo.degisti();
  }
});

test('toplu raf: bütün depolarda açılır; uygun olmayan kod varsa hiçbiri açılmaz', () => {
  assert.deepStrictEqual(depo.raflarAc('hepsi', ['tk9-h1', 'TK9-H2', 'A-01-01']), { eklenen: 4, toplam: 6 });
  for (const d of [1, 2]) assert.ok(depo.rafVarMi(d, 'TK9-H1') && depo.rafVarMi(d, 'TK9-H2'));
  assert.deepStrictEqual(depo.raflarAc(2, ['TK9-H3']), { eklenen: 1, toplam: 1 });
  assert.ok(!depo.rafVarMi(1, 'TK9-H3'));
  assert.throws(() => depo.raflarAc('hepsi', ['TK9-H4', '.;X']), /Geçersiz raf kodu/);
  assert.ok(!depo.rafVarMi(1, 'TK9-H4'));
  for (const d of [1, 2]) db.run("DELETE FROM shelf WHERE depo=? AND code LIKE 'TK9-%'", d);
});

test('eski tek depolu veritabanı göçü: raflar ve stok varsayılan depoya bağlanır', () => {
  const { DatabaseSync } = require('node:sqlite');
  const f = path.join(dir, 'eski.db');
  const e = new DatabaseSync(f);
  e.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('surum','1');
    CREATE TABLE shelf(code TEXT PRIMARY KEY, zone TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'ADMIN', created_at INTEGER NOT NULL);
    CREATE TABLE location(product_id TEXT NOT NULL, shelf TEXT NOT NULL, qty REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(product_id, shelf));
    CREATE TABLE movement(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, product_id TEXT NOT NULL, shelf TEXT NOT NULL, delta REAL NOT NULL, after REAL NOT NULL, kind TEXT NOT NULL, ref TEXT, user TEXT, device TEXT, op_id TEXT);
    CREATE TABLE count_session(id TEXT PRIMARY KEY, no TEXT NOT NULL, title TEXT NOT NULL, blind INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'RAF', status TEXT NOT NULL DEFAULT 'OPEN', source TEXT NOT NULL DEFAULT 'ADMIN', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, closed_at INTEGER, vega_docs TEXT, vega_written_at INTEGER);
    INSERT INTO shelf(code, created_at) VALUES('X-1', 0); INSERT INTO location VALUES('9', 'X-1', 3, 0);`);
  e.close();
  db.close();
  db.open(f, { varsayilanDepo: 7 });
  assert.strictEqual(db.get("SELECT depo FROM shelf WHERE code='X-1'").depo, 7);
  assert.strictEqual(db.get("SELECT depo, qty FROM location WHERE product_id='9'").depo, 7);
  assert.strictEqual(db.meta('surum'), '5');
  db.close();
  db.open(path.join(dir, 'depo.db'), { varsayilanDepo: 1 });
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ana veri parça parça: ilk istekte hepsi, sonra yalnız değişen kova gelir; içerik tam listeyle aynı', () => {
  // Terminaldeki Buckets.of ile aynı değerler (BucketsTest.kt).
  assert.deepStrictEqual(['101', '102', 'YF-1042', ''].map(depo.kova), [47, 2, 42, 5]);
  const tam = JSON.parse(depo.master().json);
  const bilinen = {};
  const urunler = [];
  const konumlar = [];
  let istek = 0;
  for (;;) {
    const c = JSON.parse(depo.masterParcaCevabi(bilinen, 8));
    istek++;
    for (const p of c.parts) {
      bilinen[p.key] = p.hash;
      if (p.key.startsWith('b')) {
        urunler.push(...p.data.products);
        konumlar.push(...p.data.locations);
        for (const u of p.data.products) assert.strictEqual('b' + depo.kova(u.id), p.key);
      }
      if (p.key === 'head') assert.deepStrictEqual(p.data.depots, tam.depots);
    }
    if (c.remaining === 0) break;
  }
  assert.strictEqual(istek, 64 / 8);
  assert.strictEqual(urunler.length, tam.products.length);
  assert.strictEqual(konumlar.length, tam.locations.length);
  // Değişiklik yokken boş cevap.
  assert.deepStrictEqual(JSON.parse(depo.masterParcaCevabi(bilinen, 8)).parts, []);
  // Bir raf transferi yalnız o ürünün kovasını değiştirir.
  assert.ok(depo.islemler('TRM-01', 'ali', [op('TRANSFER', { productId: '101', from: 'A-01-01', to: 'A-01-02', qty: 1 })])[0].ok);
  const d = JSON.parse(depo.masterParcaCevabi(bilinen, 8)).parts.map((p) => p.key);
  assert.deepStrictEqual(d, ['b' + depo.kova('101')]);
});

test('raf sayımı kapsamı: önek sayı/harf dizisini bölmez; özet kalan ve kapsam dışı rafları verir', () => {
  const kapsam = require('../server/kapsam');
  const uy = (kod, k) => kapsam.kapsamda(kod, kapsam.coz(k));
  assert.ok(uy('K1', 'K1') && uy('K1-A3', 'K1') && uy('K1A-2', 'k1'));
  assert.ok(!uy('K10-A3', 'K1') && !uy('KAT-10', 'KAT-1') && !uy('TK1', 'K1'));
  assert.ok(uy('TK2-H1', 'TK2-H') && uy('K10', 'K1*') && uy('KAT-1-A1-20', 'KAT-1'));
  assert.ok(uy('B-02-01', 'A, B-02'));
  assert.ok(uy('HERHANGİ', ''));
  assert.throws(() => kapsam.coz('K1;K2'), /uygun değil/);

  for (const c of ['K1-01', 'K1-02', 'K1-03', 'K10-01']) depo.rafEkle(1, c);
  assert.deepStrictEqual(depo.kapsamRaflari(1, ['K1']), ['K1-01', 'K1-02', 'K1-03']);
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, created_at, depo, scope) VALUES('CK','SAY-0090','Kat 1',1,'RAF','OPEN','ADMIN',?,1,'K1')", Date.now());
  depo.degisti();
  assert.deepStrictEqual(JSON.parse(depo.master().json).counts.find((c) => c.id === 'CK').scope, ['K1']);
  depo.islemler('TRM-01', 'ali', [
    op('COUNT_SUBMIT', { sessionId: 'CK', no: 'SAY-0090', shelves: ['K1-01', 'K10-01'], lines: [{ shelf: 'K1-01', productId: '101', system: 0, counted: 2 }] }, Date.now() + 1000),
  ]);
  const k = depo.sayimOzet('CK').kapsam;
  assert.strictEqual(k.raf, 3);
  assert.strictEqual(k.sayilan, 1);
  assert.deepStrictEqual(k.kalan, ['K1-02', 'K1-03']);
  // Raf listesinde gönderilen ama satırı olmayan K10-01 de sayılmıştır; kapsam dışıdır.
  assert.deepStrictEqual(k.disinda, ['K10-01']);
  // Boş gönderilen raf da sayılmış olur.
  depo.islemler('TRM-02', 'veli', [op('COUNT_SUBMIT', { sessionId: 'CK', no: 'SAY-0090', shelves: ['K1-02'], lines: [] }, Date.now() + 2000)]);
  assert.deepStrictEqual(depo.sayimOzet('CK').kapsam.kalan, ['K1-03']);
});

test('iptal edilen sayıma gönderim reddedilir; terminalden raf eklenir', () => {
  db.run("INSERT INTO count_session(id, no, title, blind, kind, status, source, created_at, depo) VALUES('CX','SAY-0091','İptal',1,'RAF','CANCELLED','ADMIN',?,1)", Date.now());
  const r = depo.islemler('TRM-01', 'ali', [op('COUNT_SUBMIT', { sessionId: 'CX', no: 'SAY-0091', shelves: ['A-01-01'], lines: [{ shelf: 'A-01-01', productId: '101', system: 0, counted: 99 }] })]);
  assert.ok(!r[0].ok && /iptal/.test(r[0].error));
  assert.notStrictEqual(depo.miktar(1, '101', 'A-01-01'), 99);

  const e = depo.islemler('TRM-01', 'ali', [op('SHELF_ADD', { depot: 2, code: 'yeni-01' }), op('SHELF_ADD', { depot: 2, code: '.;X' })]);
  assert.deepStrictEqual(e.map((x) => x.ok), [true, false]);
  assert.ok(depo.rafVarMi(2, 'YENI-01') || depo.rafVarMi(2, 'YENİ-01'));
  assert.strictEqual(db.get("SELECT source FROM shelf WHERE depo=2 AND code LIKE 'YEN%-01'").source, 'TERMINAL');
});

test('raf grupları: bölge ilk parça, grup ilk iki parça; tek tük grup listelenmez', () => {
  for (const c of ['KAT-1-A1-1', 'KAT-1-A1-2', 'KAT-1-B2-1', 'KAT-10-A1-1', 'KAT-10-A1-2', 'KAT-10-A1-3', 'KAT-B-A1-1', 'KO-4-F7-11']) depo.rafEkle(3, c);
  const g = depo.rafGruplari(3);
  assert.deepStrictEqual(g.map((x) => [x.onek, x.adet]), [['KAT', 7], ['KO', 1]]);
  assert.deepStrictEqual(g[0].gruplar, [{ onek: 'KAT-1', adet: 3 }, { onek: 'KAT-10', adet: 3 }]);
  assert.strictEqual(depo.kapsamRaflari(3, ['KAT-1']).length, 3);
});
