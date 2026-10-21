// Raf ve ürün etiketi: HTML + SVG barkod (bwip-js). Aynı HTML önizlemede, PDF'te ve etiket yazıcısında kullanılır.
// Yazdırma Windows yazıcı sürücüsünden (Electron sessiz yazdırma): Zebra, TSC, Argox, Xprinter gibi her etiket
// yazıcısında çalışır; sürücüde kâğıt boyutu etiketle aynı olmalı.
const bwipjs = require('bwip-js');

const BICIM = {
  'y-100x50': { ad: 'Etiket yazıcısı 100×50 mm', sayfa: { w: 100, h: 50 }, w: 100, h: 50, sutun: 1, satir: 1 },
  'y-80x50': { ad: 'Etiket yazıcısı 80×50 mm', sayfa: { w: 80, h: 50 }, w: 80, h: 50, sutun: 1, satir: 1 },
  'y-60x40': { ad: 'Etiket yazıcısı 60×40 mm', sayfa: { w: 60, h: 40 }, w: 60, h: 40, sutun: 1, satir: 1 },
  'y-50x30': { ad: 'Etiket yazıcısı 50×30 mm', sayfa: { w: 50, h: 30 }, w: 50, h: 30, sutun: 1, satir: 1 },
  'y-40x30': { ad: 'Etiket yazıcısı 40×30 mm', sayfa: { w: 40, h: 30 }, w: 40, h: 30, sutun: 1, satir: 1 },
  'a4-3x8': { ad: 'A4 · 3×8 etiket (70×37 mm)', sayfa: { w: 210, h: 297 }, w: 70, h: 37, sutun: 3, satir: 8, ust: 0, sol: 0 },
  'a4-2x5': { ad: 'A4 · 2×5 etiket (105×57 mm)', sayfa: { w: 210, h: 297 }, w: 105, h: 57, sutun: 2, satir: 5, ust: 6, sol: 0 },
  'a4-1x4': { ad: 'A4 · 4 büyük etiket (190×70 mm)', sayfa: { w: 210, h: 297 }, w: 190, h: 70, sutun: 1, satir: 4, ust: 8, sol: 10 },
};

function kac(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function eanGecerli(kod) {
  if (!/^\d{8}$|^\d{13}$/.test(kod)) return false;
  const d = kod.split('').map(Number);
  const kontrol = d.pop();
  const t = d.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (t % 10)) % 10 === kontrol;
}

/** Barkod SVG'si. Geçerli EAN-13/EAN-8 öyle basılır (perakende okuyucular tanısın), gerisi Code 128. */
function barkod(kod, { yazili = false } = {}) {
  const k = String(kod || '').trim();
  const bcid = eanGecerli(k) ? (k.length === 13 ? 'ean13' : 'ean8') : 'code128';
  try {
    return bwipjs.toSVG({ bcid, text: k, height: 12, includetext: yazili && bcid !== 'code128', textxalign: 'center', paddingwidth: 0, paddingheight: 0 });
  } catch {
    // Code 128'in kodlayamadığı karakter (ör. Türkçe harf) varsa barkodsuz basılır.
    return '';
  }
}

function svgYerlestir(svg) {
  // bwip-js yalnız viewBox verir; barkod kutuyu doldursun (yatay esneme okunurluğu bozmaz).
  return svg.replace('<svg ', '<svg preserveAspectRatio="none" ');
}

/** Raf etiketi: büyük raf kodu + barkod + bölge. */
function rafEtiketi(r, b) {
  const uzun = Math.max(6, String(r.code).length);
  const yazi = Math.min(b.h * 0.34, b.w / (uzun * 0.62));
  return `<div class="e">
    <div class="k" style="font-size:${yazi.toFixed(1)}mm">${kac(r.code)}</div>
    <div class="b" style="height:${(b.h * 0.36).toFixed(1)}mm">${svgYerlestir(barkod(r.code))}</div>
    ${r.zone ? `<div class="z" style="font-size:${Math.max(2.4, b.h * 0.07).toFixed(1)}mm">${kac(r.zone)} bölgesi</div>` : ''}
  </div>`;
}

/** Ürün etiketi: ad (en çok 2 satır), barkod, kod; istenirse raf. */
function urunEtiketi(u, b) {
  const kodBarkod = (u.barcodes && u.barcodes[0]) || u.code;
  const adYazi = Math.max(2.2, Math.min(b.h * 0.11, b.w / 22));
  return `<div class="e u">
    <div class="ad" style="font-size:${adYazi.toFixed(1)}mm">${kac(u.name)}</div>
    <div class="b" style="height:${(b.h * 0.38).toFixed(1)}mm">${svgYerlestir(barkod(kodBarkod))}</div>
    <div class="alt" style="font-size:${Math.max(2.2, b.h * 0.075).toFixed(1)}mm"><span>${kac(kodBarkod)}</span>${u.raf ? `<b>${kac(u.raf)}</b>` : `<span>${kac(u.code !== kodBarkod ? u.code : u.unit || '')}</span>`}</div>
  </div>`;
}

/**
 * Etiket sayfası. `ogeler`: raflar ({code, zone}) ya da ürünler ({name, code, barcodes, unit, raf}).
 * `adet`: her öğeden kaç tane. Dönen: { html, sayfa: {w,h} (mm) }.
 */
function sayfa({ tur, ogeler, bicim, adet = 1, fontUrl }) {
  const b = BICIM[bicim] || BICIM['y-60x40'];
  const tekrar = Math.max(1, Math.min(500, Number(adet) || 1));
  const liste = [];
  for (const o of ogeler) for (let i = 0; i < tekrar; i++) liste.push(o);
  const say = b.sutun * b.satir;
  const sayfalar = [];
  for (let i = 0; i < liste.length; i += say) sayfalar.push(liste.slice(i, i + say));
  const etiket = tur === 'urun' ? urunEtiketi : rafEtiketi;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    ${fontUrl ? `@font-face { font-family: 'Plex Mono'; src: url('${fontUrl}/fonts/plex_mono_semibold.ttf'); font-weight: 700; }
    @font-face { font-family: 'Plex Sans'; src: url('${fontUrl}/fonts/plex_sans_semibold.ttf'); font-weight: 600; }` : ''}
    @page { size: ${b.sayfa.w}mm ${b.sayfa.h}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    .s { width: ${b.sayfa.w}mm; height: ${b.sayfa.h}mm; padding: ${b.ust || 0}mm 0 0 ${b.sol || 0}mm; page-break-after: always; overflow: hidden;
         display: grid; grid-template-columns: repeat(${b.sutun}, ${b.w}mm); grid-auto-rows: ${b.h}mm; }
    .s:last-child { page-break-after: auto; }
    .e { padding: ${(b.h * 0.07).toFixed(1)}mm ${(b.w * 0.05).toFixed(1)}mm; display: flex; flex-direction: column; justify-content: center; gap: ${(b.h * 0.035).toFixed(1)}mm; overflow: hidden; }
    .k { font-family: 'Plex Mono', Consolas, monospace; font-weight: 700; text-align: center; line-height: 1; }
    .b svg { width: 100%; height: 100%; display: block; }
    .z { text-align: center; font-family: 'Plex Sans', Arial, sans-serif; }
    .u .ad { font-family: 'Plex Sans', Arial, sans-serif; font-weight: 600; line-height: 1.15; max-height: 2.3em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .u .alt { display: flex; justify-content: space-between; gap: 2mm; font-family: 'Plex Mono', Consolas, monospace; white-space: nowrap; overflow: hidden; }
    .u .alt b { font-weight: 700; }
  </style></head><body>${sayfalar.map((s) => `<div class="s">${s.map((o) => etiket(o, b)).join('')}</div>`).join('')}</body></html>`;
  return { html, sayfa: b.sayfa, etiket: liste.length };
}

module.exports = { BICIM, sayfa, barkod, eanGecerli };
