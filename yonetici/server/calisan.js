// Çalışan bazlı rapor (prim için): hangi kullanıcı hangi işte ne kadar iş yapmış. Kaynak raf hareketleri
// (movement) ve rafsız geçen transfer satırları; satırlar index.js'te toplanır, burada özetlenir ve Excel'e yazılır.
const ExcelJS = require('exceljs');

/** Rapora giren hareket türleri (sırayla kolon olur). Sistem düzeltmeleri, Excel içe aktarma, bekleme deposu geçişi girmez. */
const TURLER = [
  ['PUTAWAY', 'Rafa kaldırma'],
  ['PICK', 'Raftan alma'],
  ['TRANSFER_OUT', 'Raftan rafa (çıkış)'],
  ['TRANSFER_OUT_DEPO', 'Depoya gönderim'],
  ['TRANSFER_IN_DEPO', 'Gönderim kabulü'],
  ['COUNT', 'Sayım'],
  ['ARRANGE', 'Raf düzenleme'],
  ['PUTAWAY_GERI', 'Geri alınan rafa kaldırma'],
];
const TUR_AD = new Map(TURLER);
const yuvarla = (x) => Math.round(Number(x) * 100) / 100;
const gunStr = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** satirlar: { user, kind, product_id, delta, ts } */
function ozetle(satirlar) {
  const kisi = new Map();
  const gunluk = new Map();
  for (const s of satirlar) {
    if (!s.user || !TUR_AD.has(s.kind)) continue;
    // Raftan rafa transferin giriş yarısı aynı işin ikinci satırıdır; çıkış sayılır.
    const adet = Math.abs(s.delta || 0);
    let k = kisi.get(s.user);
    if (!k) {
      k = { user: s.user, satir: 0, adet: 0, gunler: new Set(), urunler: new Set(), ilk: s.ts, son: s.ts, turler: {} };
      kisi.set(s.user, k);
    }
    const t = (k.turler[s.kind] ||= { satir: 0, adet: 0, urunler: new Set() });
    t.satir += 1;
    t.adet += adet;
    t.urunler.add(String(s.product_id));
    // Geri alma işlemi toplam iş sayılmaz (yanlış işin telafisi).
    if (s.kind !== 'PUTAWAY_GERI') {
      k.satir += 1;
      k.adet += adet;
      k.urunler.add(String(s.product_id));
    }
    k.gunler.add(gunStr(s.ts));
    k.ilk = Math.min(k.ilk, s.ts);
    k.son = Math.max(k.son, s.ts);
    const gk = `${gunStr(s.ts)}|${s.user}|${s.kind}`;
    const g = gunluk.get(gk) || { gun: gunStr(s.ts), user: s.user, kind: s.kind, satir: 0, adet: 0 };
    g.satir += 1;
    g.adet += adet;
    gunluk.set(gk, g);
  }
  const calisanlar = [...kisi.values()]
    .map((k) => ({
      user: k.user,
      satir: k.satir,
      adet: yuvarla(k.adet),
      urun: k.urunler.size,
      aktifGun: k.gunler.size,
      ilk: k.ilk,
      son: k.son,
      turler: Object.fromEntries(Object.entries(k.turler).map(([kind, t]) => [kind, { satir: t.satir, adet: yuvarla(t.adet), urun: t.urunler.size }])),
    }))
    .sort((a, b) => b.satir - a.satir || (a.user < b.user ? -1 : 1));
  return {
    turler: TURLER.map(([kind, ad]) => ({ kind, ad })),
    calisanlar,
    gunluk: [...gunluk.values()].map((g) => ({ ...g, adet: yuvarla(g.adet) })).sort((a, b) => (a.gun < b.gun ? 1 : a.gun > b.gun ? -1 : a.user < b.user ? -1 : 1)),
  };
}

const tarihSaat = (ts) => (ts ? new Date(ts).toLocaleString('tr-TR') : '');

async function excel(rapor, { bas, bit, depoAd }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ortaş Depo Yönetici';
  const baslikStili = (satir) => {
    satir.font = { bold: true };
    satir.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  };

  const ozet = wb.addWorksheet('Çalışan özeti');
  ozet.addRow([`Çalışan raporu · ${bas || '—'} / ${bit || '—'}${depoAd ? ` · ${depoAd}` : ''}`]).font = { bold: true, size: 13 };
  ozet.addRow([]);
  const b = ozet.addRow(['Çalışan', 'İş satırı', 'Toplam adet', 'Farklı ürün', 'Aktif gün', 'İlk işlem', 'Son işlem',
    ...rapor.turler.flatMap((t) => [`${t.ad} (satır)`, `${t.ad} (adet)`])]);
  baslikStili(b);
  for (const c of rapor.calisanlar) {
    ozet.addRow([c.user, c.satir, c.adet, c.urun, c.aktifGun, tarihSaat(c.ilk), tarihSaat(c.son),
      ...rapor.turler.flatMap((t) => [c.turler[t.kind]?.satir || 0, c.turler[t.kind]?.adet || 0])]);
  }
  ozet.columns.forEach((col, i) => { col.width = i === 0 ? 18 : i < 7 ? 14 : 16; });
  ozet.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];

  const gun = wb.addWorksheet('Günlük döküm');
  baslikStili(gun.addRow(['Gün', 'Çalışan', 'İş türü', 'Satır', 'Adet']));
  for (const g of rapor.gunluk) gun.addRow([g.gun, g.user, TUR_AD.get(g.kind) || g.kind, g.satir, g.adet]);
  gun.columns.forEach((col, i) => { col.width = [12, 18, 26, 10, 12][i]; });
  gun.autoFilter = { from: 'A1', to: 'E1' };
  gun.views = [{ state: 'frozen', ySplit: 1 }];

  return wb.xlsx.writeBuffer();
}

module.exports = { ozetle, excel, TURLER };
