// Günlük dosyası: <klasör>/YYYY-MM-DD.log, 60 gün saklanır. Konsola da yazar.
const fs = require('fs');
const path = require('path');

let klasor = null;
const dinleyiciler = [];

function kur(dir) {
  klasor = dir;
  fs.mkdirSync(dir, { recursive: true });
  try {
    const sinir = Date.now() - 60 * 86400000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (f.endsWith('.log') && fs.statSync(p).mtimeMs < sinir) fs.unlinkSync(p);
    }
  } catch {}
}

function yaz(seviye, mesaj, hata) {
  const an = new Date();
  const satir = `${an.toLocaleTimeString('tr-TR')} [${seviye}] ${mesaj}${hata ? ` — ${hata.stack || hata.message || hata}` : ''}`;
  (seviye === 'HATA' ? console.error : console.log)(satir);
  if (seviye === 'HATA') for (const f of dinleyiciler) f(mesaj, hata);
  if (!klasor) return;
  const gun = `${an.getFullYear()}-${String(an.getMonth() + 1).padStart(2, '0')}-${String(an.getDate()).padStart(2, '0')}`;
  try {
    fs.appendFileSync(path.join(klasor, `${gun}.log`), satir + '\n', 'utf8');
  } catch {}
}

module.exports = {
  kur,
  klasor: () => klasor,
  /** HATA satırlarını dinler (rapor.js bunları destek sunucusuna iletir). */
  dinle: (f) => dinleyiciler.push(f),
  bilgi: (m) => yaz('BİLGİ', m),
  uyari: (m) => yaz('UYARI', m),
  hata: (m, e) => yaz('HATA', m, e),
};
