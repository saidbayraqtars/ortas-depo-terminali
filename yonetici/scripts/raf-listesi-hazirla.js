// B2B ürün kartı listesini (Excel: Stok Kodu + RafAdresi1..N sütunları) pakete konacak küçük dosyaya çevirir:
//   ice-aktar/b2b-raf-listesi.tsv  (ürün kodu <TAB> raf;raf;...)  — yalnız rafı olan ürünler, uygun olmayan raf kodları atılır.
// Dosya müşteri verisidir, depoya girmez (.gitignore); `npm run dist` / `release` paketine extraResources ile girer.
// Kullanım: node scripts/raf-listesi-hazirla.js "C:\yol\product_card.xlsx"
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const RAF_DESEN = /^[A-Z0-9ÇĞİÖŞÜ][A-Z0-9ÇĞİÖŞÜ\-./ ]{0,23}$/;
const hucre = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return String(v.richText ? v.richText.map((x) => x.text).join('') : v.text ?? v.result ?? '').trim();
  return String(v).trim();
};

async function main() {
  const girdi = process.argv[2];
  if (!girdi || !fs.existsSync(girdi)) throw new Error('Kullanım: node scripts/raf-listesi-hazirla.js <excel.xlsx>');
  const cikti = path.join(__dirname, '..', 'ice-aktar', 'b2b-raf-listesi.tsv');
  fs.mkdirSync(path.dirname(cikti), { recursive: true });
  const wb = new ExcelJS.stream.xlsx.WorkbookReader(girdi, { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit' });
  const satirlar = [];
  let toplam = 0;
  let rafsiz = 0;
  let atilan = 0;
  for await (const ws of wb) {
    let basliklar = null;
    let kodSutun = 1;
    let rafSutunlar = [];
    for await (const row of ws) {
      if (!basliklar) {
        basliklar = [];
        for (let i = 1; i <= row.cellCount; i++) basliklar.push(hucre(row.getCell(i).value).toLocaleLowerCase('tr'));
        kodSutun = basliklar.findIndex((b) => b === 'stok kodu') + 1;
        rafSutunlar = basliklar.map((b, i) => (/^rafadresi\d*$/.test(b.replace(/\s/g, '')) ? i + 1 : 0)).filter(Boolean);
        if (!kodSutun || !rafSutunlar.length) throw new Error('"Stok Kodu" ve "RafAdresi..." sütunları bulunamadı');
        continue;
      }
      const kod = hucre(row.getCell(kodSutun).value);
      if (!kod) continue;
      toplam++;
      const raflar = new Set();
      for (const c of rafSutunlar) {
        for (const parca of hucre(row.getCell(c).value).split(/[,;|\r\n]+/)) {
          const r = parca.trim().toLocaleUpperCase('tr');
          if (!r) continue;
          if (RAF_DESEN.test(r)) raflar.add(r);
          else atilan++;
        }
      }
      if (!raflar.size) {
        rafsiz++;
        continue;
      }
      satirlar.push(`${kod.replace(/[\t\r\n]/g, ' ')}\t${[...raflar].join(';')}`);
    }
    break;
  }
  fs.writeFileSync(cikti, satirlar.join('\n') + '\n', 'utf8');
  console.log(`${toplam} ürün, ${satirlar.length} tanesinin rafı var (${rafsiz} rafsız), ${atilan} uygun olmayan raf kodu atıldı`);
  console.log(`${cikti} (${(fs.statSync(cikti).size / 1048576).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
