// Android 7.1 ve öncesi için terminal uygulamasının PNG simgesi (8+ adaptive simgeyi kullanır).
// Depo sarısı yuvarlak kare üstünde Reicon newicons/scan-barcode (ic_launcher_fg.xml ile aynı).
// Çalıştırma: node scripts/electron-calistir.js scripts/android-simge.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const IKON =
  '<path d="M2 9V6.5C2 4.01 4.01 2 6.5 2H9"/><path d="M15 2H17.5C19.99 2 22 4.01 22 6.5V9"/><path d="M22 16V17.5C22 19.99 19.99 22 17.5 22H16"/>' +
  '<path d="M9 22H6.5C4.01 22 2 19.99 2 17.5V15"/><path d="M10.5 7V9C10.5 10 10 10.5 9 10.5H7C6 10.5 5.5 10 5.5 9V7C5.5 6 6 5.5 7 5.5H9C10 5.5 10.5 6 10.5 7Z"/>' +
  '<path d="M18.5 7V9C18.5 10 18 10.5 17 10.5H15C14 10.5 13.5 10 13.5 9V7C13.5 6 14 5.5 15 5.5H17C18 5.5 18.5 6 18.5 7Z"/>' +
  '<path d="M10.5 15V17C10.5 18 10 18.5 9 18.5H7C6 18.5 5.5 18 5.5 17V15C5.5 14 6 13.5 7 13.5H9C10 13.5 10.5 14 10.5 15Z"/>' +
  '<path d="M18.5 15V17C18.5 18 18 18.5 17 18.5H15C14 18.5 13.5 18 13.5 17V15C13.5 14 14 13.5 15 13.5H17C18 13.5 18.5 14 18.5 15Z"/>';

function svg(n) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 ${n} ${n}">
    <rect x="${n * 0.04}" y="${n * 0.04}" width="${n * 0.92}" height="${n * 0.92}" rx="${n * 0.2}" fill="#F2B705"/>
    <g transform="translate(${n * 0.22} ${n * 0.22}) scale(${(n * 0.56) / 24})" fill="none" stroke="#1B2430" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${IKON}</g></svg>`;
}

const BOYUT = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html;charset=utf-8,<body></body>');
  const res = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'res');
  for (const [dpi, n] of Object.entries(BOYUT)) {
    const url = await win.webContents.executeJavaScript(`new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${n};
        c.getContext('2d').drawImage(img, 0, 0, ${n}, ${n}); ok(c.toDataURL('image/png')); };
      img.onerror = () => no('svg');
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg(n)).toString('base64'))};
    })`);
    const dir = path.join(res, `mipmap-${dpi}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), Buffer.from(url.split(',')[1], 'base64'));
  }
  console.log('android simgeleri yazıldı');
  app.quit();
});
