// Excel / CSV'den raf içe aktarma. Ortaş'ın B2B'sinde depo ve raf adları var, Vega'da yok.
// Sütunlar: Depo, Raf (zorunlu) · Bölge, Not, Ürün (kod ya da barkod), Miktar (isteğe bağlı).
//   Raf hücresinde birden çok raf olabilir (B2B "Raf Adresi": ".;TK2-H1"); ; , | ayırır, uygun olmayan parça atlanır.
//   Depo "hepsi": raf ve zimmet kullanılan bütün depolara yazılır (B2B'de depo yok, Vega'da raf depoya bağlı).
//   Ürün + miktar → o rafa o miktar yazılır (ilk yerleşim, hareket türü IMPORT).
//   Ürün, miktarsız → ürünün asıl rafı (rafa kaldırırken terminal önerir).
const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const db = require('./db');
const depo = require('./depo');
const fuzzy = require('./fuzzy');

const ALANLAR = {
  depo: ['depo', 'depo adı', 'depo adi', 'ambar', 'şube', 'sube', 'warehouse'],
  raf: ['raf', 'raf kodu', 'raf adı', 'raf adi', 'lokasyon', 'konum', 'adres', 'göz', 'goz', 'shelf', 'location'],
  bolge: ['bölge', 'bolge', 'koridor', 'zone', 'alan'],
  not: ['not', 'açıklama', 'aciklama', 'note'],
  urun: ['ürün', 'urun', 'ürün kodu', 'urun kodu', 'stok kodu', 'stokkodu', 'kod', 'barkod', 'barcode', 'sku'],
  miktar: ['miktar', 'adet', 'stok', 'qty', 'quantity'],
};

function hucre(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((x) => x.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

function csvOku(metin) {
  const satirlar = metin.replace(/^﻿/, '').split(/\r?\n/).filter((s) => s.trim());
  const ayrac = (satirlar[0].match(/;/g) || []).length >= (satirlar[0].match(/,/g) || []).length ? ';' : ',';
  return satirlar.map((s) => {
    const out = [];
    let cur = '';
    let tirnak = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        if (tirnak && s[i + 1] === '"') {
          cur += '"';
          i++;
        } else tirnak = !tirnak;
      } else if (c === ayrac && !tirnak) {
        out.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  });
}

/** Dosyayı okur: ilk sayfa, ilk dolu satır başlık. Dönen: { basliklar, satirlar (dizi dizisi) }. */
async function oku(ad, buf) {
  let tablo;
  if (/\.csv$|\.txt$/i.test(ad)) {
    tablo = csvOku(buf.toString('utf8'));
  } else {
    // Akışla okunur: 130 bin satırlık B2B listesi tümüyle yüklenince 1,4 GB bellek tutuyordu.
    // İlk dolu sayfa alınır.
    const wb = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buf]), { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit' });
    let sayfa = false;
    for await (const ws of wb) {
      sayfa = true;
      const t = [];
      for await (const row of ws) {
        const v = [];
        for (let i = 1; i <= row.cellCount; i++) v.push(hucre(row.getCell(i).value));
        if (v.some((x) => x !== '')) t.push(v);
      }
      if (t.length) {
        tablo = t;
        break;
      }
    }
    if (!sayfa) throw Object.assign(new Error('Excel dosyasında sayfa yok'), { status: 400 });
    tablo = tablo || [];
  }
  tablo = tablo.filter((r) => r.some((x) => x !== ''));
  if (tablo.length < 2) throw Object.assign(new Error('Dosyada başlık satırı ve en az bir veri satırı olmalı'), { status: 400 });
  const basliklar = tablo[0].map((b, i) => b || `Sütun ${i + 1}`);
  const satirlar = tablo.slice(1).map((r) => basliklar.map((_, i) => r[i] ?? ''));
  return { basliklar, satirlar };
}

/** Başlıklardan sütun eşleşmesi tahmini: { depo: 0, raf: 1, ... } (bulunamayan alan yok). */
function tahminEt(basliklar) {
  const n = basliklar.map((b) => fuzzy.norm(b));
  const out = {};
  for (const [alan, adlar] of Object.entries(ALANLAR)) {
    const hedefler = adlar.map(fuzzy.norm);
    let i = n.findIndex((b) => hedefler.includes(b));
    if (i < 0) i = n.findIndex((b) => hedefler.some((h) => h.length > 2 && b.includes(h)));
    if (i >= 0 && !Object.values(out).includes(i)) out[alan] = i;
  }
  return out;
}

/** Dosyadaki depo adını Vega deposuna eşler (numara, kod ya da ad; Türkçe harf/büyük-küçük farkı yok sayılır). */
function depoEsle(deger, liste) {
  const s = String(deger || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s) && liste.some((d) => d.ind === Number(s))) return Number(s);
  const n = fuzzy.norm(s);
  const tam = liste.find((d) => fuzzy.norm(d.ad) === n);
  if (tam) return tam.ind;
  const icerir = liste.filter((d) => fuzzy.norm(d.ad).includes(n) || n.includes(fuzzy.norm(d.ad)));
  return icerir.length === 1 ? icerir[0].ind : null;
}

function urunEsle(deger) {
  const s = String(deger || '').trim();
  if (!s) return null;
  const g = depo.goruntu();
  if (!g) return null;
  if (!urunEsle.kod || urunEsle.surum !== g.at) {
    urunEsle.kod = new Map();
    for (const p of g.products) urunEsle.kod.set(fuzzy.norm(p.code).replace(/ /g, ''), p.id);
    for (const [id, bcs] of Object.entries(g.barcodes)) for (const b of bcs) urunEsle.kod.set(b, id);
    urunEsle.surum = g.at;
  }
  return urunEsle.kod.get(s) || urunEsle.kod.get(fuzzy.norm(s).replace(/ /g, '')) || null;
}

function sayiOku(x) {
  const s = String(x || '').trim().replace(/\s/g, '');
  if (!s) return null;
  // 1.234,5 → 1234.5 · 1234,5 → 1234.5 · 1234.5 → 1234.5
  const n = Number(/,\d+$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

const HEPSI = 'hepsi';

/** Depo seçimi → depo numaraları. "hepsi" kullanılan bütün depolar; boş ya da geçersiz → null. */
function hedefDepolar(deger, liste) {
  if (deger === HEPSI) return liste.map((d) => d.ind);
  if (deger === null || deger === undefined || deger === '') return null;
  const d = Number(deger);
  return Number.isInteger(d) ? [d] : null;
}

/**
 * Eşleşmeye göre satırları çözer. `eslesme`: alan → sütun no; `depoEslesme`: dosyadaki depo değeri → Vega depo no
 * ya da "hepsi"; `sabitDepo`: depo sütunu yoksa hepsi bu depoya ("hepsi": bütün depolara).
 * Dönen `satirlar` depo × raf başına bir kayıt; bir dosya satırı birden çok kayıt verebilir.
 */
function coz({ satirlar, eslesme, depoEslesme = {}, sabitDepo = null }) {
  const liste = depo.depolar();
  const al = (r, alan) => (eslesme[alan] === undefined || eslesme[alan] === null || eslesme[alan] === '' ? '' : String(r[Number(eslesme[alan])] ?? '').trim());
  const sonuc = [];
  const depoDegerleri = new Map();
  const hatalar = [];
  satirlar.forEach((r, i) => {
    const satirNo = i + 2;
    const hucreRaf = al(r, 'raf');
    const raflar = depo.adresleriAyir(hucreRaf).filter((c) => depo.rafKoduGecerli(c));
    if (!raflar.length) return hatalar.push({ satir: satirNo, hata: depo.adresleriAyir(hucreRaf).length ? `Raf kodu uygun değil: ${hucreRaf}` : 'Raf boş' });
    let ds = hedefDepolar(sabitDepo, liste);
    const dosyaDepo = al(r, 'depo');
    if (eslesme.depo !== undefined && eslesme.depo !== null && eslesme.depo !== '') {
      const elle = depoEslesme[dosyaDepo];
      ds = elle !== undefined && elle !== '' && elle !== null ? hedefDepolar(elle, liste) : hedefDepolar(depoEsle(dosyaDepo, liste), liste);
      if (!depoDegerleri.has(dosyaDepo)) depoDegerleri.set(dosyaDepo, { deger: dosyaDepo, depo: ds && ds.length === 1 ? ds[0] : ds ? HEPSI : null, satir: 0 });
      depoDegerleri.get(dosyaDepo).satir++;
    }
    if (!ds || !ds.length) return hatalar.push({ satir: satirNo, hata: dosyaDepo ? `Depo eşleşmedi: ${dosyaDepo}` : 'Depo yok' });
    const urunDeger = al(r, 'urun');
    let productId = null;
    if (urunDeger) {
      productId = urunEsle(urunDeger);
      if (!productId) return hatalar.push({ satir: satirNo, hata: `Ürün Vega'da bulunamadı: ${urunDeger}` });
    }
    const mk = al(r, 'miktar');
    const qty = mk === '' ? null : sayiOku(mk);
    if (Number.isNaN(qty) || (qty !== null && qty < 0)) return hatalar.push({ satir: satirNo, hata: `Miktar okunamadı: ${mk}` });
    if (qty !== null && productId && (raflar.length > 1 || ds.length > 1)) {
      return hatalar.push({ satir: satirNo, hata: 'Miktar tek raf ve tek depo için yazılır; bu satırda birden çok raf ya da depo var' });
    }
    for (const d of ds) for (const raf of raflar) sonuc.push({ satir: satirNo, depo: d, raf, bolge: al(r, 'bolge'), not: al(r, 'not'), productId, qty });
  });
  return {
    satirlar: sonuc,
    hatalar,
    depolar: [...depoDegerleri.values()].map((x) => ({ ...x, depoAd: x.depo === HEPSI ? 'Bütün depolar' : x.depo !== null ? depo.depoAdi(x.depo) : null })),
  };
}

/** Önizleme sayıları. */
function ozet(c) {
  const raflar = new Set(c.satirlar.map((s) => `${s.depo}|${s.raf}`));
  const yeniRaf = [...raflar].filter((k) => {
    const [d, r] = k.split('|');
    return !depo.rafVarMi(Number(d), r);
  }).length;
  return {
    satir: new Set(c.satirlar.map((s) => s.satir)).size,
    hata: c.hatalar.length,
    raf: raflar.size,
    yeniRaf,
    miktarli: c.satirlar.filter((s) => s.productId && s.qty !== null).length,
    asilRaf: c.satirlar.filter((s) => s.productId && s.qty === null).length,
  };
}

/** Uygular. `miktarModu`: 'ayarla' (rafı bu miktara çek) ya da 'ekle' (üstüne ekle). */
function uygula(c, { miktarModu = 'ayarla' } = {}) {
  const h = { kind: 'IMPORT', ref: 'Excel içe aktarma', user: 'yönetici', device: 'PC' };
  let raf = 0;
  let miktar = 0;
  let asil = 0;
  db.tx(() => {
    for (const s of c.satirlar) {
      if (!depo.rafVarMi(s.depo, s.raf)) raf++;
      depo.rafEkle(s.depo, s.raf, { zone: s.bolge || undefined, note: s.not || '', source: 'IMPORT' });
      if (s.bolge || s.not) db.run("UPDATE shelf SET zone=CASE WHEN ?<>'' THEN ? ELSE zone END, note=CASE WHEN ?<>'' THEN ? ELSE note END WHERE depo=? AND code=?", s.bolge, s.bolge, s.not, s.not, s.depo, s.raf);
      if (s.productId && s.qty !== null) {
        const yeni = miktarModu === 'ekle' ? depo.miktar(s.depo, s.productId, s.raf) + s.qty : s.qty;
        depo.miktarAyarla(s.depo, s.productId, s.raf, yeni, { ...h, ts: Date.now() });
        miktar++;
      } else if (s.productId) {
        // Ürün birden çok rafa zimmetlenebilir; Excel'deki her satır bir zimmet ekler.
        depo.zimmetEkle(s.depo, s.productId, s.raf, 'IMPORT');
        asil++;
      }
    }
  });
  depo.degisti();
  return { yeniRaf: raf, miktar, asilRaf: asil };
}

/** Boş şablon. */
async function sablon() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Raflar');
  ws.columns = [
    { header: 'Depo', key: 'depo', width: 18 },
    { header: 'Raf', key: 'raf', width: 14 },
    { header: 'Bölge', key: 'bolge', width: 10 },
    { header: 'Not', key: 'not', width: 24 },
    { header: 'Ürün kodu / barkod', key: 'urun', width: 22 },
    { header: 'Miktar', key: 'miktar', width: 10 },
  ];
  const d = depo.depolar()[0]?.ad || 'MERKEZ';
  ws.addRow({ depo: d, raf: 'A-01-01', bolge: 'A', not: '', urun: '', miktar: '' });
  ws.addRow({ depo: d, raf: 'A-01-02', bolge: 'A', not: 'Ağır parça', urun: 'YF-1042', miktar: 12 });
  ws.addRow({ depo: d, raf: 'A-01-03', bolge: 'A', not: '', urun: '8691234500412', miktar: '' });
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { oku, tahminEt, coz, ozet, uygula, sablon, depoEsle, sayiOku, ALANLAR, HEPSI };
