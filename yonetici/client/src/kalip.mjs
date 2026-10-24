// Toplu raf oluşturmada kalıptan raf kodları. Saf modül: test/kalip.test.js de kullanır.

// Sunucudaki RAF_DESEN ile aynı (server/depo.js); uymayan kod gönderilirse sunucu bütün grubu reddeder.
export const RAF_DESEN = /^[A-Z0-9ÇĞİÖŞÜ][A-Z0-9ÇĞİÖŞÜ\-./ ]{0,23}$/;

/**
 * Köşeli parantez içi aralık ya da liste, gerisi olduğu gibi. En çok [sinir] kod.
 * "TK[1-3]-H[1-2]" → TK1-H1, TK1-H2, TK2-H1 … · "KAT-[1-3]-[A-C][1-9]-[01-80]" · "[01-12]" iki haneli.
 * Büyütme dilden bağımsız (terminal Kotlin uppercase() ile büyütür; sunucu da öyle).
 */
export function kaliptan(kalip, sinir = 5001) {
  const u = String(kalip || '').toUpperCase();
  const parcalar = [];
  let i = 0;
  for (const m of u.matchAll(/\[([^\]]*)\]/g)) {
    parcalar.push([u.slice(i, m.index)]);
    const secenek = [];
    for (const p of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      const sayi = /^(\d+)\s*-\s*(\d+)$/.exec(p);
      const harf = /^([A-Z])\s*-\s*([A-Z])$/.exec(p);
      if (sayi) {
        const hane = sayi[1].length > 1 && sayi[1].startsWith('0') ? sayi[1].length : 1;
        for (let n = Number(sayi[1]); n <= Number(sayi[2]) && secenek.length < sinir; n++) secenek.push(String(n).padStart(hane, '0'));
      } else if (harf) {
        for (let c = harf[1].charCodeAt(0); c <= harf[2].charCodeAt(0); c++) secenek.push(String.fromCharCode(c));
      } else secenek.push(p);
    }
    parcalar.push(secenek);
    i = m.index + m[0].length;
  }
  parcalar.push([u.slice(i)]);
  let out = [''];
  for (const s of parcalar) {
    if (!s.length) return [];
    out = out.flatMap((o) => s.map((x) => o + x));
    if (out.length > sinir) {
      out = out.slice(0, sinir);
      break;
    }
  }
  return [...new Set(out.map((x) => x.trim()).filter(Boolean))];
}
