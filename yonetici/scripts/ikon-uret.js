// Program simgesini üretir: lacivert zemin üstünde Reicon tools/layers (depo sarısı).
// Electron ile çalışır: node scripts/electron-calistir.js scripts/ikon-uret.js
// Çıktı: electron/icon.png (256), electron/icon.ico (16-256), electron/tray.png (32)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const icData = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'iconData.js'), 'utf8');
const ICONS = JSON.parse(icData.slice(icData.indexOf('{'), icData.lastIndexOf('}') + 1));
const layers = ICONS.layers.replace(/currentColor/g, '#F2B705');

function svg(boyut) {
  const r = Math.round(boyut * 0.22);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${boyut}" height="${boyut}" viewBox="0 0 ${boyut} ${boyut}">
    <rect width="${boyut}" height="${boyut}" rx="${r}" fill="#1B2430"/>
    <g transform="translate(${boyut * 0.16} ${boyut * 0.16}) scale(${(boyut * 0.68) / 24})">${layers}</g></svg>`;
}

function ico(pngler) {
  // ICO: PNG gömülü girdiler (Vista+).
  const baslik = Buffer.alloc(6);
  baslik.writeUInt16LE(0, 0);
  baslik.writeUInt16LE(1, 2);
  baslik.writeUInt16LE(pngler.length, 4);
  const girdiler = [];
  let ofset = 6 + 16 * pngler.length;
  for (const { boyut, veri } of pngler) {
    const g = Buffer.alloc(16);
    g.writeUInt8(boyut >= 256 ? 0 : boyut, 0);
    g.writeUInt8(boyut >= 256 ? 0 : boyut, 1);
    g.writeUInt16LE(1, 4);
    g.writeUInt16LE(32, 6);
    g.writeUInt32LE(veri.length, 8);
    g.writeUInt32LE(ofset, 12);
    ofset += veri.length;
    girdiler.push(g);
  }
  return Buffer.concat([baslik, ...girdiler, ...pngler.map((p) => p.veri)]);
}

app.whenReady().then(async () => {
  // SVG sayfadaki tuvale çizilip PNG alınır (gizli pencerede ekran görüntüsü alınamıyor).
  const win = new BrowserWindow({ show: false, width: 300, height: 300 });
  await win.loadURL('data:text/html;charset=utf-8,<body></body>');
  const pngler = [];
  for (const boyut of [256, 64, 48, 32, 16]) {
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${boyut};
        c.getContext('2d').drawImage(img, 0, 0, ${boyut}, ${boyut}); ok(c.toDataURL('image/png')); };
      img.onerror = () => no('svg yüklenmedi');
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg(boyut)).toString('base64'))};
    })`);
    pngler.push({ boyut, veri: Buffer.from(dataUrl.split(',')[1], 'base64') });
  }
  const hedef = path.join(__dirname, '..', 'electron');
  fs.writeFileSync(path.join(hedef, 'icon.png'), pngler[0].veri);
  fs.writeFileSync(path.join(hedef, 'tray.png'), pngler.find((p) => p.boyut === 32).veri);
  fs.writeFileSync(path.join(hedef, 'icon.ico'), ico(pngler));
  fs.writeFileSync(path.join(hedef, 'icon.svg'), svg(256));
  console.log('simgeler yazıldı');
  app.quit();
});
