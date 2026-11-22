// İsimle arama: Türkçe harf sadeleştirme + kelime kelime yazım hatasına dayanıklı eşleşme.
// Terminaldeki android/.../data/Fuzzy.kt ile aynı kurallar; birini değiştiren ikisini de değiştirsin.
const HARF = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

function norm(s) {
  return String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]/g, (c) => HARF[c])
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(q) {
  return norm(q).split(' ').filter(Boolean);
}

// Levenshtein tamponları her çağrıda yeniden ayrılmaz (125 bin üründe milyonlarca çağrı).
let tamponA = new Int32Array(64);
let tamponB = new Int32Array(64);

function similarity(a, b) {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  if (m + 1 > tamponA.length) {
    tamponA = new Int32Array(m + 33);
    tamponB = new Int32Array(m + 33);
  }
  let prev = tamponA;
  let cur = tamponB;
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const x = prev[j] + 1;
      const y = cur[j - 1] + 1;
      const z = prev[j - 1] + (ai === b.charCodeAt(j - 1) ? 0 : 1);
      cur[j] = x < y ? (x < z ? x : z) : y < z ? y : z;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return 1 - prev[m] / Math.max(n, m);
}

/**
 * Kelimedeki harflerin bit maskesi (a-z: 26 bit, rakamlar kalan 6 bite sıkışır). Yazım hatasına dayanıklı eşleşmede ön eleme:
 * aranan kelimenin harflerinden k'dan fazlası üründeki kelimede hiç yoksa benzerlik 0,7'ye ulaşamaz (her eksik harf en az bir
 * düzeltme ister); pahalı karşılaştırma yapılmaz. Sonuç değişmez, yalnız hızlanır.
 */
function maske(w) {
  let m = 0;
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    if (c >= 97 && c <= 122) m |= 1 << (c - 97);
    else if (c >= 48 && c <= 57) m |= 1 << (26 + ((c - 48) % 6));
  }
  return m;
}

function bitSay(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Ürün için önceden hesaplanan arama alanları. */
function kayit(p) {
  const nCode = norm(p.code);
  const nName = norm(p.name);
  const words = [...new Set([...nName.split(' '), ...nCode.split(' ')].filter(Boolean))];
  return { nCode, nCodeCompact: nCode.replace(/ /g, ''), nName, words, maskeler: words.map(maske) };
}

/** 0 = eşleşmedi; büyük olan daha iyi. */
function puan(qt, compact, e) {
  if (!qt.length) return 0;
  if (compact && e.nCodeCompact === compact) return 100;
  let toplam = 0;
  let eksik = 0;
  for (const t of qt) {
    let s = 0;
    if (e.nCodeCompact.startsWith(t)) s = 4;
    else if (e.words.some((w) => w.startsWith(t))) s = 3;
    else if (e.nName.includes(t) || e.nCode.includes(t)) s = 2;
    else if (t.length >= 3) {
      let best = 0;
      const mt = maske(t);
      for (let i = 0; i < e.words.length; i++) {
        const w = e.words[i];
        if (Math.abs(w.length - t.length) > 3 && w.length < t.length) continue;
        // Ön eleme (bkz. maske): 0,7 benzerlik için en çok 0,3 × uzun kelime kadar düzeltme olabilir.
        if (e.maskeler && bitSay(mt & ~e.maskeler[i]) > Math.floor(0.3 * Math.max(t.length, w.length) + 1e-9)) continue;
        best = Math.max(best, similarity(t, w), similarity(t, w.slice(0, t.length + 1)), similarity(t, w.slice(0, t.length)));
        if (best >= 0.99) break;
      }
      if (best >= 0.7) s = best * 2;
    }
    if (!s) eksik++;
    toplam += s;
  }
  if (eksik * 2 > qt.length) return 0;
  return toplam / qt.length - eksik * 0.8;
}

module.exports = { norm, tokens, similarity, kayit, puan, maske };
