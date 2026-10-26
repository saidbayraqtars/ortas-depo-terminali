// Son raporları özetler:  node liste.js [adet] [app]
// Bir raporun tamamı: cat /var/lib/hata-toplayici/<app>/<gün>/<dosya>
const fs = require('fs');
const path = require('path');

const KLASOR = process.env.STATE_DIRECTORY || '/var/lib/hata-toplayici';
const adet = Number(process.argv[2] || 20);
const suzgec = process.argv[3];

const dosyalar = [];
for (const app of fs.readdirSync(KLASOR)) {
  if (suzgec && app !== suzgec) continue;
  const ad = path.join(KLASOR, app);
  if (!fs.statSync(ad).isDirectory()) continue;
  for (const gun of fs.readdirSync(ad)) {
    for (const f of fs.readdirSync(path.join(ad, gun))) dosyalar.push(path.join(ad, gun, f));
  }
}
dosyalar.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

for (const p of dosyalar.slice(0, adet)) {
  try {
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ilk = String(r.summary || r.stack || '').split('\n')[0].slice(0, 140);
    console.log(`${r.alindi?.slice(0, 19)}  ${r.kind?.padEnd(8)} ${String(r.device || '').padEnd(14)} ${r.appVersion || ''}  ${ilk}`);
    console.log(`    ${p}`);
  } catch (e) {
    console.log(`?? ${p} ${e.message}`);
  }
}
