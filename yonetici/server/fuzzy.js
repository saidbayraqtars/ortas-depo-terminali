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

function similarity(a, b) {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let cur = new Array(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[m] / Math.max(n, m);
}

/** Ürün için önceden hesaplanan arama alanları. */
function kayit(p) {
  const nCode = norm(p.code);
  const nName = norm(p.name);
  return { nCode, nCodeCompact: nCode.replace(/ /g, ''), nName, words: [...new Set([...nName.split(' '), ...nCode.split(' ')].filter(Boolean))] };
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
      for (const w of e.words) {
        if (Math.abs(w.length - t.length) > 3 && w.length < t.length) continue;
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

module.exports = { norm, tokens, similarity, kayit, puan };
