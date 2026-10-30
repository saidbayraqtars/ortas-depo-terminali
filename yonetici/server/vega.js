// Vega (VEGADB, SQL Server) bağlantısı.
// Okunan: stok kartları, barkodlar, depo stoku, mal kabul belgeleri (stok hareketinden).
// Yazılan: raf adresi alanı ayarda "yaz" açıksa stok kartının o alanı (Ortaş KOD10);
// yalnız yönetici onayladığında sayım fişi (tip 93 giriş / 94 çıkış). Desen gerçek Vega
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
    requestTimeout: 240000, // Ortaş'ın ~40 GB veritabanında soğuk ilk sorgu uzun sürebilir
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
  return Boolean(v && v.server && v.user && v.firma);
}

async function baglam(v) {
  if (!hazirMi(v)) throw new Error('Vega bağlantısı ayarlanmadı (Ayarlar › Vega)');
  const p = await baglan(v);
  const donem = await donemCoz(v);
  const F = fk(v.firma);
  const FD = F + dk(donem);
  return { p, donem, F, FD };
}

// Ortaş pasif kartı adına yazarak işaretler, yazım serbest: "(PASİF OLMUŞTUR)…", "… PASİF OLMUŞTUR", "(PASİF)(…)…",
// "PASİFTİR…", "…HPASİF". Ortaş'ta adında PASİF geçen 8.723 kartın hepsi pasif işareti (2026-10-23).
const PASIF_AD = /PAS[İI]F/i;

const IZAHAT_AD = { 20: 'Alış faturası', 26: 'Alış irsaliyesi', 32: 'Stok giriş fişi', 28: 'İade irsaliyesi', D37: 'Depo transferi', D129: 'Gönderim kabulü' };

function tarihStr(d) {
  if (!(d instanceof Date)) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/** Kullanılan depolar: ayarda seçilmediyse firmanın bütün depoları. */
async function kullanilanDepolar(v) {
  const hepsi = await depolar(v, v.firma);
  const secili = (v.depolar || []).map(Number).filter(Number.isInteger);
  const liste = secili.length ? hepsi.filter((d) => secili.includes(d.ind)) : hepsi;
  return liste.length ? liste : hepsi;
}

/**
 * Terminale gidecek Vega verisinin anlık görüntüsü, bütün kullanılan depolar için. Ürünlerin hepsi gelir;
 * terminale hangilerinin gideceğine ana veri kurulurken karar verilir (stoklu / hareketli / rafta olan).
 */
async function goruntu(cfg) {
  const v = cfg.vega;
  // Her sorgunun süresi kaydedilir; zaman aşımında hangi sorgunun takıldığı hata metninde görünür.
  const sureler = {};
  const olc = async (ad, f) => {
    const t0 = Date.now();
    try {
      return await f();
    } catch (e) {
      e.message = `Vega sorgusu "${ad}" (${Math.round((Date.now() - t0) / 1000)} sn): ${e.message}`;
      throw e;
    } finally {
      sureler[ad] = Date.now() - t0;
    }
  };
  const { p, donem, F, FD } = await olc('bağlantı', () => baglam(v));
  const depoListe = await kullanilanDepolar(v);
  const depoIn = depoListe.map((d) => Number(d.ind)).filter(Number.isInteger).join(',') || '0';
  const stokKol = await kolonlar(p, `${F}TBLSTOKLAR`);

  const sart = ['ISNULL(S.DELETED,0)=0', 'S.IND>=100'];
  if (stokKol.has('IPTAL')) sart.push('ISNULL(S.IPTAL,0)=0');
  if (stokKol.has('KOD8')) sart.push("LTRIM(RTRIM(ISNULL(S.KOD8,''))) <> N'PASİF'");
  if (stokKol.has('STOKTIPI')) sart.push('ISNULL(S.STOKTIPI,0) NOT IN (3,7,9)');

  // Raf adresi stok kartının bir özel kod alanında (Ortaş: KOD14 "SERBEST"); alan adı ayardan, tabloda varsa okunur.
  const rafAlan = String(cfg.rafAdresi?.alan || '').toUpperCase();
  const rafKol = rafAlan && stokKol.has(rafAlan) ? `, LTRIM(RTRIM(ISNULL(CAST(S.[${rafAlan}] AS nvarchar(400)),''))) AS RAFADRES` : '';
  const kartlar = await olc('kartlar', () => p.request().query(`
    SELECT S.IND, ISNULL(S.STOKKODU,'') AS KOD, ISNULL(S.MALINCINSI,'') AS AD, ISNULL(B.BIRIMADI,'') AS BIRIM${rafKol}
    FROM [${F}TBLSTOKLAR] S
    OUTER APPLY (SELECT TOP 1 BIRIMADI FROM [${F}TBLBIRIMLEREX] X WHERE X.STOKNO=S.IND ORDER BY X.VARSAYILAN DESC, X.ANABIRIM DESC, X.IND) B
    WHERE ${sart.join(' AND ')}`));

  const stok = await olc('stok', () => p.request().query(`
    SELECT DEPO, STOKNO, SUM(ENVANTER) AS KALAN FROM [${FD}TBLDEPOENVANTER]
    WHERE DEPO IN (${depoIn}) AND ISNULL(BELGETIPI,0)<>67 GROUP BY DEPO, STOKNO HAVING ABS(SUM(ENVANTER)) > 0.00001`));

  const gun = Math.max(1, Number(cfg.urun.gun) || 365);
  const hareket = await olc('hareket', () => p.request().input('gun', sql.Int, gun).query(`
    SELECT DISTINCT STOKNO FROM [${FD}TBLSTOKHAREKETLERI]
    WHERE DEPO IN (${depoIn}) AND TARIH >= DATEADD(day, -@gun, CAST(GETDATE() AS date))`));

  // Barkod TBLBIRIMLEREX'te (Kılavuz §8). Çarpanlı birim (koli) barkodu terminalde 1 adet sayılırdı; alınmaz.
  const barkod = await olc('barkod', () => p.request().query(`
    SELECT STOKNO, LTRIM(RTRIM(BARCODE)) AS BARKOD FROM [${F}TBLBIRIMLEREX]
    WHERE LTRIM(RTRIM(ISNULL(BARCODE,''))) <> '' AND ABS(ISNULL(CARPAN,1) - 1) < 0.00001`));

  const izahat = (cfg.kabul.izahat || ['20', '26']).map(String).filter((x) => /^\d+$/.test(x));
  const cariKol = await kolonlar(p, `${F}TBLCARI`);
  const cariAd = cariKol.has('FIRMAADI')
    ? `COALESCE(NULLIF(LTRIM(RTRIM(C.FIRMAADI)),''), ${cariKol.has('UNVAN') ? 'C.UNVAN' : "''"}, '')`
    : cariKol.has('UNVAN') ? "ISNULL(C.UNVAN,'')" : "''";
  // Belge numarası ve cari belgenin başlığından: Vega'da belge numarası/carisi değişince hareket satırlarındaki
  // EVRAKNO kopyası güncellenmiyor (Ortaş D0020: alış faturasında 1, stok girişte 2 belge farklı). Başlığı olmayan
  // türde (ya da başlık tablosu yoksa) hareketteki değerler kullanılır.
  const basliklar = [];
  for (const x of izahat) {
    const t = BASLIK[x] ? FD + BASLIK[x] : null;
    if (!t || !(await tabloVar(p, t))) continue;
    const k = await kolonlar(p, t);
    if (k.has('BELGENO')) basliklar.push({ x, t, a: `B${x}`, firma: k.has('FIRMANO'), iptal: k.has('IPTAL') });
  }
  const bNo = basliklar.map((b) => `NULLIF(LTRIM(RTRIM(${b.a}.BELGENO)),''), `).join('');
  const bFirma = basliklar.filter((b) => b.firma).map((b) => `${b.a}.FIRMANO, `).join('');
  // Belge depo bazlı: bir belgenin satırları hangi depoya girdiyse o depoda rafa kaldırılır.
  const kabul = izahat.length
    ? await olc('kabul', () => p.request().input('bas', sql.DateTime, new Date(`${cfg.kabul.baslangic || '2000-01-01'}T00:00:00`)).query(`
      WITH G AS (
        SELECT H.IZAHAT, H.BELGENO, H.DEPO, MAX(H.EVRAKNO) AS EVRAKNO, H.STOKNO, SUM(H.GIREN) AS GIREN,
               MIN(H.TARIH) AS TARIH, MAX(H.FIRMANO) AS FIRMANO
        FROM [${FD}TBLSTOKHAREKETLERI] H
        WHERE H.IZAHAT IN (${izahat.map((x) => `'${x}'`).join(',')}) AND H.DEPO IN (${depoIn}) AND H.TARIH >= @bas
          AND ISNULL(H.GIREN,0) > 0 AND ISNULL(H.IADE,0) = 0
        GROUP BY H.IZAHAT, H.BELGENO, H.DEPO, H.STOKNO)
      SELECT G.IZAHAT, G.BELGENO, G.DEPO, COALESCE(${bNo}G.EVRAKNO) AS EVRAKNO, G.STOKNO, G.GIREN, G.TARIH, ${cariAd} AS CARI
      FROM G
      ${basliklar.map((b) => `LEFT JOIN [${b.t}] ${b.a} ON G.IZAHAT = '${b.x}' AND ${b.a}.IND = G.BELGENO`).join('\n      ')}
      LEFT JOIN [${F}TBLCARI] C ON C.IND = COALESCE(${bFirma}G.FIRMANO)
      ${basliklar.some((b) => b.iptal) ? `WHERE ${basliklar.filter((b) => b.iptal).map((b) => `ISNULL(${b.a}.IPTAL,0) = 0`).join(' AND ')}` : ''}`))
    : { recordset: [] };

  // Depolar arası mal girişi stok hareketine değil depo hareket fişine (TBLDEPOHARBASLIK) ve depo envanterine yazılır.
  // 37 = depolar arası transfer (DEPO → HAREKETDEPOSU, anında); 128 = gönderim (DEPO → yoldaki TRANSFER deposu);
  // 129 = gönderimin kabulü (yoldaki depo → DEPO, HAREKETDEPOSU gönderen). Rafa kaldırılacak giriş: 37 ve 129'un artı satırları.
  const transferTip = (cfg.kabul.izahat || []).map(String).filter((x) => /^D\d+$/.test(x)).map((x) => Number(x.slice(1)));
  const tDH = `${FD}TBLDEPOHARBASLIK`;
  if (transferTip.length && (await tabloVar(p, tDH))) {
    const tumDepo = new Map((await depolar(v, v.firma)).map((d) => [Number(d.ind), d.ad]));
    const t = await olc('depoTransfer', () => p.request().input('bas', sql.DateTime, new Date(`${cfg.kabul.baslangic || '2000-01-01'}T00:00:00`)).query(`
      SELECT E.BELGETIPI, E.BELGEIND, E.DEPO, E.STOKNO, SUM(E.ENVANTER) AS GIREN, MIN(B.TARIH) AS TARIH,
             MAX(B.BELGENO) AS EVRAKNO, MAX(CASE WHEN B.BELGETIPI = 129 THEN B.HAREKETDEPOSU ELSE B.DEPO END) AS KAYNAK
      FROM [${FD}TBLDEPOENVANTER] E
      JOIN [${tDH}] B ON B.IND = E.BELGEIND AND B.BELGETIPI = E.BELGETIPI
      WHERE E.BELGETIPI IN (${transferTip.join(',')}) AND E.ENVANTER > 0 AND E.DEPO IN (${depoIn}) AND B.TARIH >= @bas
        AND ISNULL(B.IPTAL,0) = 0
      GROUP BY E.BELGETIPI, E.BELGEIND, E.DEPO, E.STOKNO`));
    for (const r of t.recordset) {
      kabul.recordset.push({
        IZAHAT: `D${r.BELGETIPI}`,
        BELGENO: r.BELGEIND,
        DEPO: r.DEPO,
        EVRAKNO: r.EVRAKNO,
        STOKNO: r.STOKNO,
        GIREN: r.GIREN,
        TARIH: r.TARIH,
        CARI: `${tumDepo.get(Number(r.KAYNAK)) || r.KAYNAK} deposundan`,
        KAYNAKDEPO: Number(r.KAYNAK),
      });
    }
  }

  const bk = new Map();
  for (const b of barkod.recordset) {
    const id = String(b.STOKNO);
    if (!bk.has(id)) bk.set(id, []);
    if (!bk.get(id).includes(b.BARKOD)) bk.get(id).push(b.BARKOD);
  }

  const depoAd = new Map(depoListe.map((d) => [Number(d.ind), d.ad]));
  // Listede olmayan karta (hizmet, pasif) gelen satır terminalde ürünsüz kalırdı; alınmaz.
  const kartVar = new Set(kartlar.recordset.map((k) => k.IND));
  const belgeler = new Map();
  for (const h of kabul.recordset) {
    if (!kartVar.has(h.STOKNO)) continue;
    const depo = Number(h.DEPO);
    const id = `${h.IZAHAT}-${h.BELGENO}-${depo}`;
    if (!belgeler.has(id)) {
      belgeler.set(id, {
        id,
        izahat: String(h.IZAHAT),
        tur: IZAHAT_AD[h.IZAHAT] || `Belge ${h.IZAHAT}`,
        docNo: String(h.EVRAKNO || h.BELGENO).trim(),
        supplier: String(h.CARI || '').trim(),
        date: tarihStr(h.TARIH),
        ts: h.TARIH instanceof Date ? h.TARIH.getTime() : 0,
        depo,
        depoAd: depoAd.get(depo) || String(depo),
        ...(h.KAYNAKDEPO !== undefined ? { kaynakDepo: h.KAYNAKDEPO } : {}),
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

  const stock = {};
  for (const s of stok.recordset) {
    const d = String(s.DEPO);
    (stock[d] ||= {})[String(s.STOKNO)] = Number(s.KALAN);
  }
  // Aynı Vega verisi hep aynı sırada ve aynı biçimde çıksın: içerik özeti değişmediyse ana veri yeniden kurulmaz (depo.js vegaYenile).
  const urunler = kartlar.recordset.map((k) => ({
    id: String(k.IND),
    code: String(k.KOD).trim(),
    name: String(k.AD).trim(),
    unit: String(k.BIRIM || 'Adet').trim() || 'Adet',
    ...(k.RAFADRES ? { raf: String(k.RAFADRES) } : {}),
    ...(PASIF_AD.test(String(k.AD)) ? { pasif: true } : {}),
  })).sort((a, b) => Number(a.id) - Number(b.id));
  for (const b of bk.values()) b.sort();
  const belgeListe = [...belgeler.values()].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of belgeListe) r.lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    surum: 2,
    at: Date.now(),
    sureler,
    firma: v.firma,
    donem,
    depolar: depoListe.map((d) => ({ ind: Number(d.ind), ad: d.ad })),
    products: urunler,
    rafAlan: rafKol ? rafAlan : null,
    stock,
    moved: hareket.recordset.map((h) => String(h.STOKNO)).sort(),
    barcodes: Object.fromEntries(bk),
    receipts: belgeListe,
  };
}

// ---- Tanı: Vega stoku neden terminalde yok ----------------------------------------------------

// Depo envanterindeki belge türleri (BELGETIPI; stok hareketlerinde aynı sayı IZAHAT). Bilinmeyenler numarasıyla gösterilir.
const BELGE_TURU = {
  20: 'Alış faturası', 21: 'Satış faturası', 22: 'Satış iade faturası', 23: 'Alış iade faturası', 26: 'Alış irsaliyesi',
  27: 'Satış irsaliyesi', 28: 'İade irsaliyesi', 32: 'Stok giriş fişi', 33: 'Stok çıkış fişi', 37: 'Depolar arası transfer',
  93: 'Sayım giriş fişi', 94: 'Sayım çıkış fişi', 101: 'Perakende satış', 102: 'Perakende satış iadesi', 103: 'Devir girişi',
  104: 'Devir çıkışı', 128: 'Depo gönderimi', 129: 'Gönderim kabulü',
};
// Depo hareket fişinden (TBLDEPOHARBASLIK) gelen türler; ayarda "D37" gibi seçilir.
const DEPO_BELGE = new Set([37, 128, 129]);
// Stok hareketi türlerinin başlık tabloları (IND = hareketin BELGENO'su, BELGENO = belge numarası).
const BASLIK = { 20: 'TBLALFATBASLIK', 26: 'TBLALIRSBASLIK', 32: 'TBLSTKGIRBASLIK', 93: 'TBLSAYIMGIRISBASLIK' };

/**
 * Bir kartın (stok kodu, kart no ya da barkod) Vega'daki depo envanteri, belge belge. Salt okunur.
 * Girişler (artı) tek tek, çıkışlar depo ve tür başına toplanmış gelir; neden terminale gitmediğine depo.js karar verir.
 */
async function stokTani(cfg, ara) {
  const { p, F, FD } = await baglam(cfg.vega);
  const q = String(ara || '').trim();
  if (!q) throw new Error('Stok kodu, kart no ya da barkod yazın');
  const stokKol = await kolonlar(p, `${F}TBLSTOKLAR`);
  const kol = (k, yedek = 'NULL') => (stokKol.has(k) ? `S.${k}` : yedek);
  const kartlar = await p.request().input('q', sql.NVarChar, q).input('id', sql.Int, /^\d{1,9}$/.test(q) ? Number(q) : -1).query(`
    SELECT TOP 5 S.IND, ISNULL(S.STOKKODU,'') AS KOD, ISNULL(S.MALINCINSI,'') AS AD, ISNULL(S.DELETED,0) AS DELETED,
           ${kol('IPTAL', '0')} AS IPTAL, ${kol('KOD8', "''")} AS KOD8, ${kol('STOKTIPI', '0')} AS STOKTIPI
    FROM [${F}TBLSTOKLAR] S
    WHERE S.STOKKODU = @q OR S.IND = @id
       OR S.IND IN (SELECT STOKNO FROM [${F}TBLBIRIMLEREX] WHERE LTRIM(RTRIM(BARCODE)) = @q)
    ORDER BY CASE WHEN S.STOKKODU = @q THEN 0 ELSE 1 END, S.IND`);
  const out = { kartlar: [], depolar: await depolar(cfg.vega, cfg.vega.firma) };
  for (const k of kartlar.recordset) {
    const suzgec = [];
    if (k.DELETED) suzgec.push('Kart silinmiş');
    if (k.IND < 100) suzgec.push('Sistem kartı (kart no 100\'den küçük)');
    if (k.IPTAL) suzgec.push('Kart iptal');
    if (String(k.KOD8 || '').trim().toLocaleUpperCase('tr') === 'PASİF') suzgec.push('Kart pasif (KOD8 = PASİF)');
    if ([3, 7, 9].includes(Number(k.STOKTIPI))) suzgec.push(`Stok tipi ${k.STOKTIPI} (hizmet/masraf kartı)`);
    const id = Number(k.IND);
    const req = () => p.request().input('id', sql.Int, id);
    const stok = await req().query(`
      SELECT DEPO, SUM(ENVANTER) AS KALAN FROM [${FD}TBLDEPOENVANTER]
      WHERE STOKNO=@id AND ISNULL(BELGETIPI,0)<>67 GROUP BY DEPO`);
    // Envanterin HAREKETIND'i hareket satırına güvenilir bağlanmıyor; hareket belge+kart+depo+tür ile eşlenir.
    const giris = await req().query(`
      SELECT TOP 300 E.DEPO, E.BELGETIPI, E.BELGEIND, SUM(E.ENVANTER) AS MIKTAR, MIN(E.TARIH) AS TARIH,
             MAX(CAST(ISNULL(H.IADE,0) AS int)) AS IADE, MIN(H.TARIH) AS HTARIH, MAX(H.EVRAKNO) AS EVRAKNO
      FROM [${FD}TBLDEPOENVANTER] E
      OUTER APPLY (SELECT TOP 1 X.IADE, X.TARIH, X.EVRAKNO FROM [${FD}TBLSTOKHAREKETLERI] X
                   WHERE X.BELGENO = E.BELGEIND AND X.STOKNO = E.STOKNO AND X.DEPO = E.DEPO
                     AND X.IZAHAT = CAST(E.BELGETIPI AS nvarchar(10)) AND ISNULL(X.GIREN,0) > 0) H
      WHERE E.STOKNO=@id AND ISNULL(E.BELGETIPI,0)<>67
      GROUP BY E.DEPO, E.BELGETIPI, E.BELGEIND HAVING SUM(E.ENVANTER) > 0.00001
      ORDER BY MIN(E.TARIH) DESC`);
    const cikis = await req().query(`
      SELECT DEPO, BELGETIPI, COUNT(DISTINCT BELGEIND) AS ADET, SUM(ENVANTER) AS MIKTAR FROM [${FD}TBLDEPOENVANTER]
      WHERE STOKNO=@id AND ISNULL(BELGETIPI,0)<>67 AND ENVANTER < 0 GROUP BY DEPO, BELGETIPI ORDER BY DEPO, BELGETIPI`);
    // Belge numarası ve iptal başlıktan.
    const baslik = new Map();
    const tipler = new Map();
    for (const g of giris.recordset) {
      if (!tipler.has(g.BELGETIPI)) tipler.set(g.BELGETIPI, new Set());
      tipler.get(g.BELGETIPI).add(Number(g.BELGEIND));
    }
    for (const [tip, indler] of tipler) {
      const ad = DEPO_BELGE.has(tip) ? `${FD}TBLDEPOHARBASLIK` : BASLIK[tip] ? FD + BASLIK[tip] : null;
      if (!ad || !(await tabloVar(p, ad))) continue;
      const bk = await kolonlar(p, ad);
      const r = await p.request().query(`
        SELECT IND, ${bk.has('BELGENO') ? 'BELGENO' : 'NULL AS BELGENO'}, ${bk.has('IPTAL') ? 'ISNULL(IPTAL,0)' : '0'} AS IPTAL
        FROM [${ad}] WHERE IND IN (${[...indler].join(',')})${DEPO_BELGE.has(tip) ? ` AND BELGETIPI = ${Number(tip)}` : ''}`);
      for (const b of r.recordset) baslik.set(`${tip}-${b.IND}`, b);
    }
    out.kartlar.push({
      id: String(id),
      kod: String(k.KOD).trim(),
      ad: String(k.AD).trim(),
      suzgec,
      pasifAd: PASIF_AD.test(String(k.AD)),
      stok: Object.fromEntries(stok.recordset.map((s) => [String(s.DEPO), Number(s.KALAN)])),
      girisler: giris.recordset.map((g) => {
        const b = baslik.get(`${g.BELGETIPI}-${g.BELGEIND}`);
        const tarih = g.HTARIH || g.TARIH;
        return {
          depo: Number(g.DEPO),
          tip: Number(g.BELGETIPI),
          tur: BELGE_TURU[g.BELGETIPI] || `Belge türü ${g.BELGETIPI}`,
          belgeInd: Number(g.BELGEIND),
          belgeNo: String((b && b.BELGENO) || g.EVRAKNO || g.BELGEIND).trim(),
          tarih: tarihStr(tarih),
          gun: tarih instanceof Date ? `${tarih.getFullYear()}-${String(tarih.getMonth() + 1).padStart(2, '0')}-${String(tarih.getDate()).padStart(2, '0')}` : '',
          miktar: Number(g.MIKTAR),
          iade: Boolean(g.IADE),
          iptal: Boolean(b && b.IPTAL),
        };
      }),
      cikislar: cikis.recordset.map((c) => ({ depo: Number(c.DEPO), tip: Number(c.BELGETIPI), tur: BELGE_TURU[c.BELGETIPI] || `Belge türü ${c.BELGETIPI}`, adet: c.ADET, miktar: Number(c.MIKTAR) })),
    });
  }
  return out;
}

// ---- Stok kartı alanı yazma (raf adresi) ----------------------------------------------------

/** Stok kartındaki metin alanının karakter uzunluğu; alan yoksa ya da metin değilse null. */
async function kartAlanUzunluk(cfg, alan) {
  const { p, F } = await baglam(cfg.vega);
  const r = await p.request().input('t', sql.NVarChar, `${F}TBLSTOKLAR`).input('k', sql.NVarChar, alan).query(`
    SELECT c.max_length AS uz, y.name AS tip FROM sys.columns c JOIN sys.types y ON y.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID(@t) AND c.name = @k`);
  const x = r.recordset[0];
  if (!x || !/char$/i.test(x.tip)) return null;
  if (x.uz === -1) return 4000;
  return /^n/i.test(x.tip) ? x.uz / 2 : x.uz;
}

/** Kartların bir metin alanını yazar. satirlar: [{id, deger}]; 500'lük parçalar, her parça tek UPDATE. */
async function kartAlanYaz(cfg, alan, satirlar, parcaBitti = () => {}) {
  if (!/^[A-Z][A-Z0-9_]{0,30}$/.test(alan)) throw new Error('Geçersiz alan adı');
  const { p, F } = await baglam(cfg.vega);
  for (let i = 0; i < satirlar.length; i += 500) {
    const parca = satirlar.slice(i, i + 500);
    const req = p.request();
    const degerler = parca.map((s, j) => {
      req.input(`i${j}`, sql.Int, Number(s.id));
      req.input(`d${j}`, sql.NVarChar(400), s.deger);
      return `(@i${j}, @d${j})`;
    });
    await req.query(`UPDATE S SET [${alan}] = V.D FROM [${F}TBLSTOKLAR] S JOIN (VALUES ${degerler.join(',')}) V(IND, D) ON V.IND = S.IND`);
    parcaBitti(parca);
  }
  return satirlar.length;
}

/** Verilen kartların bu andaki depo stoku (sayım fişi kesilmeden hemen önce okunur). `depo` tek depo ya da depo listesi (toplamı döner). */
async function anlikStok(cfg, stoknolar, depo, req) {
  const { p, FD } = await baglam(cfg.vega);
  const out = new Map(stoknolar.map((s) => [Number(s), 0]));
  const depoIn = [].concat(depo).map(Number).filter(Number.isInteger).join(',');
  for (let i = 0; i < stoknolar.length; i += 500) {
    const parca = stoknolar.slice(i, i + 500).map(Number).filter(Number.isInteger);
    if (!parca.length) continue;
    const r = await (req ? req() : p.request()).query(`
      SELECT STOKNO, SUM(ENVANTER) AS KALAN FROM [${FD}TBLDEPOENVANTER] WITH (UPDLOCK, HOLDLOCK)
      WHERE DEPO IN (${depoIn}) AND ISNULL(BELGETIPI,0)<>67 AND STOKNO IN (${parca.join(',')}) GROUP BY STOKNO`);
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
 * `stokDepolari`: hedefin karşılaştırılacağı depolar (sanal bekleme deposu varsa grup toplamı); fiş yine `depo`ya yazılır.
 */
async function sayimYaz(cfg, kalemler, { aciklama = 'Sayım', depo: depoNo, stokDepolari = null } = {}) {
  const v = cfg.vega;
  const { p, F, FD } = await baglam(v);
  const depo = Number(depoNo ?? v.depo);
  if (!Number.isInteger(depo)) throw new Error('Sayımın deposu belli değil');
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
    const simdi = await anlikStok(cfg, stoknolar, stokDepolari || depo, () => new sql.Request(t));
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

// ---- Depolar arası transfer: depo gönderim (128) ve gönderim kabul (129) fişi -----------------------
// Gerçek Ortaş kaydından (VEGADBortas F0101D0020, 2026-10-23, 128: A0000575, 129: A0006795):
//   128: başlık DEPO = gönderen, HAREKETDEPOSU = varış, GIRIS = 1; satır DEPO = yoldaki TRANSFER deposu;
//        envanter: gönderen −q, yoldaki depo +q.
//   129: başlık DEPO = alan, HAREKETDEPOSU = gönderen, GIRIS = 0; satır DEPO = yoldaki depo;
//        envanter: alan +q, yoldaki depo −q.
// Stok hareketine (TBLSTOKHAREKETLERI) yazılmaz; iki tür için belge numarası serisi ayrıdır (A + 7 hane).
// Tabloda IND dışında NOT NULL sütun yok; ama Vega ekranının açabilmesi için aşağıdaki sütunlar fişte dolu olmalı:
// yazımdan sonra aynı işlemde okunup doğrulanır, eksik varsa hiçbir şey yazılmaz.

const TRANSFER_ZORUNLU = {
  baslik: ['BELGENO', 'TARIH', 'ODEMETARIHI', 'DEPO', 'HAREKETDEPOSU', 'BELGETIPI', 'GIRIS', 'USERNO', 'OZELKOD1', 'OZELKOD2',
    'TUTAR', 'ARATOPLAM', 'CREDATE', 'LADATE', 'UID', 'PARABIRIMI', 'KUR'],
  satir: ['TARIH', 'EVRAKNO', 'STOKNO', 'MALINCINSI', 'STOKKODU', 'MIKTAR', 'BIRIMMIKTAR', 'BIRIM', 'BIRIMEX', 'KDV',
    'AFIYATI', 'FIYATI', 'GERCEKTOPLAM', 'DEPO', 'ENVANTER', 'SATISKOSULU', 'SERIMIKTAR', 'GRUPMIKTAR', 'PARABIRIMI', 'KUR', 'GK'],
  envanter: ['TARIH', 'STOKNO', 'DEPO', 'ENVANTER', 'BELGETIPI', 'BELGEIND', 'SIRALAMATARIHI', 'SIRALAMATARIHIEX', 'HAREKETIND'],
};

async function transferNo(t, tablo, tip, onek) {
  const r = await new sql.Request(t)
    .input('tip', sql.SmallInt, tip)
    .input('p', sql.NVarChar, onek + '%')
    .query(`SELECT BELGENO FROM [${tablo}] WITH (UPDLOCK, HOLDLOCK) WHERE BELGETIPI=@tip AND BELGENO LIKE @p`);
  const re = new RegExp(`^${onek}(\\d+)$`);
  let max = 0;
  for (const x of r.recordset) {
    const m = re.exec(String(x.BELGENO || '').trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return onek + String(max + 1).padStart(7, '0');
}

/** Fişe yazılacak Vega kullanıcı numarası: ayarda varsa o; yoksa aynı türde bu depodan en çok kullanılan; yoksa genel varsayılan. */
async function transferUserNo(t, tablo, tip, depo, cfg) {
  const ayar = Number(cfg.transfer?.userno);
  if (Number.isInteger(ayar) && ayar > 0) return ayar;
  for (const depoSart of ['AND DEPO=@depo', '']) {
    const r = await new sql.Request(t).input('tip', sql.SmallInt, tip).input('depo', sql.Int, depo)
      .query(`SELECT TOP 1 USERNO FROM [${tablo}] WHERE BELGETIPI=@tip AND USERNO IS NOT NULL ${depoSart} GROUP BY USERNO ORDER BY COUNT(*) DESC`);
    if (r.recordset.length) return Number(r.recordset[0].USERNO);
  }
  return (await fisVarsayilanlari(cfg)).userno;
}

/**
 * Depo hareket fişi yazar. `tip`: 128 gönderim / 129 kabul. `depo`: fişin deposu (128'de gönderen, 129'da alan),
 * `karsi`: karşı depo (HAREKETDEPOSU), `yolda`: yoldaki depo. `kalemler`: [{stokno, miktar}]. Tek SQL işlemi;
 * başlık, satır ve envanter satırları yazılıp zorunlu alanlar ve toplamlar doğrulanır, tutmazsa geri alınır.
 * Dönen: { ind, belgeNo, kalem, tutar, userno, negatif }. `negatif`: gönderen depoda stoğu yetmeyen kart sayısı (128).
 */
async function transferYaz(cfg, { tip, depo, karsi, yolda, kalemler, aciklama = '' }) {
  if (![128, 129].includes(tip)) throw new Error('Geçersiz transfer belge türü');
  const ids = [depo, karsi, yolda].map(Number);
  if (!ids.every(Number.isInteger)) throw new Error('Transfer depoları belli değil');
  if (new Set(ids).size !== 3) throw new Error('Gönderen, alan ve yoldaki depo farklı olmalı');
  const birlesik = new Map();
  for (const k of kalemler || []) {
    const s = Number(k.stokno);
    const m = Math.round(Number(k.miktar) * 10000) / 10000;
    if (!Number.isInteger(s) || !(m > 0)) throw new Error('Transfer satırında ürün ya da miktar geçersiz');
    birlesik.set(s, Math.round(((birlesik.get(s) || 0) + m) * 10000) / 10000);
  }
  if (!birlesik.size) throw new Error('Transferde satır yok');

  const v = cfg.vega;
  const { p, F, FD } = await baglam(v);
  const tB = `${FD}TBLDEPOHARBASLIK`, tH = `${FD}TBLDEPOHARHAREKET`, tE = `${FD}TBLDEPOENVANTER`;
  for (const t of [tB, tH, tE]) if (!(await tabloVar(p, t))) throw new Error(`Vega'da ${t} tablosu yok`);
  const kol = { [tB]: await kolonlar(p, tB), [tH]: await kolonlar(p, tH), [tE]: await kolonlar(p, tE) };
  const eksikKolon = [
    ...TRANSFER_ZORUNLU.baslik.filter((c) => !kol[tB].has(c)).map((c) => `${tB}.${c}`),
    ...TRANSFER_ZORUNLU.satir.filter((c) => !kol[tH].has(c)).map((c) => `${tH}.${c}`),
    ...TRANSFER_ZORUNLU.envanter.filter((c) => !kol[tE].has(c)).map((c) => `${tE}.${c}`),
  ];
  if (eksikKolon.length) throw new Error(`Vega şeması beklenenden farklı, sütun yok: ${eksikKolon.slice(0, 4).join(', ')}`);

  const depoAd = new Map((await depolar(v, v.firma)).map((d) => [Number(d.ind), d.ad]));
  for (const d of ids) if (!depoAd.has(d)) throw new Error(`Vega'da ${d} numaralı depo yok`);
  const onekHam = String(cfg.transfer?.onek || 'A').trim().toUpperCase();
  const onek = /^[A-Z]{1,3}$/.test(onekHam) ? onekHam : 'A';

  // Kart bilgisi (kod, ad, tip, maliyet, varsayılan birim ve KDV, barkod). Kartı ya da birimi olmayan ürün yazılmaz.
  const stoknolar = [...birlesik.keys()];
  const kart = new Map();
  for (let i = 0; i < stoknolar.length; i += 500) {
    const parca = stoknolar.slice(i, i + 500);
    const r = await p.request().query(`
      SELECT S.IND, S.STOKKODU, S.MALINCINSI, ISNULL(S.STOKTIPI,0) AS STOKTIPI,
             ISNULL(NULLIF(S.MALIYET,0), ISNULL(A.FIYAT, ISNULL(S.ALISFIYATI,0))) AS MALIYET,
             B.IND AS BIRIMEX, ISNULL(B.BIRIMADI,'') AS BIRIM, ISNULL(B.KDV,0) AS KDV, LTRIM(RTRIM(ISNULL(B.BARCODE,''))) AS BARKOD
      FROM [${F}TBLSTOKLAR] S
      OUTER APPLY (SELECT TOP 1 X.IND, X.BIRIMADI, X.KDV, X.BARCODE FROM [${F}TBLBIRIMLEREX] X WHERE X.STOKNO=S.IND ORDER BY X.VARSAYILAN DESC, X.ANABIRIM DESC, X.IND) B
      OUTER APPLY (SELECT TOP 1 H.BIRIMFIYAT AS FIYAT FROM [${FD}TBLSTOKHAREKETLERI] H WHERE H.STOKNO=S.IND AND H.IZAHAT='20' AND ISNULL(H.BIRIMFIYAT,0)>0 ORDER BY H.TARIH DESC, H.IND DESC) A
      WHERE S.IND IN (${parca.join(',')})`);
    for (const x of r.recordset) kart.set(Number(x.IND), x);
  }
  for (const s of stoknolar) {
    const c = kart.get(s);
    if (!c) throw new Error(`Vega'da ${s} numaralı stok kartı yok`);
    if (!String(c.STOKKODU || '').trim() || !String(c.MALINCINSI || '').trim()) throw new Error(`${s} numaralı kartta stok kodu ya da ad boş`);
    if (c.BIRIMEX === null || c.BIRIMEX === undefined || !String(c.BIRIM || '').trim()) throw new Error(`${String(c.STOKKODU).trim()} kartında birim tanımlı değil`);
  }

  const t = new sql.Transaction(p);
  await t.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const belgeNo = await transferNo(t, tB, tip, onek);
    const userno = await transferUserNo(t, tB, tip, depo, cfg);
    // Gönderen depoda stok yetmiyorsa fiş yine yazılır (Vega'da eksi bakiye olabilir) ama bildirilir.
    let negatif = 0;
    if (tip === 128) {
      const simdi = await anlikStok(cfg, stoknolar, depo, () => new sql.Request(t));
      for (const [s, m] of birlesik) if ((simdi.get(s) || 0) + 1e-9 < m) negatif++;
    }

    const bugun = new Date();
    const tarih = new Date(bugun.getFullYear(), bugun.getMonth(), bugun.getDate());
    const anlik = new Date();
    anlik.setMilliseconds(0);
    const kalemTutar = (c, m) => Math.round(Number(c.MALIYET || 0) * m * 100) / 100;

    let araToplam = 0, tutar = 0;
    for (const [s, m] of birlesik) {
      const c = kart.get(s);
      const toplam = kalemTutar(c, m);
      araToplam += toplam;
      tutar += toplam * (1 + (Number(c.KDV) || 0) / 100);
    }
    araToplam = Math.round(araToplam * 100) / 100;
    tutar = Math.round(tutar * 100) / 100;

    const ad = depoAd.get(depo);
    const baslikInd = await ekle(t, tB, {
      TUTAR: tutar, BELGENO: belgeNo, TARIH: tarih, KDV: false, AK: false, ODEMETARIHI: tarih, ODMODIFIED: false,
      ALT1: 0, ALT2: 0, ALT3: 0, ALT4: 0, DEPO: depo, ALTNOT: aciklama || undefined, OZELKOD1: ad, OZELKOD2: ad,
      IADE: false, IPTAL: false, CONVERTED: false, CREDATE: anlik, LADATE: anlik, PARABIRIMI: 'TL', KUR: 1,
      YUVARLAMA: 0, ALLOWYUVARLAMA: false, ODENEN: 0, GIRIS: tip === 128, BELGETIPI: tip, EKBELGETIPI: 0,
      MASRAF1: 0, MASRAF2: 0, MASRAF3: 0, MASRAF4: 0, MASRAFKDV1: 0, MASRAFKDV2: 0, MASRAFKDV3: 0, MASRAFKDV4: 0,
      ENTEGRE: 0, USERNO: userno, ARATOPLAM: araToplam, YURTDISI: false, MUHASEBELESMEYECEK: false,
      HAREKETDEPOSU: karsi, KAYNAK: 0, STOKHAREKETEYAZ: false, CARIHAREKETEYAZ: false,
      UID: `{${crypto.randomUUID().toUpperCase()}}`,
    }, kol[tB]);

    // Gönderimde gönderen −q ve yoldaki depo +q; kabulde alan +q ve yoldaki depo −q (gerçek fişteki satır sırası).
    const [ilkDepo, ikinciDepo, ilkIsaret] = tip === 128 ? [depo, yolda, -1] : [depo, yolda, 1];
    let sira = 0;
    for (const [s, m] of birlesik) {
      const c = kart.get(s);
      const maliyet = Number(c.MALIYET) || 0;
      const satirInd = await ekle(t, tH, {
        TARIH: tarih, DETAY: 0, EVRAKNO: baslikInd, STOKNO: s, MALINCINSI: String(c.MALINCINSI).trim(), STOKKODU: String(c.STOKKODU).trim(),
        STOKTIPI: Number(c.STOKTIPI) || 0, MIKTAR: m, BIRIMMIKTAR: 1, BIRIM: String(c.BIRIM).trim(), BIRIMEX: c.BIRIMEX, KDV: Number(c.KDV) || 0,
        ISK1: 0, ISK2: 0, ISK3: 0, ISK4: 0, ISK5: 0, ISK6: 0, AFIYATI: maliyet, FIYATI: maliyet, GERCEKTOPLAM: kalemTutar(c, m),
        DEPO: yolda, PERSONEL: 0, PIRIM: 0, OPSIYON: 0, PROMOSYON: 0, SATISKOSULU: 1, SERIMIKTAR: 1, GRUPMIKTAR: 1, ENVANTER: m,
        PARABIRIMI: 'TL', KUR: 1, BARKOD: String(c.BARKOD || ''), MASRAF: 0, OIV: 0, INDIRIM: 0, OTV: 0, GK: gk(),
      }, kol[tH]);
      const an = new Date();
      an.setMilliseconds(0);
      for (const [d, isaret] of [[ilkDepo, ilkIsaret], [ikinciDepo, -ilkIsaret]]) {
        const ex = Math.round((oleTarih(new Date()) + sira++ * 1e-8) * 1e8) / 1e8;
        await ekle(t, tE, {
          TARIH: tarih, STOKNO: s, DEPO: d, ENVANTER: isaret * m, BELGETIPI: tip, BELGEIND: baslikInd,
          SIRALAMATARIHI: an, SIRALAMATARIHIEX: ex, HAREKETIND: satirInd,
        }, kol[tE]);
      }
    }

    // Doğrulama: zorunlu alanlar dolu, satır ve envanter sayısı ve toplamları tutuyor.
    const bos = (liste, tablo, ad) => liste.filter((c) => kol[tablo].has(c)).map((c) => `SUM(CASE WHEN [${c}] IS NULL THEN 1 ELSE 0 END) AS [${ad}_${c}]`).join(', ');
    const rq = () => new sql.Request(t).input('b', sql.Int, baslikInd).input('tip', sql.SmallInt, tip);
    const bk = (await rq().query(`SELECT ${bos(TRANSFER_ZORUNLU.baslik, tB, 'B')}, COUNT(*) AS N FROM [${tB}] WHERE IND=@b AND BELGETIPI=@tip`)).recordset[0];
    const hk = (await rq().query(`SELECT ${bos(TRANSFER_ZORUNLU.satir, tH, 'H')}, COUNT(*) AS N, SUM(MIKTAR) AS Q, SUM(GERCEKTOPLAM) AS T FROM [${tH}] WHERE EVRAKNO=@b`)).recordset[0];
    const ek = (await rq().query(`SELECT ${bos(TRANSFER_ZORUNLU.envanter, tE, 'E')}, COUNT(*) AS N, SUM(ENVANTER) AS TOPLAM,
      SUM(CASE WHEN DEPO=${depo} THEN ENVANTER ELSE 0 END) AS D1, SUM(CASE WHEN DEPO=${yolda} THEN ENVANTER ELSE 0 END) AS D2
      FROM [${tE}] WHERE BELGEIND=@b AND BELGETIPI=@tip`)).recordset[0];
    const hatalar = [];
    if (bk.N !== 1) hatalar.push('başlık yazılmadı');
    if (hk.N !== birlesik.size) hatalar.push(`satır sayısı ${hk.N}/${birlesik.size}`);
    if (ek.N !== birlesik.size * 2) hatalar.push(`envanter satırı ${ek.N}/${birlesik.size * 2}`);
    const toplamQ = [...birlesik.values()].reduce((a, b) => a + b, 0);
    if (Math.abs(Number(hk.Q) - toplamQ) > 0.0001) hatalar.push('satır miktarı tutmuyor');
    if (Math.abs(Number(ek.TOPLAM)) > 0.0001) hatalar.push('envanter toplamı sıfır değil');
    if (Math.abs(Number(ek.D1) - (tip === 128 ? -toplamQ : toplamQ)) > 0.0001) hatalar.push('gönderen/alan depo envanteri tutmuyor');
    if (Math.abs(Number(ek.D2) + (tip === 128 ? -toplamQ : toplamQ)) > 0.0001) hatalar.push('yoldaki depo envanteri tutmuyor');
    for (const [k, n] of Object.entries({ ...bk, ...hk, ...ek })) if (/^[BHE]_/.test(k) && Number(n) > 0) hatalar.push(`${k.slice(2)} boş`);
    if (hatalar.length) throw new Error(`Vega fişi doğrulanamadı (${hatalar.join('; ')}); hiçbir şey yazılmadı`);

    await t.commit();
    return { ind: baslikInd, belgeNo, kalem: birlesik.size, tutar, userno, negatif, firmaDonem: FD };
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }
}

/**
 * Programın yazdığı depo hareket fişini (128 gönderim / 129 kabul) Vega'dan siler: envanter satırları, belge satırları, başlık;
 * tek SERIALIZABLE işlemde. Fişin hâlâ programın yazdığı fiş olduğu doğrulanır (aynı numara ve tür, satır sayısı); kullanıcı
 * Vega'da değiştirmişse ya da silmişse hiçbir şey silinmez. `firmaDonem`: fişin yazıldığı tablo öneki (kayıtlı değilse güncel).
 * Dönen: { satir, envanter }.
 */
async function transferGeriAl(cfg, { tip, ind, belgeNo, firmaDonem }) {
  if (![128, 129].includes(tip)) throw new Error('Geçersiz transfer belge türü');
  if (!Number.isInteger(ind)) throw new Error('Fişin Vega numarası yok');
  const { p, FD } = await baglam(cfg.vega);
  const fd = String(firmaDonem || FD);
  if (!/^F\d+D\d+$/.test(fd)) throw new Error('Firma/dönem öneki geçersiz');
  const tB = `${fd}TBLDEPOHARBASLIK`, tH = `${fd}TBLDEPOHARHAREKET`, tE = `${fd}TBLDEPOENVANTER`;
  const t = new sql.Transaction(p);
  await t.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const rq = () => new sql.Request(t).input('ind', sql.Int, ind).input('tip', sql.SmallInt, tip);
    const b = await rq().query(`SELECT BELGENO, BELGETIPI FROM [${tB}] WITH (UPDLOCK, HOLDLOCK) WHERE IND=@ind`);
    if (!b.recordset.length) throw new Error(`${belgeNo || ind} Vega'da bulunamadı (silinmiş ya da değiştirilmiş olabilir)`);
    const baslik = b.recordset[0];
    if (Number(baslik.BELGETIPI) !== tip || (belgeNo && String(baslik.BELGENO || '').trim() !== String(belgeNo).trim())) {
      throw new Error(`Vega'daki ${ind} numaralı belge programın yazdığı fiş değil (${String(baslik.BELGENO || '').trim()}); silinmedi`);
    }
    // Envanter satırı satır başına iki tane (çıkış ve giriş depo). Sayı tutmuyorsa fiş sonradan değiştirilmiş demektir.
    const sayim = (await rq().query(`
      SELECT (SELECT COUNT(*) FROM [${tH}] WHERE EVRAKNO=@ind) AS S,
             (SELECT COUNT(*) FROM [${tE}] WHERE BELGEIND=@ind AND BELGETIPI=@tip) AS E`)).recordset[0];
    if (sayim.E !== sayim.S * 2) throw new Error(`Vega fişinde beklenmeyen kayıt sayısı (satır ${sayim.S}, envanter ${sayim.E}); fiş değiştirilmiş olabilir, silinmedi`);
    await rq().query(`DELETE FROM [${tE}] WHERE BELGEIND=@ind AND BELGETIPI=@tip`);
    await rq().query(`DELETE FROM [${tH}] WHERE EVRAKNO=@ind`);
    await rq().query(`DELETE FROM [${tB}] WHERE IND=@ind`);
    await t.commit();
    return { satir: sayim.S, envanter: sayim.E };
  } catch (e) {
    await t.rollback().catch(() => {});
    throw e;
  }
}

/**
 * Açık gönderimlerin Vega'daki durumu. Gönderim (128) ile kabul (129) arasında belge bağı yoktur, ikisi de yoldaki
 * depo üzerinden gider; bu yüzden her (gönderen, alan, ürün) için toplam gönderilen ve toplam alınan döner, hangi
 * gönderimin açık olduğu depo tarafında bu toplamlardan çıkarılır. `bas`: bu tarihten sonraki belgeler,
 * `alanlar`: alan depoları (terminalin kullandığı depolar).
 */
async function transferOku(cfg, { bas, alanlar, kaynaklar }) {
  const ids = (alanlar || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return { sevkler: [], havuz: [] };
  // `kaynaklar` verilirse gönderen depo da bu listeden olmalı (transfer çifti dışındaki depolar okunmaz).
  const kay = (kaynaklar || []).map(Number).filter(Number.isInteger);
  const kayB = kay.length ? `AND B.DEPO IN (${kay.join(',')})` : '';
  const kayH = kay.length ? `AND (CASE WHEN B.BELGETIPI = 128 THEN B.DEPO ELSE B.HAREKETDEPOSU END) IN (${kay.join(',')})` : '';
  const { p, FD } = await baglam(cfg.vega);
  const tB = `${FD}TBLDEPOHARBASLIK`, tH = `${FD}TBLDEPOHARHAREKET`;
  if (!(await tabloVar(p, tB)) || !(await tabloVar(p, tH))) return { sevkler: [], havuz: [] };
  const iptal = (await kolonlar(p, tB)).has('IPTAL') ? 'AND ISNULL(B.IPTAL,0)=0' : '';
  const q = () => p.request().input('bas', sql.DateTime, bas);
  const sev = await q().query(`
    SELECT B.IND, B.BELGENO, B.TARIH, B.DEPO, B.HAREKETDEPOSU, H.STOKNO, SUM(H.MIKTAR) AS MIKTAR
    FROM [${tB}] B JOIN [${tH}] H ON H.EVRAKNO = B.IND
    WHERE B.BELGETIPI = 128 ${iptal} AND B.TARIH >= @bas AND B.HAREKETDEPOSU IN (${ids.join(',')}) ${kayB}
    GROUP BY B.IND, B.BELGENO, B.TARIH, B.DEPO, B.HAREKETDEPOSU, H.STOKNO`);
  const hav = await q().query(`
    SELECT B.BELGETIPI, CASE WHEN B.BELGETIPI = 128 THEN B.DEPO ELSE B.HAREKETDEPOSU END AS KAYNAK,
           CASE WHEN B.BELGETIPI = 128 THEN B.HAREKETDEPOSU ELSE B.DEPO END AS HEDEF, H.STOKNO, SUM(H.MIKTAR) AS Q
    FROM [${tB}] B JOIN [${tH}] H ON H.EVRAKNO = B.IND
    WHERE B.BELGETIPI IN (128, 129) ${iptal} AND B.TARIH >= @bas
      AND (CASE WHEN B.BELGETIPI = 128 THEN B.HAREKETDEPOSU ELSE B.DEPO END) IN (${ids.join(',')}) ${kayH}
    GROUP BY B.BELGETIPI, CASE WHEN B.BELGETIPI = 128 THEN B.DEPO ELSE B.HAREKETDEPOSU END,
             CASE WHEN B.BELGETIPI = 128 THEN B.HAREKETDEPOSU ELSE B.DEPO END, H.STOKNO`);
  const belgeler = new Map();
  for (const r of sev.recordset) {
    if (!belgeler.has(r.IND)) belgeler.set(r.IND, { ind: Number(r.IND), no: String(r.BELGENO || '').trim(), tarih: r.TARIH, kaynak: Number(r.DEPO), hedef: Number(r.HAREKETDEPOSU), kalemler: [] });
    belgeler.get(r.IND).kalemler.push({ stokno: String(r.STOKNO), miktar: Number(r.MIKTAR) });
  }
  const havuz = new Map();
  for (const r of hav.recordset) {
    const k = `${r.KAYNAK}|${r.HEDEF}|${r.STOKNO}`;
    if (!havuz.has(k)) havuz.set(k, { kaynak: Number(r.KAYNAK), hedef: Number(r.HEDEF), stokno: String(r.STOKNO), gonderilen: 0, alinan: 0 });
    havuz.get(k)[r.BELGETIPI === 128 ? 'gonderilen' : 'alinan'] += Number(r.Q);
  }
  return { sevkler: [...belgeler.values()], havuz: [...havuz.values()] };
}

module.exports = { transferYaz, transferGeriAl, transferOku, kullanilanDepolar, dene, firmalar, donemler, depolar, donemCoz, hazirMi, goruntu, stokTani, BELGE_TURU, anlikStok, sayimYaz, sayimGeriAl, fisVarsayilanlari, PASIF_AD, kartAlanUzunluk, kartAlanYaz, kapat, oleTarih };
