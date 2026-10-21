// Terminal APK'sını kurulum paketine koyar: ../cikti/OrtasDepo-<sürüm>.apk → apk/ + apk.json.
// Sürüm android/app/build.gradle.kts'ten okunur; APK önce derlenmiş olmalı (android/README.md).
const fs = require('fs');
const path = require('path');

const kok = path.join(__dirname, '..', '..');
const gradle = fs.readFileSync(path.join(kok, 'android', 'app', 'build.gradle.kts'), 'utf8');
const versionName = /versionName\s*=\s*"([^"]+)"/.exec(gradle)[1];
const versionCode = Number(/versionCode\s*=\s*(\d+)/.exec(gradle)[1]);
const file = `OrtasDepo-${versionName}.apk`;
const kaynak = path.join(kok, 'cikti', file);
if (!fs.existsSync(kaynak)) {
  console.error(`APK yok: ${kaynak}\nÖnce: cd android && gradlew assembleRelease, sonra APK'yı cikti/ klasörüne kopyalayın.`);
  process.exit(1);
}
const hedef = path.join(__dirname, '..', 'apk');
fs.rmSync(hedef, { recursive: true, force: true });
fs.mkdirSync(hedef, { recursive: true });
fs.copyFileSync(kaynak, path.join(hedef, file));
fs.writeFileSync(path.join(hedef, 'apk.json'), JSON.stringify({ versionName, versionCode, file }, null, 2));
console.log(`apk/ hazır: ${file} (versionCode ${versionCode})`);
