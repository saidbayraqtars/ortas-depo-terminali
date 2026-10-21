// Arayüze yalnız masaüstü işleri açılır: PDF etiket, açılışta başlatma, güncelleme denetimi.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('masaustu', {
  pdf: (html, ayar) => ipcRenderer.invoke('pdf', html, ayar),
  acilistaBaslat: (deger) => ipcRenderer.invoke('acilista-baslat', deger),
  guncellemeDenetle: () => ipcRenderer.invoke('guncelleme-denetle'),
});
