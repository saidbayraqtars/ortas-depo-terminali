// Sanal bekleme depoları. Ortaş'ta 106 ve 109 gerçek bir yer değil: yeni ya da fiyatı değişen mal fiyatlandırılmadan stoğa
// geçmesin diye açılmış muhasebe depoları; mal fiziken Merkez'de durur. Muhasebe fiyatlandırınca Vega'da 37 ile Merkez'e geçirir
// (bir 37 ≈ 50 fatura, faturayla bağı yok). Program bu depoları ayrı depo gibi değil, hedef deponun parçası gibi işler:
//   - bekleme deposunun belgesi hedef depoda görünür, raf kaydı hedef depoya yazılır,
//   - iki ucu da grupta olan 37/129 iş üretmez, çünkü mal yer değiştirmedi (106→1, 109→106, 1→109...),
//   - Vega stoku grup toplamıyla karşılaştırılır.
// Vega'ya bir şey yazılmaz. Belge kimlikleri (`20-IND-109`) değişmez, rafa kaldırma ilerlemesi yerinde kalır.
const db = require('./db');
const config = require('./config');
const log = require('./log');
const yetki = require('./yetki');

const EPS = 1e-6;
const yuvarla = (x) => Math.round(Number(x) * 10000) / 10000;
const GUN = 86400000;

/** Açıksa { hedef, depolar: Set }, kapalıysa null. */
function ayar(cfg = config.load()) {
  const b = cfg.bekleme;
  if (!b?.aktif || !b.hedef) return null;
  return { hedef: Number(b.hedef), depolar: new Set((b.depolar || []).map(Number)) };
}

/** Malın durduğu depo: bekleme deposu ise hedef, değilse kendisi. */
function fiziksel(depo, a = ayar()) {
  return a && a.depolar.has(Number(depo)) ? a.hedef : Number(depo);
}

const grupta = (depo, a) => Number(depo) === a.hedef || a.depolar.has(Number(depo));

/** Depo stoku karşılaştırılırken bakılacak Vega depoları. */
function grupDepolari(depo, a = ayar()) {
  const d = fiziksel(depo, a);
  return a && d === a.hedef ? [a.hedef, ...a.depolar] : [d];
}

/** İki ucu da grupta olan depo hareket belgesi: mal yer değiştirmedi, rafa kaldırılacak iş değil. */
function grupIci(r, a) {
  return /^D\d+$/.test(String(r.izahat)) && r.kaynakDepo !== undefined && r.kaynakDepo !== null && grupta(r.depo, a) && grupta(r.kaynakDepo, a);
}

/** Bekleme deposundan grup dışına giden depo hareket belgesi. */
function grupDisinaCikis(r, a) {
  return /^D\d+$/.test(String(r.izahat)) && a.depolar.has(Number(r.kaynakDepo)) && !grupta(r.depo, a);
}

/** { depo: miktar } → bekleme depoları hedefin içinde toplanmış hali. */
function birlestir(stok, a = ayar()) {
  if (!a) return stok;
  const out = {};
  for (const [d, q] of Object.entries(stok)) {
    const h = String(fiziksel(d, a));
    out[h] = Number(out[h] || 0) + Number(q);
  }
  return out;
}

/** Vega görüntüsünün programın gördüğü hali. Ham liste (`g.receipts`, `g.depolar`, `g.stock`) değişmez: ayar kapanınca aynı görüntüden geri döner. */
function gorunum(g, a) {
  const stokHam = new Map(Object.entries(g.stock || {}).map(([d, m]) => [Number(d), new Map(Object.entries(m))]));
  if (!a) return { belgeler: g.receipts || [], depolar: g.depolar || [], stokDepo: stokHam, stokHam };
  const stokDepo = new Map();
  for (const [d, m] of stokHam) {
    const h = fiziksel(d, a);
    if (!stokDepo.has(h)) stokDepo.set(h, new Map());
    const t = stokDepo.get(h);
    for (const [pid, q] of m) t.set(pid, Number(t.get(pid) || 0) + Number(q));
  }
  const hedefAd = (g.depolar || []).find((d) => Number(d.ind) === a.hedef)?.ad || String(a.hedef);
  // Bekleme deposundan grup dışına giden mal (109→100) gerçekten gitti: faturanın rafa kaldırılacak miktarından düşülür, en yeni girişten başlayarak.
  const cikan = new Map();
  for (const r of g.receipts || []) {
    if (!grupDisinaCikis(r, a)) continue;
    for (const l of r.lines) cikan.set(l.productId, Number(cikan.get(l.productId) || 0) + Number(l.accepted));
  }
  const belgeler = [];
  for (const r of [...(g.receipts || [])].sort((x, y) => y.ts - x.ts)) {
    if (grupIci(r, a)) continue;
    if (!a.depolar.has(r.depo)) {
      belgeler.push(r);
      continue;
    }
    const lines = r.lines
      .map((l) => {
        const c = Number(cikan.get(l.productId) || 0);
        if (c <= EPS) return l;
        const d = Math.min(c, Number(l.accepted));
        cikan.set(l.productId, c - d);
        return { ...l, accepted: yuvarla(l.accepted - d) };
      })
      .filter((l) => l.accepted > EPS);
    if (lines.length) belgeler.push({ ...r, lines, vegaDepo: r.depo, depo: a.hedef, depoAd: `${hedefAd} · ${r.depoAd}` });
  }
  return { belgeler, depolar: (g.depolar || []).filter((d) => !a.depolar.has(Number(d.ind))), stokDepo, stokHam };
}

// ---- Grup içi belgeden rafa kaldırılan miktar ---------------------------------------------------

/** Bekleme depolarına giren belgelerin satırları, ürün başına, en eski belge önce. */
function faturaSatirlari(g, a) {
  const shelved = new Map(db.all('SELECT line_id, shelved FROM receipt_shelved').map((r) => [r.line_id, r.shelved]));
  const kapali = new Set(db.all('SELECT receipt_id FROM receipt_state WHERE closed=1').map((r) => r.receipt_id));
  const out = new Map();
  const belgeler = (g.receipts || []).filter((r) => a.depolar.has(r.depo) && !grupIci(r, a)).sort((x, y) => x.ts - y.ts);
  for (const r of belgeler) {
    for (const l of r.lines) {
      if (!out.has(l.productId)) out.set(l.productId, []);
      out.get(l.productId).push({ lineId: l.id, receiptId: r.id, ts: r.ts, accepted: Number(l.accepted), shelved: Number(shelved.get(l.id) || 0), kapali: kapali.has(r.id) });
    }
  }
  return out;
}

/**
 * `qty` kadar miktarı ürünün açık fatura satırlarına dağıtır (satırlar yerinde güncellenir); dönen liste yazılacak kayıtlar.
 * `enGec`: 37'nin tarihi. Bir 37 kendinden sonra gelen faturanın malını taşıyamaz; eski çift kayıt yeni faturayı kapatmasın.
 */
function dagit(satirlar, kaynakLine, productId, qty, enGec) {
  const plan = [];
  let kalan = qty;
  for (const f of satirlar || []) {
    if (kalan <= EPS) break;
    const acik = f.accepted - f.shelved;
    if (f.kapali || acik <= EPS || f.ts > enGec) continue;
    const m = yuvarla(Math.min(kalan, acik));
    f.shelved += m;
    kalan -= m;
    plan.push({ kaynakLine, hedefLine: f.lineId, receiptId: f.receiptId, productId, qty: m });
  }
  return plan;
}

function planYaz(plan) {
  const t = Date.now();
  for (const p of plan) {
    db.run(
      `INSERT INTO receipt_shelved(line_id, receipt_id, product_id, shelved, updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(line_id) DO UPDATE SET shelved = shelved + excluded.shelved, updated_at = excluded.updated_at`,
      p.hedefLine,
      p.receiptId,
      p.productId,
      p.qty,
      t,
    );
    db.run('INSERT INTO bekleme_mahsup(kaynak_line, hedef_line, product_id, qty, at) VALUES(?,?,?,?,?)', p.kaynakLine, p.hedefLine, p.productId, p.qty, t);
  }
}

/** Geçişte: grup içi belgelerden rafa kaldırılmış, henüz fatura satırına yazılmamış miktarın planı. */
function mahsupPlani(g, a) {
  const faturalar = faturaSatirlari(g, a);
  const shelved = new Map(db.all('SELECT line_id, shelved FROM receipt_shelved').map((r) => [r.line_id, r.shelved]));
  const yazilan = new Map(db.all('SELECT kaynak_line, SUM(qty) AS q FROM bekleme_mahsup GROUP BY kaynak_line').map((r) => [r.kaynak_line, r.q]));
  const plan = [];
  for (const r of g.receipts || []) {
    if (!grupIci(r, a)) continue;
    for (const l of r.lines) {
      const q = Number(shelved.get(l.id) || 0) - Number(yazilan.get(l.id) || 0);
      if (q > EPS) plan.push(...dagit(faturalar.get(l.productId), l.id, l.productId, q, r.ts));
    }
  }
  return plan;
}

/**
 * Terminal eşitlemeden önce gizlenen grup içi belgeden gelen rafa kaldırma: açık fatura satırına yazılır.
 * Mal şu anda fiilen rafa kondu, geçmiş bir kayıt değil; tarih sınırı uygulanmaz.
 */
function gecikmisKayit(lineId, productId, qty) {
  const a = ayar();
  const g = require('./depo').goruntu();
  if (!a || !g) return;
  planYaz(dagit(faturaSatirlari(g, a).get(productId), lineId, productId, qty, Infinity));
}

/** Grup içi belgeden yapılan rafa kaldırma geri alınınca fatura satırına yazılan miktar da geri döner. */
function mahsupGeri(kaynakLine, q) {
  let kalan = q;
  for (const m of db.all('SELECT id, hedef_line, qty FROM bekleme_mahsup WHERE kaynak_line=? AND qty>0 ORDER BY id DESC', kaynakLine)) {
    if (kalan <= EPS) break;
    const x = Math.min(kalan, m.qty);
    db.run('UPDATE receipt_shelved SET shelved = MAX(shelved - ?, 0), updated_at=? WHERE line_id=?', x, Date.now(), m.hedef_line);
    db.run('UPDATE bekleme_mahsup SET qty = qty - ? WHERE id=?', x, m.id);
    kalan -= x;
  }
}

/**
 * Hem bekleme faturasından hem grup içi belgeden rafa kaldırılmış ürünler: aynı mal iki kez kalkmış olabilir (eski davranış).
 * `fazla` en çok ne kadarının çift olabileceği; grup içi belgedeki hareketler yönetici Geri al ile düzeltsin diye listelenir.
 */
function ciftSupheli(g, a) {
  const d = require('./depo');
  const shelved = new Map(db.all('SELECT line_id, shelved FROM receipt_shelved').map((r) => [r.line_id, r.shelved]));
  const yazilan = new Map(db.all('SELECT hedef_line, SUM(qty) AS q FROM bekleme_mahsup GROUP BY hedef_line').map((r) => [r.hedef_line, r.q]));
  const urunler = new Map();
  const u = (pid) => {
    if (!urunler.has(pid)) urunler.set(pid, { fatura: 0, faturadan: 0, transferden: 0, belgeNo: new Set() });
    return urunler.get(pid);
  };
  for (const r of g.receipts || []) {
    if (grupIci(r, a)) {
      for (const l of r.lines) {
        const q = Number(shelved.get(l.id) || 0);
        if (q > EPS) {
          const x = u(l.productId);
          x.transferden += q;
          x.belgeNo.add(r.docNo);
        }
      }
    } else if (a.depolar.has(r.depo)) {
      for (const l of r.lines) {
        const x = u(l.productId);
        x.fatura += Number(l.accepted);
        x.faturadan += Number(shelved.get(l.id) || 0) - Number(yazilan.get(l.id) || 0);
      }
    }
  }
  const liste = [];
  for (const [pid, x] of urunler) {
    const fazla = yuvarla(Math.min(x.faturadan, x.transferden, x.faturadan + x.transferden - x.fatura));
    if (fazla <= EPS) continue;
    const belgeler = [...x.belgeNo];
    const hareketler = db
      .all(
        `SELECT id, ts, depo, shelf, delta, ref, user, device, kind FROM movement
         WHERE kind='PUTAWAY' AND geri_at IS NULL AND product_id=? AND ref IN (${belgeler.map(() => '?').join(',')}) ORDER BY ts`,
        pid,
        ...belgeler,
      )
      .map((h) => ({ ...h, depoAd: d.depoAdi(h.depo) }));
    const ad = d.urunAdi(pid);
    liste.push({ productId: pid, ...ad, fatura: yuvarla(x.fatura), faturadan: yuvarla(x.faturadan), transferden: yuvarla(x.transferden), fazla, hareketler });
  }
  return liste.sort((p, q) => q.fazla - p.fazla);
}

// ---- Açma, kapama ------------------------------------------------------------------------------

function secim({ depolar, hedef }) {
  return { hedef: Number(hedef), depolar: new Set((Array.isArray(depolar) ? depolar : []).map(Number).filter(Number.isInteger)) };
}

/** Açınca ne olacağını hesaplar, hiçbir şeye dokunmaz. `engeller` boş değilse açılmaz. */
function onizle(girdi = {}) {
  const d = require('./depo');
  const g = d.goruntu();
  const a = secim(girdi);
  const engeller = [];
  if (ayar()) engeller.push('Bekleme depoları zaten açık');
  if (!g) engeller.push('Vega verisi henüz okunmadı');
  if (!a.depolar.size) engeller.push('En az bir bekleme deposu seçin');
  if (!Number.isInteger(a.hedef) || a.hedef <= 0) engeller.push('Malın durduğu depoyu seçin');
  if (a.depolar.has(a.hedef)) engeller.push('Malın durduğu depo bekleme deposu olamaz');
  const kullanilan = new Set((g?.depolar || []).map((x) => Number(x.ind)));
  for (const x of [...a.depolar, a.hedef]) {
    if (g && Number.isInteger(x) && x > 0 && !kullanilan.has(x)) engeller.push(`${x} numaralı depo kullanılan depolar arasında değil (Ayarlar › Vega)`);
  }
  const cfg = config.load();
  if (a.depolar.has(Number(cfg.vega.depo))) engeller.push('Varsayılan depo bekleme deposu olamaz (Ayarlar › Vega)');
  const cift = (cfg.transfer?.cift || []).map(Number);
  for (const x of a.depolar) if (cift.includes(x)) engeller.push(`${d.depoAdi(x)} depolar arası transfer çiftinde; bekleme deposu olamaz`);
  const yer = [...a.depolar].join(',') || '0';
  for (const s of db.all(`SELECT no, status FROM count_session WHERE depo IN (${yer}) AND status IN ('OPEN','CLOSED')`)) {
    engeller.push(`${s.no} sayımı bekleme deposunda ${s.status === 'OPEN' ? 'açık' : 'onay bekliyor'}: önce sonuçlandırın`);
  }
  if (engeller.length) return { engeller };

  const raf = db.get(`SELECT COUNT(*) AS satir, COUNT(DISTINCT product_id) AS urun, SUM(qty) AS adet FROM location WHERE depo IN (${yer}) AND qty>0`);
  const kalemSay = (liste) => liste.reduce((t, r) => t + r.lines.length, 0);
  const gizlenen = g.receipts.filter((r) => grupIci(r, a));
  const tasinan = g.receipts.filter((r) => a.depolar.has(r.depo) && !grupIci(r, a));
  const plan = mahsupPlani(g, a);
  const cift2 = ciftSupheli(g, a);
  return {
    engeller,
    hedefAd: d.depoAdi(a.hedef),
    depoAdlari: [...a.depolar].map((x) => d.depoAdi(x)),
    raf: { satir: raf.satir, urun: raf.urun, adet: yuvarla(raf.adet || 0) },
    rafTanimi: db.get(`SELECT COUNT(*) AS n FROM shelf WHERE depo IN (${yer})`).n,
    zimmet: db.get(`SELECT COUNT(*) AS n FROM product_home WHERE depo IN (${yer})`).n,
    belgeTasinan: { belge: tasinan.length, kalem: kalemSay(tasinan) },
    belgeGizlenen: { belge: gizlenen.length, kalem: kalemSay(gizlenen) },
    mahsup: { satir: plan.length, urun: new Set(plan.map((p) => p.productId)).size, adet: yuvarla(plan.reduce((t, p) => t + p.qty, 0)) },
    cift: { urun: cift2.length, adet: yuvarla(cift2.reduce((t, c) => t + c.fazla, 0)) },
    kullanici: db.all(`SELECT username, depots FROM app_user WHERE depots<>'*'`).filter((u) => u.depots.split(',').some((x) => a.depolar.has(Number(x)))).map((u) => u.username),
  };
}

/** Eşlemeyi açar: raf kayıtları, raf tanımları ve adresler hedefe taşınır, grup içi belgeden kalkanlar fatura satırına yazılır. Tek işlem. */
function ac({ depolar, hedef, kim = 'yönetici' } = {}) {
  const d = require('./depo');
  const o = onizle({ depolar, hedef });
  if (o.engeller.length) throw Object.assign(new Error(o.engeller[0]), { status: 400 });
  const a = secim({ depolar, hedef });
  const g = d.goruntu();
  const plan = mahsupPlani(g, a);
  const yer = [...a.depolar].join(',');
  const t = Date.now();
  db.tx(() => {
    for (const s of db.all(`SELECT code, zone, note, source FROM shelf WHERE depo IN (${yer})`)) d.rafEkle(a.hedef, s.code, { zone: s.zone, note: s.note, source: s.source });
    for (const l of db.all(`SELECT depo, product_id, shelf, qty FROM location WHERE depo IN (${yer})`)) {
      const h = { ts: t, user: kim, device: 'PC', kind: 'DEPO_BIRLESTIR' };
      d.miktarEkle(l.depo, l.product_id, l.shelf, -l.qty, { ...h, ref: d.depoAdi(a.hedef) });
      d.miktarEkle(a.hedef, l.product_id, l.shelf, l.qty, { ...h, ref: d.depoAdi(l.depo) });
    }
    db.run(
      `INSERT INTO product_home(depo, product_id, shelf, source, updated_at)
       SELECT ?, product_id, shelf, source, updated_at FROM product_home WHERE depo IN (${yer}) ON CONFLICT(depo, product_id, shelf) DO NOTHING`,
      a.hedef,
    );
    db.run(`DELETE FROM product_home WHERE depo IN (${yer})`);
    db.run(`DELETE FROM shelf WHERE depo IN (${yer})`);
    for (const u of db.all(`SELECT username, depots FROM app_user WHERE depots<>'*'`)) {
      const yeni = yetki.depolariDogrula(u.depots.split(',').filter(Boolean).map((x) => fiziksel(x, a)));
      if (yeni !== u.depots) db.run('UPDATE app_user SET depots=? WHERE username=?', yeni, u.username);
    }
    planYaz(plan);
  });
  config.update({
    bekleme: { aktif: true, depolar: [...a.depolar], hedef: a.hedef, gecis: { at: t, kim, raf: o.raf, belgeGizlenen: o.belgeGizlenen, mahsup: o.mahsup, cift: o.cift } },
  });
  d.yenidenKur();
  if (config.load().rafAdresi?.yaz) d.rafYazTetikle();
  log.bilgi(`Bekleme depoları açıldı: ${o.depoAdlari.join(', ')} → ${o.hedefAd}; ${o.raf.satir} raf kaydı taşındı, ${o.belgeGizlenen.belge} grup içi belge gizlendi · ${kim}`);
  return o;
}

/** Eşlemeyi kapatır. Raf kayıtları hedefte kalır; grup içi 37'ler yeniden belge olarak görünür. */
function kapat(kim = 'yönetici') {
  config.update({ bekleme: { aktif: false } });
  require('./depo').yenidenKur();
  log.bilgi(`Bekleme depoları kapatıldı · ${kim}`);
  return { ok: true };
}

// ---- Rapor -------------------------------------------------------------------------------------

/** Bekleme deposundaki ürünün kaç gündür beklediği: stok en yeni girişlerden kalır, stoğu karşılayan en eski girişe bakılır. */
function beklemeBaslangici(girisler, q) {
  let t = 0;
  let son = null;
  for (const x of girisler) {
    son = x.ts;
    t += x.q;
    if (t >= q - EPS) break;
  }
  return son;
}

/** Bekleme depoları sayfası: ayar, fiyat bekleyenler, Merkez'e geçip rafa kalkmayanlar, çift şüphesi. */
function rapor() {
  const d = require('./depo');
  const g = d.goruntu();
  const b = config.load().bekleme || {};
  const durum = {
    aktif: Boolean(ayar()),
    depolar: b.depolar || [],
    hedef: b.hedef ?? null,
    gecis: b.gecis || null,
    secenekler: (g?.depolar || []).map((x) => ({ ind: Number(x.ind), ad: x.ad })),
  };
  const a = ayar();
  if (!a || !g) return { ...durum, bekleyen: [], hazir: [], cift: [] };

  const girisler = new Map();
  for (const r of g.receipts) {
    if (!a.depolar.has(r.depo) || grupIci(r, a)) continue;
    for (const l of r.lines) {
      const k = `${r.depo}|${l.productId}`;
      if (!girisler.has(k)) girisler.set(k, []);
      girisler.get(k).push({ ts: r.ts, q: Number(l.accepted) });
    }
  }
  for (const x of girisler.values()) x.sort((p, q) => q.ts - p.ts);

  const raf = new Map(db.all('SELECT product_id, SUM(qty) AS q FROM location WHERE depo=? AND qty>0 GROUP BY product_id', a.hedef).map((r) => [r.product_id, r.q]));
  const simdi = Date.now();
  const bekleyen = [];
  const beklemeStok = new Map();
  for (const s of a.depolar) {
    for (const [pid, q0] of g.stokHam.get(s) || []) {
      const q = Number(q0);
      beklemeStok.set(pid, Number(beklemeStok.get(pid) || 0) + q);
      if (q <= EPS) continue;
      const bas = beklemeBaslangici(girisler.get(`${s}|${pid}`) || [], q);
      bekleyen.push({
        productId: pid,
        ...d.urunAdi(pid),
        depo: s,
        depoAd: d.depoAdi(s),
        vega: yuvarla(q),
        rafta: yuvarla(raf.get(pid) || 0),
        gun: bas ? Math.floor((simdi - bas) / GUN) : null,
      });
    }
  }
  bekleyen.sort((p, q) => (q.gun ?? -1) - (p.gun ?? -1) || q.vega - p.vega);

  // Muhasebe geçirmiş (bekleme deposunda stok kalmamış) ama belgede hâlâ rafa kaldırılacak görünen mal: satılabilir, yeri belli değil.
  const acik = new Map();
  for (const r of d.belgeler()) {
    if (r.vegaDepo === undefined || !r.acik) continue;
    for (const l of r.lines) {
      const k = l.accepted - l.shelved;
      if (k <= EPS) continue;
      if (!acik.has(l.productId)) acik.set(l.productId, { kalan: 0, belgeler: new Set() });
      const x = acik.get(l.productId);
      x.kalan += k;
      x.belgeler.add(r.docNo);
    }
  }
  const hazir = [];
  for (const [pid, x] of acik) {
    const q = yuvarla(x.kalan - Math.max(0, beklemeStok.get(pid) || 0));
    if (q > EPS) hazir.push({ productId: pid, ...d.urunAdi(pid), miktar: q, rafta: yuvarla(raf.get(pid) || 0), belgeler: [...x.belgeler].slice(0, 3), belgeSayisi: x.belgeler.size });
  }
  hazir.sort((p, q) => q.miktar - p.miktar);

  return { ...durum, bekleyen, hazir: hazir.slice(0, 2000), hazirToplam: hazir.length, cift: ciftSupheli(g, a) };
}

module.exports = { ayar, fiziksel, grupDepolari, grupIci, birlestir, gorunum, gecikmisKayit, mahsupGeri, onizle, ac, kapat, rapor };
