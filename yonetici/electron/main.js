// Ortaş Depo Yönetici — Electron kabuğu.
// Sunucu (terminallerin bağlandığı) aynı süreçte, ayardaki portta (5480) ağa açık çalışır.
// Pencere kapanınca program saat yanında (tepsi) çalışmaya devam eder; terminaller sunucusuz kalmasın.
const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AD = 'Ortaş Depo Yönetici';
app.setAppUserModelId('tr.arcteknik.depo.yonetici');
if (!process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(app.getPath('appData'), 'ortas-depo-yonetici'));
}

let win = null;
let tray = null;
let port = null;
let cikiyor = false;
let sunucu = null;
const gizliBasla = process.argv.includes('--gizli');

function adresMetni() {
  const ip = sunucu ? sunucu.adresler()[0]?.ip : null;
  return ip ? `http://${ip}:${port}` : `port ${port}`;
}

function pencereAc() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    title: AD,
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#eef0ec',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  const adres = `http://127.0.0.1:${port}`;
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(adres)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.on('close', (e) => {
    if (cikiyor) return;
    e.preventDefault();
    win.hide();
    if (!fs.existsSync(path.join(app.getPath('userData'), '.tepsi-bildirildi'))) {
      fs.writeFileSync(path.join(app.getPath('userData'), '.tepsi-bildirildi'), '1');
      if (Notification.isSupported()) {
        new Notification({ title: AD, body: 'Program saat yanında çalışmaya devam ediyor. Terminaller bağlı kalır. Kapatmak için simgeye sağ tıklayın › Çıkış.', icon: path.join(__dirname, 'icon.png') }).show();
      }
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadURL(adres);
}

function tepsiKur() {
  tray = new Tray(path.join(__dirname, 'tray.png'));
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Aç', click: pencereAc },
      { label: `Terminal adresi: ${adresMetni()}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Çıkış (terminaller bağlanamaz)',
        click: async () => {
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            title: AD,
            message: 'Program kapatılsın mı?',
            detail: 'Kapanınca el terminalleri sunucuya bağlanamaz; işlemler terminalde birikir ve program açılınca gönderilir.',
            buttons: ['Kapat', 'Vazgeç'],
            defaultId: 1,
            cancelId: 1,
          });
          if (response === 0) {
            cikiyor = true;
            app.quit();
          }
        },
      },
    ]);
  tray.setToolTip(`${AD} — sunucu çalışıyor`);
  tray.setContextMenu(menu());
  tray.on('click', pencereAc);
  setInterval(() => tray && tray.setContextMenu(menu()), 60 * 1000);
}

/** HTML'i gizli pencerede açar; iş bitince pencere ve geçici dosya silinir. */
async function gizliSayfa(html, is) {
  const gecici = path.join(os.tmpdir(), `ortas-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.html`);
  fs.writeFileSync(gecici, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await w.loadFile(gecici);
    // Yazı tipi ve SVG'ler otursun.
    await w.webContents.executeJavaScript('document.fonts.ready.then(() => true)').catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    return await is(w);
  } finally {
    w.destroy();
    fs.unlink(gecici, () => {});
  }
}

/** Etiketleri PDF olarak Belgeler\Ortaş Depo'ya yazar ve varsayılan görüntüleyicide açar. */
async function pdfAc(html, ayar = {}) {
  return gizliSayfa(html, async (w) => {
    const pdf = await w.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { marginType: 'none' } });
    const klasor = path.join(app.getPath('documents'), 'Ortaş Depo');
    fs.mkdirSync(klasor, { recursive: true });
    const dosya = path.join(klasor, `${String(ayar.ad || 'etiket').replace(/[^\w.-]+/g, '-')}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}.pdf`);
    fs.writeFileSync(dosya, pdf);
    const hata = await shell.openPath(dosya);
    if (hata) throw new Error(hata);
    return dosya;
  });
}

/**
 * Etiketi yazıcıya sessiz gönderir (Windows sürücüsü). Kâğıt boyutu etiket boyutu (mm → mikron).
 * Yazıcı adı boşsa Windows varsayılanı.
 */
async function sessizYazdir(html, sayfaMm, { yazici = '' } = {}) {
  return gizliSayfa(html, (w) =>
    new Promise((ok, no) => {
      w.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: yazici || undefined,
          margins: { marginType: 'none' },
          pageSize: { width: Math.round(sayfaMm.w * 1000), height: Math.round(sayfaMm.h * 1000) },
        },
        (basari, neden) => (basari ? ok(true) : no(new Error(`Yazdırılamadı: ${neden || 'yazıcı yanıt vermedi'}`))),
      );
    }),
  );
}

async function yazicilar() {
  // Pencere kapalıyken (tepside) de liste alınabilsin.
  const acik = win && !win.isDestroyed() ? win : null;
  const w = acik || new BrowserWindow({ show: false });
  let liste;
  try {
    liste = await w.webContents.getPrintersAsync();
  } finally {
    if (!acik) w.destroy();
  }
  return liste.map((p) => ({ ad: p.name, varsayilan: Boolean(p.isDefault) })).sort((a, b) => Number(b.varsayilan) - Number(a.varsayilan) || a.ad.localeCompare(b.ad, 'tr'));
}

function ipcKur() {
  ipcMain.handle('pdf', (e, html, ayar = {}) => pdfAc(html, ayar));
  ipcMain.handle('acilista-baslat', (e, deger) => {
    if (typeof deger === 'boolean') app.setLoginItemSettings({ openAtLogin: deger, args: ['--gizli'] });
    return app.getLoginItemSettings({ args: ['--gizli'] }).openAtLogin;
  });
  ipcMain.handle('guncelleme-denetle', async () => {
    if (!app.isPackaged) return 'Geliştirme sürümünde güncelleme denetlenmez';
    const { autoUpdater } = require('electron-updater');
    const r = await autoUpdater.checkForUpdates();
    const yeni = r && r.updateInfo && r.updateInfo.version;
    return yeni && yeni !== app.getVersion() ? `Yeni sürüm ${yeni} iniyor; hazır olunca sorulacak` : `Güncel (${app.getVersion()})`;
  });
}

// GitHub Releases'tan otomatik güncelleme (public depo; token gerekmez). İndirilen sürüm çıkışta kurulur.
function guncellemeKur() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', async (bilgi) => {
    console.log(`[güncelleme] ${bilgi.version} indi`);
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'info',
      title: AD,
      message: `Yeni sürüm ${bilgi.version} indirildi.`,
      detail: 'Şimdi kurulsun mu? Kurulum yarım dakika sürer; o sırada terminaller bekler. "Sonra" derseniz program kapanırken kurulur.',
      buttons: ['Şimdi kur', 'Sonra'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      cikiyor = true;
      autoUpdater.quitAndInstall(true, true);
    }
  });
  autoUpdater.on('error', (e) => console.warn('[güncelleme]', e && e.message));
  const denetle = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(denetle, 30 * 1000);
  setInterval(denetle, 6 * 60 * 60 * 1000);
}

async function baslat() {
  sunucu = require('../server/index.js');
  const veri = app.getPath('userData');
  try {
    port = await sunucu.baslat({
      veriKlasoru: veri,
      apkKlasoru: app.isPackaged ? path.join(process.resourcesPath, 'apk') : path.join(__dirname, '..', 'apk'),
      arayuz: path.join(__dirname, '..', 'client', 'dist'),
    });
  } catch (e) {
    const mesaj = e.code === 'EADDRINUSE'
      ? `Port kullanımda (${e.port || ''}). Program zaten açık olabilir (saat yanındaki simgeye bakın) ya da başka bir program bu portu kullanıyor.`
      : e.message;
    dialog.showErrorBox(AD, `Sunucu başlatılamadı:\n${mesaj}`);
    cikiyor = true;
    app.quit();
    return;
  }
  sunucu.masaustuBagla({
    klasorAc: async (dizin) => {
      const hata = await shell.openPath(dizin);
      if (hata) throw new Error(hata);
    },
    pdf: pdfAc,
    yazdir: sessizYazdir,
    yazicilar,
  });
  // İlk açılışta Windows açılınca başlamayı açar (sunucu hep çalışmalı); kullanıcı Ayarlar'dan kapatabilir.
  const ilk = path.join(veri, '.ilk-acilis');
  if (app.isPackaged && !fs.existsSync(ilk)) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--gizli'] });
    fs.writeFileSync(ilk, new Date().toISOString());
  }
  ipcKur();
  tepsiKur();
  if (!gizliBasla) pencereAc();
  guncellemeKur();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', pencereAc);
  process.on('uncaughtException', (e) => console.error('Yakalanmamış hata:', e));
  process.on('unhandledRejection', (e) => console.error('Yakalanmamış söz hatası:', e));
  app.whenReady().then(baslat);
  // Pencere kapanınca çıkılmaz; tepsiden "Çıkış" ile kapanır.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    cikiyor = true;
  });
  app.on('will-quit', (e) => {
    if (sunucu && !app.__durdu) {
      e.preventDefault();
      app.__durdu = true;
      sunucu.durdur().finally(() => app.quit());
    }
  });
}
