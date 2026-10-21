// Reicon (MIT, https://github.com/dqev/reicon) icon-data.json'dan arayüzün ikonlarını üretir.
// Kullanım: node scripts/ikonlar.js <icon-data.json yolu>
// Elle ikon çizilmez; yeni ikon gerekiyorsa aşağıdaki listeye Reicon yolunu ekleyip yeniden üretin.
const fs = require('fs');
const path = require('path');

const IKONLAR = {
  home: 'ui/home',
  package: 'ui/package',
  layers: 'tools/layers',
  count: 'notes/clipboard-check',
  history: 'time/history',
  users: 'users/users',
  mobile: 'devices/mobile',
  settings: 'settings/settings',
  search: 'search/search',
  printer: 'devices/printer',
  download: 'arrows-action/download',
  plus: 'ui/plus',
  trash: 'ui/trash',
  refresh: 'arrows/refresh',
  check: 'ui/check',
  x: 'ui/x',
  warning: 'ui/triangle-warning',
  wifiOff: 'ui/wifi-off',
  wifi: 'ui/wifi',
  cloudUpload: 'weather/cloud-upload',
  mapPoint: 'map/map-point',
  transfer: 'arrows/transfer-h',
  edit: 'newicons/edit',
  qr: 'security/qr',
  barcode: 'newicons/scan-barcode',
  logout: 'arrows-action/logout',
  lock: 'security/lock',
  database: 'ui/database',
  export: 'arrows-action/export',
  server: 'devices/server',
  key: 'security/key',
  info: 'ui/info-circle',
  chevronRight: 'arrows/chevron-right',
  chevronLeft: 'arrows/chevron-left',
  chevronDown: 'arrows/chevron-down',
  folder: 'folders/folder-open',
  copy: 'ui/copy',
  calendar: 'time/calendar',
  filter: 'ui/filter',
  alert: 'ui/alert-circle',
  box: 'ui/box',
  truck: 'ui/truck',
  undo: 'arrows-action/refresh2',
};

const kaynak = process.argv[2];
if (!kaynak) {
  console.error('Kullanım: node scripts/ikonlar.js <icon-data.json>');
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(kaynak, 'utf8'));
const out = {};
for (const [ad, yol] of Object.entries(IKONLAR)) {
  const [kat, isim] = yol.split('/');
  const ikon = d.categories[kat]?.icons[isim];
  if (!ikon) throw new Error(`Reicon'da yok: ${yol}`);
  out[ad] = ikon.weights.Outline.code;
}
const metin =
  '// Reicon (MIT) — https://github.com/dqev/reicon · data/icon-data.json, Outline.\n' +
  '// scripts/ikonlar.js üretir; elle ikon çizmeyin.\n' +
  'export const ICONS = ' + JSON.stringify(out, null, 2) + ';\n';
fs.writeFileSync(path.join(__dirname, '..', 'client', 'src', 'iconData.js'), metin, 'utf8');
console.log(Object.keys(out).length + ' ikon yazıldı');
