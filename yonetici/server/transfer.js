// Depolar arası transfer. Terminalden iki işlem gelir:
//   TRANSFER_SEND    → gönderen depoda raf stoku düşer; Vega'ya depo gönderim fişi (128) yazılır.
//   TRANSFER_RECEIVE → alan depoda mal rafa girer; Vega'ya gönderim kabul fişi (129) yazılır; gelmeyen miktar (eksik)
//                      transfer_fark'ta çözülene kadar kayıtlı kalır, gönderim terminallerde kapanır.
// Vega'ya yazım terminali beklemez: işlem hemen kabul edilir, fiş arka planda yazılır (bekleyen kayıtlar `transfer`
// tablosunda, hata olursa yeniden denenir, 5 denemeden sonra yönetici ekranından elle). Fişin yapısı vega.js transferYaz.
//
// Gönderim (128) ile kabul (129) arasında Vega'da belge bağı yoktur. Açık gönderim, (gönderen, alan, ürün) bazında
// toplam gönderilen − toplam alınan − programda kayıtlı eksik, en yeni gönderimden geriye dağıtılarak bulunur.
const db = require('./db');
const config = require('./config');
const vega = require('./vega');
const log = require('./log');

const depo = () => require('./depo');
const EPS = 1e-9;
const now = () => Date.now();
const yuvarla = (x) => Math.round(Number(x) * 10000) / 10000;
const DENEME_SINIRI = 5;

// ---- Depolar ve yoldaki depo -----------------------------------------------------------------

let depoOnbellek = { at: 0, anahtar: '', liste: [] };

/** Vega'daki bütün depolar (terminalin kullandığı depolar dışındakiler de hedef olabilir). 10 dakika saklanır. */
async function tumDepolar(cfg = config.load()) {
  const anahtar = JSON.stringify([cfg.vega.server, cfg.vega.database, cfg.vega.firma]);
  if (depoOnbellek.anahtar === anahtar && now() - depoOnbellek.at < 600000) return depoOnbellek.liste;
  const liste = await vega.depolar(cfg.vega, cfg.vega.firma);
  depoOnbellek = { at: now(), anahtar, liste };
  return liste;
}

/** Yoldaki depo: ayarda varsa o, yoksa adı TRANSFER olan depo. Bulunamazsa null (özellik çalışmaz). */
async function yoldaDepo(cfg = config.load()) {
  const a = Number(cfg.transfer?.yoldaDepo);
  if (Number.isInteger(a) && a > 0) return a;
  const d = (await tumDepolar(cfg)).find((x) => String(x.ad).trim().toLocaleUpperCase('tr') === 'TRANSFER');
  return d ? Number(d.ind) : null;
}

// ---- Açık gönderimler (Vega'dan) --------------------------------------------------------------

let gorunum = { at: 0, yolda: null, depolar: [], sevkler: [], ozet: '' };
let yenilePromise = null;

function tarihStr(d) {
  if (!(d instanceof Date)) return '';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function baslangic(cfg) {
  const gun = Math.max(1, Math.min(365, Number(cfg.transfer?.gun) || 45));
  const sinir = new Date();
  sinir.setHours(0, 0, 0, 0);
  sinir.setDate(sinir.getDate() - gun);
  const ayar = cfg.kabul?.baslangic ? new Date(`${cfg.kabul.baslangic}T00:00:00`) : null;
  return ayar && ayar > sinir ? ayar : sinir;
}

/** Vega'dan okunan gönderim/kabul toplamlarından terminallerde açık görünecek gönderimleri çıkarır. */
function acikHesapla(oku, bas) {
  const kapali = new Set(db.all('SELECT sevk_ind FROM transfer_kapali').map((r) => r.sevk_ind));
  // Programda kayıtlı eksik (açık ya da kayıp diye çözülmüş) havuzdan düşer; "bulundu" Vega'da kabul edilir, düşmez.
  const fark = new Map();
  for (const f of db.all("SELECT from_depo, to_depo, product_id, eksik FROM transfer_fark WHERE durum<>'BULUNDU' AND created_at >= ?", bas.getTime())) {
    const k = `${f.from_depo}|${f.to_depo}|${f.product_id}`;
    fark.set(k, (fark.get(k) || 0) + f.eksik);
  }
  const bakiye = new Map();
  for (const h of oku.havuz) {
    const k = `${h.kaynak}|${h.hedef}|${h.stokno}`;
    bakiye.set(k, Math.max(0, yuvarla(h.gonderilen - h.alinan - (fark.get(k) || 0))));
  }
  const sevkler = [...oku.sevkler]
    .filter((s) => !kapali.has(s.ind))
    .sort((a, b) => (b.tarih?.getTime?.() || 0) - (a.tarih?.getTime?.() || 0) || b.ind - a.ind);
  const out = [];
  for (const s of sevkler) {
    const satirlar = [];
    for (const k of s.kalemler) {
      if (!depo().urun(k.stokno)) continue;
      const anahtar = `${s.kaynak}|${s.hedef}|${k.stokno}`;
      const kalan = bakiye.get(anahtar) || 0;
      const acik = Math.min(k.miktar, kalan);
      if (acik <= EPS) continue;
      bakiye.set(anahtar, yuvarla(kalan - acik));
      satirlar.push({ productId: k.stokno, sent: yuvarla(k.miktar), open: yuvarla(acik) });
    }
    if (satirlar.length) out.push({ ...s, satirlar });
  }
  // Terminalde belge numarasına göre eskiden yeniye okunur.
  return out.sort((a, b) => (a.tarih?.getTime?.() || 0) - (b.tarih?.getTime?.() || 0) || a.ind - b.ind);
}

/**
 * Açık gönderim listesini Vega'dan yeniler. Değiştiyse ana veri yeniden kurulur (terminaller haberdar olur).
 * Okuma sürerken gelen çağrı aynı okumanın sonucunu bekler (eski listeyle hemen dönmez).
 */
function yenile() {
  if (!yenilePromise) {
    yenilePromise = yenileAsil().finally(() => {
      yenilePromise = null;
    });
  }
  return yenilePromise;
}

async function yenileAsil() {
  const cfg = config.load();
  if (!cfg.transfer?.aktif || !vega.hazirMi(cfg.vega)) return gorunum;
  try {
    const yolda = await yoldaDepo(cfg);
    const tum = await tumDepolar(cfg);
    const alanlar = depo().depolar().map((d) => d.ind);
    const bas = baslangic(cfg);
    const oku = await vega.transferOku(cfg, { bas, alanlar });
    const sevkler = acikHesapla(oku, bas);
    const ozet = JSON.stringify([yolda, tum.map((d) => [d.ind, d.ad]), sevkler.map((s) => [s.ind, s.satirlar])]);
    const degisti = ozet !== gorunum.ozet;
    gorunum = { at: now(), yolda, depolar: tum, sevkler, ozet };
    if (degisti) depo().degisti();
  } catch (e) {
    log.uyari(`Transfer: açık gönderimler okunamadı: ${e.message}`);
  }
  return gorunum;
}

/** Terminale giden ana verideki `transfer` bölümü (head parçasında). Kapalıyken yalnız { on: false }. */
function terminalGorunumu() {
  const cfg = config.load();
  if (!cfg.transfer?.aktif) return { on: false };
  const ad = (d) => (gorunum.depolar.find((x) => Number(x.ind) === d)?.ad) || depo().depoAdi(d);
  return {
    on: Boolean(gorunum.yolda),
    yolda: gorunum.yolda,
    depots: gorunum.depolar.filter((d) => Number(d.ind) !== gorunum.yolda).map((d) => ({ id: Number(d.ind), name: d.ad })),
    incoming: gorunum.sevkler.map((s) => ({
      id: String(s.ind),
      no: s.no,
      date: tarihStr(s.tarih),
      from: s.kaynak,
      fromName: ad(s.kaynak),
      to: s.hedef,
      toName: ad(s.hedef),
      lines: s.satirlar.map((l) => ({ productId: l.productId, sent: l.sent, open: l.open })),
    })),
  };
}

// ---- Terminal işlemleri (islemUygula içinden, tek SQLite işleminde) ----------------------------

function kur(p, ad) {
  const n = Number(p[ad]);
  return Number.isInteger(n) ? n : null;
}

function satirlariOku(p, Ret, bilinen) {
  const satirlar = [];
  for (const l of Array.isArray(p.lines) ? p.lines : []) {
    const pid = String(l.productId || '');
    const qty = Number(l.qty);
    if (!pid || !(qty > 0)) throw new Ret('Satırda ürün ya da miktar geçersiz');
    bilinen(pid);
    satirlar.push({ pid, qty: yuvarla(qty), shelf: depo().rafKodu(l.shelf) });
  }
  if (!satirlar.length) throw new Ret('Transferde satır yok');
  return satirlar;
}

function ac(cfg, Ret) {
  // Sunucu yeni açıldıysa açık gönderim listesi henüz okunmamıştır: kalıcı ret değil, işlem terminalde bekler ve yeniden gelir.
  if (cfg.transfer?.aktif && !gorunum.at) throw new Error('Transfer verisi henüz okunmadı');
  if (!cfg.transfer?.aktif) throw new Ret('Depolar arası transfer yönetici programında açık değil (Ayarlar › Depolar arası transfer)');
  if (!gorunum.yolda) throw new Ret('Yoldaki depo (TRANSFER) belli değil; Ayarlar › Depolar arası transfer');
}

function gonderUygula(op, p, h, { Ret, bilinen }) {
  const cfg = config.load();
  ac(cfg, Ret);
  const from = kur(p, 'from');
  const to = kur(p, 'to');
  if (from === null || to === null) throw new Ret('Gönderen ya da alan depo yok');
  if (from === to) throw new Ret('Gönderen ve alan depo aynı');
  if (from === gorunum.yolda || to === gorunum.yolda) throw new Ret('Yoldaki depo gönderen ya da alan olamaz');
  if (!gorunum.depolar.some((d) => Number(d.ind) === to) || !gorunum.depolar.some((d) => Number(d.ind) === from)) throw new Ret('Depo Vega\'da bulunamadı');
  const satirlar = satirlariOku(p, Ret, bilinen);
  const d = depo();
  for (const l of satirlar) {
    if (!l.shelf) continue;
    // Sunucudaki miktar terminalin gördüğünden azsa eksiye düşmez; Vega'ya gönderilen miktar terminalin yazdığıdır.
    d.miktarEkle(from, l.pid, l.shelf, -l.qty, { ...h, kind: 'TRANSFER_OUT_DEPO', ref: `→ ${d.depoAdi(to)}` });
    if (d.miktar(from, l.pid, l.shelf) <= EPS) d.terminalZimmetBosalt(from, l.pid, l.shelf);
  }
  db.run('INSERT INTO transfer(id, kind, from_depo, to_depo, user, device, created_at) VALUES(?,?,?,?,?,?,?)', op.id, 'SEND', from, to, h.user, h.device, now());
  for (const l of satirlar) {
    db.run(
      'INSERT INTO transfer_line(transfer_id, product_id, qty, shelf) VALUES(?,?,?,?) ON CONFLICT(transfer_id, product_id, shelf) DO UPDATE SET qty = qty + excluded.qty',
      op.id, l.pid, l.qty, l.shelf,
    );
  }
}

function kabulUygula(op, p, h, { Ret, bilinen }) {
  const cfg = config.load();
  ac(cfg, Ret);
  const sevk = gorunum.sevkler.find((s) => String(s.ind) === String(p.sevkId));
  if (!sevk) {
    if (db.get('SELECT 1 FROM transfer_kapali WHERE sevk_ind=?', Number(p.sevkId))) throw new Ret('Bu gönderimin kabulü daha önce tamamlandı');
    throw new Ret('Gönderim açık görünmüyor (kabul edilmiş, iptal edilmiş ya da Vega henüz okunmamış olabilir)');
  }
  const satirlar = satirlariOku(p, Ret, bilinen);
  const acik = new Map(sevk.satirlar.map((l) => [l.productId, l.open]));
  const gelen = new Map();
  for (const l of satirlar) {
    if (!acik.has(l.pid)) throw new Ret(`${depo().urun(l.pid)?.code || l.pid} bu gönderimde yok`);
    gelen.set(l.pid, yuvarla((gelen.get(l.pid) || 0) + l.qty));
  }
  for (const [pid, q] of gelen) {
    if (q - acik.get(pid) > EPS) throw new Ret(`${depo().urun(pid)?.code || pid}: gönderilen ${acik.get(pid)}, alınan ${q}`);
  }
  const d = depo();
  const to = sevk.hedef;
  const from = sevk.kaynak;
  for (const l of satirlar) {
    if (!l.shelf) continue;
    if (!d.rafVarMi(to, l.shelf)) d.rafEkle(to, l.shelf, { source: 'TERMINAL', note: 'Transfer kabulünden geldi' });
    d.miktarEkle(to, l.pid, l.shelf, l.qty, { ...h, kind: 'TRANSFER_IN_DEPO', ref: `${sevk.no} · ${d.depoAdi(from)}` });
    d.terminalZimmet(to, l.pid, l.shelf);
  }
  db.run('INSERT INTO transfer(id, kind, from_depo, to_depo, sevk_ind, sevk_no, user, device, created_at) VALUES(?,?,?,?,?,?,?,?,?)', op.id, 'RECEIVE', from, to, sevk.ind, sevk.no, h.user, h.device, now());
  for (const l of satirlar) {
    db.run(
      'INSERT INTO transfer_line(transfer_id, product_id, qty, shelf) VALUES(?,?,?,?) ON CONFLICT(transfer_id, product_id, shelf) DO UPDATE SET qty = qty + excluded.qty',
      op.id, l.pid, l.qty, l.shelf,
    );
    // Rafla birlikte alınan miktar baştan yerleşmiş sayılır; rafsız alınan, rafa kaldırılacak belgede (programKabulFisleri) bekler.
    if (l.shelf) {
      db.run(
        `INSERT INTO receipt_shelved(line_id, receipt_id, product_id, shelved, updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(line_id) DO UPDATE SET shelved = shelved + excluded.shelved, updated_at = excluded.updated_at`,
        `TRF-${op.id}-${l.pid}`, `TRF-${op.id}`, l.pid, l.qty, now(),
      );
    }
  }
  // Gelmeyen miktar kayıtlı kalır; gönderim terminallerde kapanır (belge açık kalmaz).
  for (const [pid, beklenen] of acik) {
    const alinan = gelen.get(pid) || 0;
    const eksik = yuvarla(beklenen - alinan);
    if (eksik > EPS) {
      db.run(
        'INSERT INTO transfer_fark(transfer_id, sevk_ind, sevk_no, from_depo, to_depo, product_id, sent, received, eksik, user, device, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        op.id, sevk.ind, sevk.no, from, to, pid, beklenen, alinan, eksik, h.user, h.device, now(),
      );
    }
  }
  db.run('INSERT INTO transfer_kapali(sevk_ind, transfer_id, at) VALUES(?,?,?)', sevk.ind, op.id, now());
  fisOnbellek.surum = -1;
  gorunum.sevkler = gorunum.sevkler.filter((s) => s.ind !== sevk.ind);
}

/** islemUygula'dan çağrılır. İşlem türü transfer değilse false. */
function uygula(op, p, h, ctx) {
  if (op.type === 'TRANSFER_SEND') gonderUygula(op, p, h, ctx);
  else if (op.type === 'TRANSFER_RECEIVE') kabulUygula(op, p, h, ctx);
  else return false;
  return true;
}

// ---- Vega'ya yazma (arka plan) ------------------------------------------------------------------

let yaziyor = false;
let tekrar = false;
let zamanlayici = null;

function yaziciTetikle(ms = 500) {
  clearTimeout(zamanlayici);
  zamanlayici = setTimeout(() => {
    yaz().catch((e) => log.hata('Transfer yazıcısı', e));
  }, ms);
  zamanlayici.unref?.();
}

async function yaz() {
  if (yaziyor) {
    tekrar = true;
    return;
  }
  yaziyor = true;
  try {
    const cfg = config.load();
    if (!cfg.transfer?.aktif) return;
    for (;;) {
      const t = db.get("SELECT * FROM transfer WHERE durum='BEKLIYOR' ORDER BY created_at, id LIMIT 1");
      if (!t) break;
      const kalemler = db
        .all('SELECT product_id, SUM(qty) AS q FROM transfer_line WHERE transfer_id=? GROUP BY product_id ORDER BY product_id', t.id)
        .map((l) => ({ stokno: Number(l.product_id), miktar: l.q }));
      const gonderim = t.kind === 'SEND';
      try {
        const yolda = gorunum.yolda || (await yoldaDepo(cfg));
        if (!yolda) throw new Error('Yoldaki depo (TRANSFER) belli değil');
        const r = await vega.transferYaz(cfg, {
          tip: gonderim ? 128 : 129,
          depo: gonderim ? t.from_depo : t.to_depo,
          karsi: gonderim ? t.to_depo : t.from_depo,
          yolda,
          kalemler,
          aciklama: `Depo terminali · ${t.device || ''} · ${t.user || ''}`.slice(0, 200),
        });
        db.run("UPDATE transfer SET durum='YAZILDI', vega_ind=?, belge_no=?, hata=NULL, yazildi_at=? WHERE id=?", r.ind, r.belgeNo, now(), t.id);
        log.bilgi(`Transfer Vega'ya yazıldı: ${gonderim ? 'gönderim 128' : 'kabul 129'} ${r.belgeNo} (${r.kalem} kalem, ${depo().depoAdi(t.from_depo)} → ${depo().depoAdi(t.to_depo)})${r.negatif ? `; gönderen depoda stoğu yetmeyen ${r.negatif} kart` : ''}`);
        // Gönderim Vega'da göründü; alan depodaki terminaller en geç bir sonraki okumada alır, hemen okuyalım.
        yenile().catch(() => {});
        depo().degisti();
      } catch (e) {
        const deneme = t.deneme + 1;
        const kalici = deneme >= DENEME_SINIRI;
        db.run('UPDATE transfer SET deneme=?, hata=?, durum=? WHERE id=?', deneme, String(e.message).slice(0, 500), kalici ? 'HATA' : 'BEKLIYOR', t.id);
        log.hata(`Transfer Vega'ya yazılamadı (${deneme}/${DENEME_SINIRI}): ${t.id}`, e);
        if (!kalici) {
          // Sıra bozulmasın: bu kayıt yazılana kadar sonrakilere geçilmez; kısa süre sonra yeniden.
          yaziciTetikle(Math.min(120000, 15000 * deneme));
          return;
        }
      }
    }
  } finally {
    yaziyor = false;
    if (tekrar) {
      tekrar = false;
      yaziciTetikle(0);
    }
  }
}

// ---- Mal kabul ile çakışma ------------------------------------------------------------------

/** Programın kendi yazdığı 129 fişleri mal kabulde ikinci kez rafa kaldırılacak belge olarak çıkmasın. */
function programKabulBelgeleri() {
  return new Set(
    db.all("SELECT vega_ind, to_depo FROM transfer WHERE kind='RECEIVE' AND vega_ind IS NOT NULL").map((r) => `D129-${r.vega_ind}-${r.to_depo}`),
  );
}

/**
 * Terminalden kabul edilen transferin rafa kaldırılacak belgesi. Mal kabul belgeleriyle aynı biçimde (vega.js goruntu.receipts);
 * satır miktarı alınan miktardır, rafla alınan kısım receipt_shelved'a yerleşmiş yazılır. Son 60 gün; sürüm sayacına göre saklanır.
 */
let fisOnbellek = { surum: -1, liste: [] };
function programKabulFisleri() {
  const sv = depo().surum();
  if (fisOnbellek.surum === sv) return fisOnbellek.liste;
  const bas = now() - 60 * 86400000;
  const satirlar = db.all(
    `SELECT t.id, t.from_depo, t.to_depo, t.sevk_no, t.belge_no, t.created_at, l.product_id, SUM(l.qty) AS q
     FROM transfer t JOIN transfer_line l ON l.transfer_id = t.id
     WHERE t.kind = 'RECEIVE' AND t.created_at >= ?
     GROUP BY t.id, l.product_id ORDER BY t.created_at, t.id, l.product_id`,
    bas,
  );
  const m = new Map();
  for (const r of satirlar) {
    if (!m.has(r.id)) {
      m.set(r.id, {
        id: `TRF-${r.id}`,
        izahat: 'D129',
        tur: 'Gönderim kabulü',
        docNo: String(r.belge_no || r.sevk_no || 'Gönderim').trim(),
        supplier: `${depo().depoAdi(r.from_depo)} deposundan`,
        date: tarihStr(new Date(r.created_at)),
        ts: r.created_at,
        depo: r.to_depo,
        depoAd: depo().depoAdi(r.to_depo),
        lines: [],
      });
    }
    m.get(r.id).lines.push({ id: `TRF-${r.id}-${r.product_id}`, productId: String(r.product_id), accepted: yuvarla(r.q) });
  }
  fisOnbellek = { surum: sv, liste: [...m.values()] };
  return fisOnbellek.liste;
}

// ---- Yönetici ekranı --------------------------------------------------------------------------

function liste(limit = 200) {
  const ad = (d) => depo().depoAdi(d);
  const transferler = db.all('SELECT * FROM transfer ORDER BY created_at DESC LIMIT ?', limit).map((t) => {
    const satirlar = db.all('SELECT product_id, qty, shelf FROM transfer_line WHERE transfer_id=? ORDER BY product_id, shelf', t.id).map((l) => {
      const u = depo().urun(l.product_id);
      return { ...l, kod: u?.code || l.product_id, ad: u?.name || '' };
    });
    return { ...t, fromAd: ad(t.from_depo), toAd: ad(t.to_depo), satirlar, toplam: yuvarla(satirlar.reduce((a, b) => a + b.qty, 0)) };
  });
  const farklar = db.all("SELECT * FROM transfer_fark ORDER BY (durum='ACIK') DESC, created_at DESC LIMIT 500").map((f) => {
    const u = depo().urun(f.product_id);
    return { ...f, kod: u?.code || f.product_id, ad: u?.name || '', fromAd: ad(f.from_depo), toAd: ad(f.to_depo) };
  });
  const acik = gorunum.sevkler.map((s) => ({
    ind: s.ind, no: s.no, tarih: tarihStr(s.tarih), fromAd: ad(s.kaynak), toAd: ad(s.hedef),
    satirlar: s.satirlar.map((l) => ({ ...l, kod: depo().urun(l.productId)?.code || l.productId })),
  }));
  const cfg = config.load();
  return {
    ayar: { aktif: Boolean(cfg.transfer?.aktif), yoldaDepo: cfg.transfer?.yoldaDepo ?? null, userno: cfg.transfer?.userno ?? null, onek: cfg.transfer?.onek || 'A', gun: cfg.transfer?.gun || 45 },
    yolda: gorunum.yolda,
    yoldaAd: gorunum.yolda ? ad(gorunum.yolda) : null,
    depolar: gorunum.depolar.map((d) => ({ ind: Number(d.ind), ad: d.ad })),
    okunma: gorunum.at || null,
    bekleyen: db.get("SELECT COUNT(*) AS n FROM transfer WHERE durum='BEKLIYOR'").n,
    hatali: db.get("SELECT COUNT(*) AS n FROM transfer WHERE durum='HATA'").n,
    acikFark: db.get("SELECT COUNT(*) AS n, COALESCE(SUM(eksik),0) AS q FROM transfer_fark WHERE durum='ACIK'"),
    transferler,
    farklar,
    acik,
  };
}

function yenidenDene(id) {
  const t = db.get("SELECT id FROM transfer WHERE id=? AND durum IN ('HATA','BEKLIYOR')", String(id));
  if (!t) return false;
  db.run("UPDATE transfer SET durum='BEKLIYOR', deneme=0, hata=NULL WHERE id=?", t.id);
  yaziciTetikle(0);
  return true;
}

/** Farkı çözülmüş işaretler. cozum: KAYIP (mal bulunamadı, kayıp kabul edildi) ya da BULUNDU (bulundu, Vega'da kabul edilecek). */
function farkCoz(id, cozum, not, kim) {
  if (!['KAYIP', 'BULUNDU'].includes(cozum)) throw new Error('Çözüm türü geçersiz');
  const f = db.get('SELECT id FROM transfer_fark WHERE id=?', Number(id));
  if (!f) return false;
  db.run('UPDATE transfer_fark SET durum=?, cozum=?, cozum_at=?, cozum_user=? WHERE id=?', cozum, String(not || '').slice(0, 300), now(), String(kim || ''), f.id);
  yenile().catch(() => {});
  return true;
}

function farkAc(id) {
  const f = db.get('SELECT id FROM transfer_fark WHERE id=?', Number(id));
  if (!f) return false;
  db.run("UPDATE transfer_fark SET durum='ACIK', cozum=NULL, cozum_at=NULL, cozum_user=NULL WHERE id=?", f.id);
  yenile().catch(() => {});
  return true;
}

/**
 * Yönetici, açık görünen bir gönderimi kapatır (örneğin Vega'da başka yoldan kabul edilmiş, hayalet kalmış). Kalan açık miktar
 * "kayıp" eksik olarak kaydedilir (neden: yönetici kapattı); böylece Vega toplamlarıyla tutarlı kalır ve izlenebilir.
 */
function acikKapat(ind, kim) {
  const s = gorunum.sevkler.find((x) => x.ind === Number(ind));
  if (!s) return false;
  db.tx(() => {
    const id = `ADMIN-${s.ind}`;
    for (const l of s.satirlar) {
      db.run(
        "INSERT INTO transfer_fark(transfer_id, sevk_ind, sevk_no, from_depo, to_depo, product_id, sent, received, eksik, user, device, created_at, durum, cozum, cozum_at, cozum_user) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'KAYIP', 'Yönetici gönderimi kapattı', ?, ?)",
        id, s.ind, s.no, s.kaynak, s.hedef, l.productId, l.open, 0, l.open, String(kim || 'yönetici'), 'PC', now(), now(), String(kim || 'yönetici'),
      );
    }
    db.run('INSERT OR IGNORE INTO transfer_kapali(sevk_ind, transfer_id, at) VALUES(?,?,?)', s.ind, id, now());
  });
  gorunum.sevkler = gorunum.sevkler.filter((x) => x.ind !== s.ind);
  depo().degisti();
  return true;
}

module.exports = {
  programKabulFisleri,
  acikKapat,
  uygula, yaz, yaziciTetikle, yenile, terminalGorunumu, programKabulBelgeleri, liste, yenidenDene, farkCoz, farkAc,
  yoldaDepo, tumDepolar,
  // Testler için
  _gorunum: (g) => { if (g) gorunum = { ...gorunum, ...g }; return gorunum; },
  _acikHesapla: acikHesapla,
};
