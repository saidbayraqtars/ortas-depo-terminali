// Vega (VEGADB, SQL Server) bağlantısı.
// Okunan: stok kartları, barkodlar, depo stoku, mal kabul belgeleri (stok hareketinden).
// Yazılan: yalnız yönetici onayladığında sayım fişi (tip 93 giriş / 94 çıkış). Desen gerçek Vega
// kaydından alındı (Galya F0102D0002 Z0000048/Z0000022, Vega Kılavuzu §23.7).
const sql = require('mssql');
const crypto = require('crypto');

let pool = null;
let poolKey = '';
const kolonCache = new Map();

// tedious "(local)", "." gibi takma adları tanımaz (Kılavuz §4.2).
function sunucuCoz(ham) {
  const parcalar = String(ham || '').trim().split('\\');
  let makine = (parcalar[0] || '').trim();
  const ornek = parcalar.length > 1 ? parcalar.slice(1).join('\\').trim() : '';
  if (['', '.', '(local)', 'local', '(localhost)'].includes(makine.toLowerCase())) makine = 'localhost';
  return { server: makine, instanceName: ornek || undefined };
}

function baglantiAyari(v) {
  const { server, instanceName } = sunucuCoz(v.server);
  const out = {
    server,
    database: v.database || 'VEGADB',
    user: v.user,
    password: v.password || '',
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true, instanceName, useUTC: false },
    connectionTimeout: 15000,
    requestTimeout: 120000,
    pool: { max: 6, min: 0, idleTimeoutMillis: 60000 },
  };
  if (v.port && !instanceName) out.port = Number(v.port);
  return out;
}

async function baglan(v) {
  const key = JSON.stringify([v.server, v.port, v.database, v.user, v.password]);
  if (pool && poolKey === key && pool.connected) return pool;
  if (pool) await pool.close().catch(() => {});
  pool = null;
  kolonCache.clear();
  const p = new sql.ConnectionPool(baglantiAyari(v));
  await p.connect();
  pool = p;
  poolKey = key;
  return pool;
}

async function kapat() {
  if (pool) await pool.close().catch(() => {});
  pool = null;
}

/** Ayar ekranındaki "Bağlantıyı dene": firma listesini döndürür. */
async function dene(v) {
  const p = new sql.ConnectionPool(baglantiAyari(v));
  try {
    await p.connect();
    const r = await p.request().query("SELECT OBJECT_ID('TBLFIRMA') AS firma, OBJECT_ID('TBLDONEM') AS donem");
    if (!r.recordset[0].firma || !r.recordset[0].donem) throw new Error('Bu veritabanında TBLFIRMA / TBLDONEM yok. Vega veritabanını seçin.');
    return true;
  } finally {
    await p.close().catch(() => {});
  }
}

const fk = (firma) => 'F' + String(firma).padStart(4, '0');
const dk = (donem) => 'D' + String(donem).padStart(4, '0');

async function tabloVar(p, ad) {
  const r = await p.request().input('ad', sql.NVarChar, ad).query('SELECT OBJECT_ID(@ad) AS id');
  return Boolean(r.recordset[0].id);
}

async function kolonlar(p, tablo) {
  if (kolonCache.has(tablo)) return kolonCache.get(tablo);
  const r = await p.request().input('t', sql.NVarChar, tablo).query('SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t)');
  const set = new Set(r.recordset.map((x) => x.name.toUpperCase()));
  kolonCache.set(tablo, set);
  return set;
}

async function firmalar(v) {
  const p = await baglan(v);
  const r = await p.request().query('SELECT * FROM TBLFIRMA ORDER BY IND');
  const out = [];
  for (const f of r.recordset) {
    if (!(await tabloVar(p, `${fk(f.IND)}TBLSTOKLAR`))) continue;
    out.push({ ind: f.IND, ad: [f.KISAAD, f.AD1].map((x) => String(x || '').trim()).find(Boolean) || fk(f.IND) });
  }
  return out;
}

async function donemler(v, firma) {
  const p = await baglan(v);
  const r = await p.request().input('f', sql.Int, firma).query('SELECT IND, DONEM FROM TBLDONEM WHERE FIND=@f ORDER BY DONEM DESC, IND DESC');
  const out = [];
  for (const d of r.recordset) {
    if (await tabloVar(p, `${fk(firma)}${dk(d.IND)}TBLSTOKHAREKETLERI`)) out.push({ ind: d.IND, yil: d.DONEM });
  }
  return out;
}

async function depolar(v, firma) {
  const p = await baglan(v);
  // Asıl liste firma tablosunda; global TBLDEPOLAR eksik olabilir (Kılavuz düzeltmesi #7).
  const tablo = (await tabloVar(p, `${fk(firma)}TBLDEPOLAR`)) ? `${fk(firma)}TBLDEPOLAR` : 'TBLDEPOLAR';
  const r = await p.request().query(`SELECT IND, DEPOADI, DEPOKODU FROM [${tablo}] ORDER BY IND`);
  return r.recordset.map((d) => ({ ind: d.IND, ad: String(d.DEPOADI || d.DEPOKODU || d.IND).trim() }));
}

/** Ayardaki dönem boşsa bu yılın dönemi, o da yoksa en son dönem. */
async function donemCoz(v) {
  if (v.donem) return v.donem;
  const liste = await donemler(v, v.firma);
  const yil = new Date().getFullYear();
  const d = liste.find((x) => x.yil === yil) || liste[0];
  if (!d) throw new Error(`${fk(v.firma)} firmasında dönem bulunamadı`);
  return d.ind;
}

function hazirMi(v) {
  return Boolean(v && v.server && v.user && v.firma && v.depo);
}

async function baglam(v) {
  if (!hazirMi(v)) throw new Error('Vega bağlantısı ayarlanmadı (Ayarlar › Vega)');
  const p = await baglan(v);
  const donem = await donemCoz(v);
  const F = fk(v.firma);
  const FD = F + dk(donem);
  return { p, donem, F, FD };
}

const IZAHAT_AD = { 20: 'Alış faturası', 26: 'Alış irsaliyesi', 32: 'Stok giriş fişi', 28: 'İade irsaliyesi' };

function tarihStr(d) {
  if (!(d instanceof Date)) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/**
 * Terminale gidecek Vega verisinin anlık görüntüsü. Ürünlerin hepsi gelir; terminale hangilerinin
 * gideceğine ana veri kurulurken karar verilir (stoklu / hareketli / rafta olan).
 */
async function goruntu(cfg) {
  const v = cfg.vega;
  const { p, donem, F, FD } = await baglam(v);
  const depo = Number(v.depo);
  const stokKol = await kolonlar(p, `${F}TBLSTOKLAR`);

  const sart = ['ISNULL(S.DELETED,0)=0', 'S.IND>=100'];
  if (stokKol.has('IPTAL')) sart.push('ISNULL(S.IPTAL,0)=0');
  if (stokKol.has('KOD8')) sart.push("LTRIM(RTRIM(ISNULL(S.KOD8,''))) <> N'PASİF'");
  if (stokKol.has('STOKTIPI')) sart.push('ISNULL(S.STOKTIPI,0) NOT IN (3,7,9)');

  const kartlar = await p.request().query(`
    SELECT S.IND, ISNULL(S.STOKKODU,'') AS KOD, ISNULL(S.MALINCINSI,'') AS AD, ISNULL(B.BIRIMADI,'') AS BIRIM
    FROM [${F}TBLSTOKLAR] S
    OUTER APPLY (SELECT TOP 1 BIRIMADI FROM [${F}TBLBIRIMLEREX] X WHERE X.STOKNO=S.IND ORDER BY X.VARSAYILAN DESC, X.ANABIRIM DESC, X.IND) B
    WHERE ${sart.join(' AND ')}`);

  const stok = await p.request().input('depo', sql.Int, depo).query(`
    SELECT STOKNO, SUM(ENVANTER) AS KALAN FROM [${FD}TBLDEPOENVANTER]
    WHERE DEPO=@depo AND ISNULL(BELGETIPI,0)<>67 GROUP BY STOKNO HAVING ABS(SUM(ENVANTER)) > 0.00001`);

  const gun = Math.max(1, Number(cfg.urun.gun) || 365);
  const hareket = await p.request().input('depo', sql.Int, depo).input('gun', sql.Int, gun).query(`
    SELECT DISTINCT STOKNO FROM [${FD}TBLSTOKHAREKETLERI]
    WHERE DEPO=@depo AND TARIH >= DATEADD(day, -@gun, CAST(GETDATE() AS date))`);

  // Barkod TBLBIRIMLEREX'te (Kılavuz §8). Çarpanlı birim (koli) barkodu terminalde 1 adet sayılırdı; alınmaz.
  const barkod = await p.request().query(`
    SELECT STOKNO, LTRIM(RTRIM(BARCODE)) AS BARKOD FROM [${F}TBLBIRIMLEREX]
    WHERE LTRIM(RTRIM(ISNULL(BARCODE,''))) <> '' AND ABS(ISNULL(CARPAN,1) - 1) < 0.00001`);

  const izahat = (cfg.kabul.izahat || ['20', '26']).map(String).filter((x) => /^\d+$/.test(x));
  const cariKol = await kolonlar(p, `${F}TBLCARI`);
  const cariAd = cariKol.has('FIRMAADI')
    ? `COALESCE(NULLIF(LTRIM(RTRIM(C.FIRMAADI)),''), ${cariKol.has('UNVAN') ? 'C.UNVAN' : "''"}, '')`
    : cariKol.has('UNVAN') ? "ISNULL(C.UNVAN,'')" : "''";
  const kabul = izahat.length
    ? await p.request().input('depo', sql.Int, depo).input('bas', sql.DateTime, new Date(`${cfg.kabul.baslangic || '2000-01-01'}T00:00:00`)).query(`
      SELECT H.IZAHAT, H.BELGENO, MAX(H.EVRAKNO) AS EVRAKNO, H.STOKNO, SUM(H.GIREN) AS GIREN,
             MIN(H.TARIH) AS TARIH, MAX(H.FIRMANO) AS FIRMANO, MAX(${cariAd}) AS CARI
      FROM [${FD}TBLSTOKHAREKETLERI] H
      LEFT JOIN [${F}TBLCARI] C ON C.IND = H.FIRMANO
      WHERE H.IZAHAT IN (${izahat.map((x) => `'${x}'`).join(',')}) AND H.DEPO=@depo AND H.TARIH >= @bas
        AND ISNULL(H.GIREN,0) > 0 AND ISNULL(H.IADE,0) = 0
      GROUP BY H.IZAHAT, H.BELGENO, H.STOKNO`)
    : { recordset: [] };

  const bk = new Map();
  for (const b of barkod.recordset) {
    const id = String(b.STOKNO);
    if (!bk.has(id)) bk.set(id, []);
    if (!bk.get(id).includes(b.BARKOD)) bk.get(id).push(b.BARKOD);
  }

  // Listede olmayan karta (hizmet, pasif) gelen satır terminalde ürünsüz kalırdı; alınmaz.
  const kartVar = new Set(kartlar.recordset.map((k) => k.IND));
  const belgeler = new Map();
  for (const h of kabul.recordset) {
    if (!kartVar.has(h.STOKNO)) continue;
    const id = `${h.IZAHAT}-${h.BELGENO}`;
    if (!belgeler.has(id)) {
      belgeler.set(id, {
        id,
        izahat: String(h.IZAHAT),
        tur: IZAHAT_AD[h.IZAHAT] || `Belge ${h.IZAHAT}`,
        docNo: String(h.EVRAKNO || h.BELGENO).trim(),
        supplier: String(h.CARI || '').trim(),
        date: tarihStr(h.TARIH),
        ts: h.TARIH instanceof Date ? h.TARIH.getTime() : 0,
        lines: [],
      });
    }
    const r = belgeler.get(id);
    if (h.TARIH instanceof Date && h.TARIH.getTime() < r.ts) {
      r.ts = h.TARIH.getTime();
      r.date = tarihStr(h.TARIH);
    }
    r.lines.push({ id: `${id}-${h.STOKNO}`, productId: String(h.STOKNO), accepted: Number(h.GIREN) });
  }

  const depoAd = (await depolar(v, v.firma)).find((d) => d.ind === depo)?.ad || String(depo);
  return {
    at: Date.now(),
    firma: v.firma,
    donem,
    depo,
    depoAd,
    products: kartlar.recordset.map((k) => ({
      id: String(k.IND),
      code: String(k.KOD).trim(),
      name: String(k.AD).trim(),
      unit: String(k.BIRIM || 'Adet').trim() || 'Adet',
    })),
    stock: Object.fromEntries(stok.recordset.map((s) => [String(s.STOKNO), Number(s.KALAN)])),
    moved: hareket.recordset.map((h) => String(h.STOKNO)),
    barcodes: Object.fromEntries(bk),
    receipts: [...belgeler.values()].sort((a, b) => b.ts - a.ts),
  };
}

/** Verilen kartların bu andaki depo stoku (sayım fişi kesilmeden hemen önce okunur). */
async function anlikStok(cfg, stoknolar, req) {
  const { p, FD } = await baglam(cfg.vega);
  const out = new Map(stoknolar.map((s) => [Number(s), 0]));
  for (let i = 0; i < stoknolar.length; i += 500) {
    const parca = stoknolar.slice(i, i + 500).map(Number).filter(Number.isInteger);
    if (!parca.length) continue;
    const r = await (req ? req() : p.request()).input('depo', sql.Int, Number(cfg.vega.depo)).query(`
      SELECT STOKNO, SUM(ENVANTER) AS KALAN FROM [${FD}TBLDEPOENVANTER] WITH (UPDLOCK, HOLDLOCK)
      WHERE DEPO=@depo AND ISNULL(BELGETIPI,0)<>67 AND STOKNO IN (${parca.join(',')}) GROUP BY STOKNO`);
    for (const x of r.recordset) out.set(Number(x.STOKNO), Number(x.KALAN));
  }
  return out;
}

// ---- Sayım fişi yazma ---------------------------------------------------------------------

function gk() {
  return crypto.randomBytes(4).readInt32LE(0);
}

/** Delphi TDateTime (1899-12-30'dan gün) — SIRALAMATARIHIEX. Yerel saatle. */
function oleTarih(d) {
  const yerel = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return (yerel - Date.UTC(1899, 11, 30)) / 86400000;
}

function sqlTip(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return sql.DateTime;
  if (typeof v === 'boolean') return sql.Bit;
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2147483648 ? sql.Int : sql.Decimal(28, 8);
  return sql.NVarChar(sql.MAX);
}

/** Yalnız tabloda olan sütunlara yazar (kurulumdan kuruluma sütun farkı var). IND döner. */
async function ekle(t, tablo, satir, kolonSet) {
  const adlar = Object.keys(satir).filter((k) => kolonSet.has(k.toUpperCase()) && satir[k] !== undefined);
  const req = new sql.Request(t);
  adlar.forEach((k, i) => {
    const tip = sqlTip(satir[k]);
    if (tip) req.input(`p${i}`, tip, satir[k]);
    else req.input(`p${i}`, sql.NVarChar, null);
  });
  // OUTPUT INSERTED yerine SCOPE_IDENTITY: tetikleyicisi olan tabloda OUTPUT hata verir.
  const r = await req.query(
    `INSERT INTO [${tablo}] (${adlar.map((k) => `[${k}]`).join(',')}) VALUES (${adlar.map((_, i) => `@p${i}`).join(',')}); SELECT CAST(SCOPE_IDENTITY() AS int) AS IND;`,
  );
  return r.recordset[0].IND;
}

async function enCokGecen(p, tablo, kolon) {
  if (!(await tabloVar(p, tablo))) return null;
  const r = await p.request().query(`SELECT TOP 1 [${kolon}] AS v FROM [${tablo}] WHERE [${kolon}] IS NOT NULL GROUP BY [${kolon}] ORDER BY COUNT(*) DESC`);
  return r.recordset.length ? r.recordset[0].v : null;
}

/** Sayım fişinin şube/kasa ve kullanıcı alanları: ayarda yoksa Vega'daki mevcut belgelerden. */
async function fisVarsayilanlari(cfg) {
  const { p, FD } = await baglam(cfg.vega);
  const s = cfg.sayim || {};
  const kaynak = [`${FD}TBLSAYIMGIRISBASLIK`, `${FD}TBLALFATBASLIK`, `${FD}TBLSATFATBASLIK`];
  const bul = async (kolon) => {
    for (const t of kaynak) {
      const v = await enCokGecen(p, t, kolon).catch(() => null);
      if (v !== null && v !== '') return v;
    }
    return null;
  };
  return {
    ozelkod1: s.ozelkod1 ?? (await bul('OZELKOD1')) ?? '',
    ozelkod2: s.ozelkod2 ?? (await bul('OZELKOD2')) ?? '',
    userno: Number(s.userno ?? (await bul('USERNO')) ?? 100),
  };
}

async function sonrakiNo(t, tablo, onek) {
  const r = await new sql.Request(t)
    .input('p', sql.NVarChar, onek + '%')
    .query(`SELECT BELGENO FROM [${tablo}] WITH (UPDLOCK, HOLDLOCK) WHERE BELGENO LIKE @p`);
  const re = new RegExp(`^${onek.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  let max = 0;
  for (const x of r.recordset) {
    const m = re.exec(String(x.BELGENO || '').trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return onek + String(max + 1).padStart(7, '0');
}

/**
 * Sayım fişlerini yazar. `kalemler`: [{stokno, hedef}] — hedef, sayımdan çıkan olması gereken depo stoku.
 * Fark fişin kesildiği anda Vega'daki stoğa göre hesaplanır (Kılavuz §23.7 uygulama kuralı):
 * artı fark giriş (93), eksi fark çıkış (94) fişine. Hepsi tek SQL işleminde; hata olursa hiçbiri yazılmaz.
 */
async function sayimYaz(cfg, kalemler, { aciklama = 'Sayım' } = {}) {
  const v = cfg.vega;
  const { p, F, FD } = await baglam(v);
  const depo = Number(v.depo);
  const onek = String(cfg.sayim?.onek || 'T').trim().toUpperCase() || 'T';
  const vars = await fisVarsayilanlari(cfg);

  const tGB = `${FD}TBLSAYIMGIRISBASLIK`, tGH = `${FD}TBLSAYIMGIRISHAREKET`;
  const tCB = `${FD}TBLSAYIMCIKISBASLIK`, tCH = `${FD}TBLSAYIMCIKISHAREKET`;
  const tSH = `${FD}TBLSTOKHAREKETLERI`, tDE = `${FD}TBLDEPOENVANTER`;
  for (const t of [tGB, tGH, tCB, tCH, tSH, tDE]) if (!(await tabloVar(p, t))) throw new Error(`Vega'da ${t} tablosu yok`);
  const kol = {};
  for (const t of [tGB, tGH, tCB, tCH, tSH, tDE]) kol[t] = await kolonlar(p, t);

  const stoknolar = [...new Set(kalemler.map((k) => Number(k.stokno)))].filter(Number.isInteger);
  if (!stoknolar.length) return { docs: [], lines: [] };

  // Kart bilgisi: kod, ad, tip, maliyet; varsayılan birim ve KDV.
  const kart = new Map();
  for (let i = 0; i < stoknolar.length; i += 500) {
    const parca = stoknolar.slice(i, i + 500);
    const r = await p.request().query(`
      SELECT S.IND, S.STOKKODU, S.MALINCINSI, ISNULL(S.STOKTIPI,0) AS STOKTIPI,
             ISNULL(NULLIF(S.MALIYET,0), ISNULL(A.FIYAT, ISNULL(S.ALISFIYATI,0))) AS MALIYET,
             B.IND AS BIRIMEX, ISNULL(B.BIRIMADI,'') AS BIRIM, ISNULL(B.KDV,0) AS KDV
      FROM [${F}TBLSTOKLAR] S
      OUTER APPLY (SELECT TOP 1 X.IND, X.BIRIMADI, X.KDV FROM [${F}TBLBIRIMLEREX] X WHERE X.STOKNO=S.IND ORDER BY X.VARSAYILAN DESC, X.ANABIRIM DESC, X.IND) B
      OUTER APPLY (SELECT TOP 1 H.BIRIMFIYAT AS FIYAT FROM [${tSH}] H WHERE H.STOKNO=S.IND AND H.IZAHAT='20' AND ISNULL(H.BIRIMFIYAT,0)>0 ORDER BY H.TARIH DESC, H.IND DESC) A
      WHERE S.IND IN (${parca.join(',')})`);
    for (const x of r.recordset) kart.set(Number(x.IND), x);
  }

  const t = new sql.Transaction(p);
  await t.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const simdi = await anlikStok(cfg, stoknolar, () => new sql.Request(t));
    const satirlar = [];
    for (const k of kalemler) {
      const s = Number(k.stokno);
      const c = kart.get(s);
      if (!c) continue;
      const once = simdi.get(s) || 0;
      const fark = Math.round((Number(k.hedef) - once) * 10000) / 10000;
      // Yuvarlama artığı fark sayılmaz (Kılavuz §23.7).
      if (Math.abs(fark) < 0.0001) continue;
      satirlar.push({ stokno: s, kart: c, once, hedef: Number(k.hedef), fark });
    }

    const docs = [];
    const bugun = new Date();
    const tarih = new Date(bugun.getFullYear(), bugun.getMonth(), bugun.getDate());
    const termin = new Date(1899, 11, 30);
    let sira = 0;

    for (const giris of [true, false]) {
      const grup = satirlar.filter((x) => (giris ? x.fark > 0 : x.fark < 0));
      if (!grup.length) continue;
      const [tB, tH, tip] = giris ? [tGB, tGH, 93] : [tCB, tCH, 94];
      const belgeNo = await sonrakiNo(t, tB, onek);
      const anlik = new Date();
      anlik.setMilliseconds(0);

      let araToplam = 0, tutar = 0;
      for (const x of grup) {
        const m = Number(x.kart.MALIYET) || 0;
        const miktar = Math.abs(x.fark);
        x.toplam = giris ? Math.round(miktar * m * 100) / 100 : 0;
        araToplam += x.toplam;
        tutar += x.toplam * (1 + (Number(x.kart.KDV) || 0) / 100);
      }

      const baslikInd = await ekle(t, tB, {
        FIRMAADI: '', TUTAR: giris ? Math.round(tutar * 100) / 100 : 0, BELGENO: belgeNo, TARIH: tarih,
        KDV: false, AK: false, ENVANTERUPDATE: false, ODEMETARIHI: tarih, ODMODIFIED: false, ALTBELGENO: '',
        ALT1: 0, ALT2: 0, ALT3: 0, ALT4: 0, DEPO: depo, SUCCESS: false, ALTNOT: aciklama, OZELKOD: 0,
        OZELKOD1: String(vars.ozelkod1 || ''), OZELKOD2: String(vars.ozelkod2 || ''),
        KALEM1: 0, KALEM2: 0, KALEM3: 0, KALEM4: 0, IADE: false, IPTAL: false, CONVERTED: false,
        CREDATE: anlik, LADATE: anlik, FIRMANO: 1, PARABIRIMI: 'TL', KUR: 1, YUVARLAMA: 0, ALLOWYUVARLAMA: false,
        ODENEN: 0, GIRIS: giris, BELGETIPI: tip, EKBELGETIPI: 0, SELECTED: false,
        MASRAF1: 0, MASRAF2: 0, MASRAF3: 0, MASRAF4: 0, MASRAFKDV1: 0, MASRAFKDV2: 0, MASRAFKDV3: 0, MASRAFKDV4: 0,
        ENTEGRE: 0, USERNO: vars.userno, KDVISK: 0, SATISSEKLI: 0, ARATOPLAM: giris ? Math.round(araToplam * 100) / 100 : 0,
        KONSOLIDE: 0, ODEMEOPSIYONU: 0, TEVKIFATORAN: 0, STATUS: 0, MUHASEBELESMEYECEK: false,
        OZELKOD3: '', OZELKOD4: '', HAREKETDEPOSU: depo, KAYNAK: 0,
        OZELKOD5: '', OZELKOD6: '', OZELKOD7: '', OZELKOD8: '', OZELKOD9: '',
        STOKHAREKETEYAZ: true, CARIHAREKETEYAZ: true, UID: '',
      }, kol[tB]);

      for (const x of grup) {
        const c = x.kart;
        const m = Number(c.MALIYET) || 0;
        const miktar = Math.abs(x.fark);
        const satirInd = await ekle(t, tH, {
          TARIH: tarih, DETAY: 0, SELECTED: false, EVRAKNO: baslikInd, FIRMANO: 1, STOKNO: x.stokno,
          MALINCINSI: String(c.MALINCINSI || ''), STOKKODU: String(c.STOKKODU || ''), STOKTIPI: Number(c.STOKTIPI) || 0,
          MIKTAR: miktar, BIRIMMIKTAR: 1, BIRIM: String(c.BIRIM || ''), BIRIMEX: c.BIRIMEX ?? 0, KDV: Number(c.KDV) || 0, KDVTUTARI: 0,
          // Çıkış fişinde Vega tutarı yüzde yüz iskontoyla sıfırlıyor: FIYATI=1, ISK1=100.
          ISK1: giris ? 0 : 100, ISK2: 0, ISK3: 0, ISK4: 0, AFIYATI: m, FIYATI: giris ? m : 1, GERCEKTOPLAM: x.toplam,
          DEPO: depo, PERSONEL: 0, PIRIM: 0, OPSIYON: 0, PROMOSYON: 0, SATISKOSULU: 1, SERIMIKTAR: 1, ENVANTER: miktar,
          KARSISTOKKODU: '', KARSIBARKOD: '', TERMIN: termin, TAKSIT: 0, PARABIRIMI: 'TL', KUR: 1, BARKOD: '',
          PESINAT: 0, MASRAF: 0, MASRAFKDV: 0, ACIKLAMA: aciklama.slice(0, 50), OIV: 0, INDIRIM: 0, OTV: 0, GK: gk(),
        }, kol[tH]);

        const an = new Date();
        an.setMilliseconds(0);
        const ex = Math.round((oleTarih(new Date()) + sira++ * 1e-8) * 1e8) / 1e8;
        await ekle(t, tSH, {
          EVRAKNO: belgeNo, IZAHAT: String(tip), TARIH: tarih, GIREN: giris ? miktar : 0, CIKAN: giris ? 0 : miktar,
          TUTAR: x.toplam, FIRMANO: 1, STOKNO: x.stokno, BELGENO: baslikInd, LN: satirInd, DEPO: depo,
          KDV: Number(c.KDV) || 0, PERSONEL: 0, IADE: false, OPSIYON: 0, BIRIMFIYAT: giris ? m : 1, BIRIMMALIYET: giris ? m : 0,
          SIRALAMATARIHI: an, KUR: 1, PARABIRIMI: 'TL', BIRIMEX: c.BIRIMEX ?? 0, ACIKLAMA: aciklama.slice(0, 100),
          STOKTIPI: Number(c.STOKTIPI) || 0, SIRALAMATARIHIEX: ex,
        }, kol[tSH]);
        // HAREKETIND hareketin LN'i (satır IND'i), TBLSTOKHAREKETLERI.IND değil (Kılavuz §15.1).
        await ekle(t, tDE, {
          TARIH: tarih, STOKNO: x.stokno, DEPO: depo, ENVANTER: giris ? miktar : -miktar, BELGETIPI: tip,
          BELGEIND: baslikInd, SIRALAMATARIHI: an, SIRALAMATARIHIEX: ex, HAREKETIND: satirInd,
        }, kol[tDE]);
      }
      docs.push({ tip, giris, ind: baslikInd, belgeNo, kalem: grup.length, tutar: giris ? Math.round(araToplam * 100) / 100 : 0, firmaDonem: FD });
    }
    await t.commit();
    return {
      docs,
      lines: satirlar.map((x) => ({ stokno: x.stokno, once: x.once, hedef: x.hedef, fark: x.fark })),
    };
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }
}

/** Yazılan sayım fişlerini Vega'dan geri alır (aynı firma/dönemde, başka değişiklik görmemişse). */
async function sayimGeriAl(cfg, docs) {
  const { p } = await baglam(cfg.vega);
  const t = new sql.Transaction(p);
  await t.begin();
  try {
    for (const d of docs) {
      const FD = d.firmaDonem;
      const [tB, tH] = d.giris ? [`${FD}TBLSAYIMGIRISBASLIK`, `${FD}TBLSAYIMGIRISHAREKET`] : [`${FD}TBLSAYIMCIKISBASLIK`, `${FD}TBLSAYIMCIKISHAREKET`];
      const r = await new sql.Request(t).input('ind', sql.Int, d.ind).input('no', sql.NVarChar, d.belgeNo)
        .query(`SELECT IND FROM [${tB}] WHERE IND=@ind AND BELGENO=@no`);
      if (!r.recordset.length) throw new Error(`${d.belgeNo} Vega'da bulunamadı (silinmiş ya da değiştirilmiş olabilir)`);
      const req = () => new sql.Request(t).input('ind', sql.Int, d.ind).input('tip', sql.NVarChar, String(d.tip)).input('tipn', sql.Int, d.tip);
      await req().query(`DELETE FROM [${FD}TBLDEPOENVANTER] WHERE BELGEIND=@ind AND BELGETIPI=@tipn`);
      await req().query(`DELETE FROM [${FD}TBLSTOKHAREKETLERI] WHERE BELGENO=@ind AND IZAHAT=@tip`);
      await req().query(`DELETE FROM [${tH}] WHERE EVRAKNO=@ind`);
      await req().query(`DELETE FROM [${tB}] WHERE IND=@ind`);
    }
    await t.commit();
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }
}

module.exports = { dene, firmalar, donemler, depolar, donemCoz, hazirMi, goruntu, anlikStok, sayimYaz, sayimGeriAl, fisVarsayilanlari, kapat, oleTarih };
