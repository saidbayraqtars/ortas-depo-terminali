// Raf sayımının kapsamı: sayılacak rafları seçen önekler ("K1", "KAT-1", "TK2-H"). Terminal (Kapsam.kt) aynı kuralı uygular.
//
// Önek, raf kodunun başıyla eşleşir ve bir sayı ya da harf dizisini bölmez: "K1" → K1, K1-A3, K1A-2; K10 değil.
// "TK2-H" → TK2-H1, TK2-H9 (harften sonra rakam gelir, dizi bölünmez). Sonda "*" varsa düz önek: "K1*" → K10 da.
const DESEN = /^[A-Z0-9ÇĞİÖŞÜ][A-Z0-9ÇĞİÖŞÜ\-./ ]{0,23}\*?$/;
const EN_COK = 20;

function sinif(c) {
  if (c >= '0' && c <= '9') return 1;
  if (/\p{L}/u.test(c)) return 2;
  return 0;
}

/** Virgülle ayrılmış metin ya da dizi → büyük harfli, tekrarsız önek listesi. Uygun olmayan önekte hata. */
function coz(girdi) {
  const parcalar = Array.isArray(girdi) ? girdi : String(girdi || '').split(',');
  const liste = [];
  for (const ham of parcalar) {
    const p = String(ham || '').trim().toLocaleUpperCase('tr-TR');
    if (!p) continue;
    if (!DESEN.test(p)) throw Object.assign(new Error(`Kapsam öneki uygun değil: "${p}"`), { status: 400 });
    if (!liste.includes(p)) liste.push(p);
  }
  if (liste.length > EN_COK) throw Object.assign(new Error(`Kapsamda en çok ${EN_COK} önek olabilir`), { status: 400 });
  return liste;
}

function uyar(kod, onek) {
  if (onek.endsWith('*')) return kod.startsWith(onek.slice(0, -1));
  if (!kod.startsWith(onek)) return false;
  if (kod.length === onek.length) return true;
  const s = sinif(onek[onek.length - 1]);
  return s === 0 || s !== sinif(kod[onek.length]);
}

/** Kapsam boşsa her raf kapsamdadır. */
function kapsamda(kod, onekler) {
  return !onekler.length || onekler.some((o) => uyar(kod, o));
}

module.exports = { coz, kapsamda };
