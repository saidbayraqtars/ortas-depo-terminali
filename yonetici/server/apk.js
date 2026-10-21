// Terminal uygulamasının APK'sı programla birlikte gelir; terminaller sunucudan indirir (/apk).
// Klasörde apk.json: {"versionName":"1.0.0","versionCode":2,"file":"OrtasDepo-1.0.0.apk"} (scripts/apk-hazirla.js yazar)
const fs = require('fs');
const path = require('path');

let klasor = null;
let onbellek = undefined;

function kur(dir) {
  klasor = dir;
  onbellek = undefined;
}

function bilgi() {
  if (onbellek !== undefined) return onbellek;
  onbellek = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(klasor, 'apk.json'), 'utf8').replace(/^﻿/, ''));
    const dosya = path.join(klasor, j.file);
    if (fs.existsSync(dosya)) onbellek = { ...j, dosya, boyut: fs.statSync(dosya).size };
  } catch {}
  return onbellek;
}

module.exports = { kur, bilgi };
