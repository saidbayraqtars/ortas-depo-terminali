const test = require('node:test');
const assert = require('node:assert');
const fuzzy = require('../server/fuzzy');

const urunler = [
  { id: '1', code: 'YF-1042', name: 'Yağ filtresi' },
  { id: '2', code: 'HF-0310', name: 'Hava filtresi' },
  { id: '3', code: 'AM-3301', name: 'Amortisör ön sağ' },
  { id: '4', code: 'FB-2210', name: 'Fren balatası ön takım' },
  { id: '5', code: 'BJ-1450', name: 'Buji iridyum' },
];

function ara(q) {
  const qt = fuzzy.tokens(q);
  const c = qt.join('');
  return urunler
    .map((u) => ({ u, s: fuzzy.puan(qt, c, fuzzy.kayit(u)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.u.id);
}

test('Türkçe harfler sadeleşir', () => {
  assert.strictEqual(fuzzy.norm('Amortisör ÖN Sağ'), 'amortisor on sag');
  assert.strictEqual(fuzzy.norm('IŞIK-12'), 'isik 12');
});

test('yazım hatası tolere edilir', () => {
  assert.strictEqual(ara('yag filitre')[0], '1');
  assert.strictEqual(ara('amortisor')[0], '3');
  assert.strictEqual(ara('balata')[0], '4');
  assert.strictEqual(ara('bujı')[0], '5');
});

test('kod ile tam eşleşme en üstte', () => {
  assert.deepStrictEqual(ara('hf0310'), ['2']);
  assert.strictEqual(ara('YF-1042')[0], '1');
});

test('alakasız sorgu sonuç vermez', () => {
  assert.deepStrictEqual(ara('televizyon'), []);
});

test('ortak kelime iki ürünü de getirir', () => {
  assert.deepStrictEqual(ara('filtre').sort(), ['1', '2']);
});

// Hızlandırma (tampon, harf maskesiyle ön eleme) sonucu değiştirmemeli: eski, sade uygulamayla aynı puan.
test('puan: hızlandırılmış arama eski uygulamayla aynı sonucu verir', () => {
  const eskiBenzerlik = (a, b) => {
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
  };
  const eskiPuan = (qt, compact, e) => {
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
          best = Math.max(best, eskiBenzerlik(t, w), eskiBenzerlik(t, w.slice(0, t.length + 1)), eskiBenzerlik(t, w.slice(0, t.length)));
          if (best >= 0.99) break;
        }
        if (best >= 0.7) s = best * 2;
      }
      if (!s) eksik++;
      toplam += s;
    }
    if (eksik * 2 > qt.length) return 0;
    return toplam / qt.length - eksik * 0.8;
  };
  const fuzzy = require('../server/fuzzy');
  const kelime = ['fren', 'balata', 'ön', 'arka', 'dayco', 'triger', 'kayışı', 'filtre', 'yağ', 'hava', 'polen', 'amortisör', 'salıncak', 'rotil', 'rulman', 'debriyaj', 'seti', 'transit', 'doblo', 'fiorino', 'astra', '1.6', '90x110x9', 'v184', 'sağ', 'sol', 'takım', 'keçe', 'krank', 'conta', 'bmw', 'f10', 'x5', 'mercedes', 'w204', 'şanzıman', 'kulağı', 'egzoz', 'manifold', 'su', 'pompası', 'termostat', 'radyatör', 'hortumu'];
  let tohum = 7;
  const rast = (n) => { tohum = (Math.imul(tohum, 1103515245) + 12345) >>> 0; return tohum % n; };
  const boz = (w) => {
    if (w.length < 3 || rast(3)) return w;
    const i = rast(w.length);
    return [w.slice(0, i) + w.slice(i + 1), w.slice(0, i) + 'x' + w.slice(i + 1), w.slice(0, i) + w[i] + w.slice(i), w.slice(0, i) + (w[i + 1] || '') + w[i] + w.slice(i + 2)][rast(4)];
  };
  const urunler = Array.from({ length: 600 }, (_, i) => fuzzy.kayit({ code: `${kelime[rast(kelime.length)].slice(0, 3).toUpperCase()}-${1000 + i} ${rast(99)}`, name: Array.from({ length: 2 + rast(5) }, () => kelime[rast(kelime.length)]).join(' ') }));
  let eslesen = 0;
  for (let s = 0; s < 400; s++) {
    const sorgu = Array.from({ length: 1 + rast(3) }, () => boz(kelime[rast(kelime.length)])).join(' ');
    const qt = fuzzy.tokens(sorgu);
    const compact = qt.join('');
    for (const e of urunler) {
      const yeni = fuzzy.puan(qt, compact, e);
      assert.strictEqual(yeni, eskiPuan(qt, compact, e), `"${sorgu}" × "${e.nName}"`);
      if (yeni) eslesen++;
    }
  }
  assert.ok(eslesen > 1000, `eşleşme az: ${eslesen}`);
});
