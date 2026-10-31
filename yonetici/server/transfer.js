// Depolar arası transfer. Terminalden iki işlem gelir:
//   TRANSFER_SEND    → gönderen depoda raf stoku düşer; Vega'ya depo gönderim fişi (128) yazılır.
//   TRANSFER_RECEIVE → alan depoda mal rafa girer; Vega'ya gönderim kabul fişi (129) yazılır; gelmeyen miktar (eksik)
//                      transfer_fark'ta çözülene kadar kayıtlı kalır, gönderim terminallerde kapanır.
// Vega'ya yazım terminali beklemez: işlem hemen kabul edilir, fiş arka planda yazılır (bekleyen kayıtlar `transfer`
// tablosunda, hata olursa yeniden denenir, 5 denemeden sonra yönetici ekranından elle). Fişin yapısı vega.js transferYaz.
//
// Transfer yalnız ayarlardaki iki depo (transfer.cift) arasında yapılır; sunucu başka çifti reddeder, Vega'dan yalnız bu çifti okur.
// Gönderimde ürün raf stoku olan depodan çıkıyorsa raftan düşer (gonderUygula); raf stoku olmayan ürün "rafsız" geçer.
// Kabulde raf yoktur: mal alan depoda Rafa Kaldır ekranında belge (TRF-) olarak bekler. Kabul kısmi de yapılabilir (partial).
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

/** Transfer yapılabilen iki depo (ayarda); seçilmemişse null. */
function cift(cfg = config.load()) {
  const c = Array.isArray(cfg.transfer?.cift) ? cfg.transfer.cift.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  return c.length === 2 && c[0] !== c[1] ? c : null;
}

// ---- Açık gönderimler (Vega'dan) --------------------------------------------------------------

let gorunum = { at: 0, okumaBasi: 0, yolda: null, depolar: [], sevkler: [], ozet: '' };
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
  // Kabulü bitirilen gönderimin kapanıştaki satır miktarları. Kapanan belge tümden gizlenmez: Vega'da belgeye sonradan eklenen
  // satır ya da artan miktar (kapanıştan fazlası) yeniden açık görünür, "bulundu" işaretlenen eksik de. Kapanış kaydı olmayan
  // eski kapanışta fazla = bütün satır; havuzda mal kalmadıysa (kabul edilmiş ya da eksik kayıtlı) zaten açık miktar çıkmaz.
  const kapanis = new Map();
  for (const r of db.all('SELECT sevk_ind, product_id, sent FROM transfer_kapali_satir')) {
    if (!kapanis.has(r.sevk_ind)) kapanis.set(r.sevk_ind, new Map());
    kapanis.get(r.sevk_ind).set(r.product_id, r.sent);
  }
  // Programda kayıtlı eksik (açık ya da kayıp diye çözülmüş) havuzdan düşer; "bulundu" Vega'da kabul edilir, düşmez.
  const fark = new Map();
  for (const f of db.all("SELECT from_depo, to_depo, product_id, eksik FROM transfer_fark WHERE durum<>'BULUNDU' AND created_at >= ?", bas.getTime())) {
    const k = `${f.from_depo}|${f.to_depo}|${f.product_id}`;
    fark.set(k, (fark.get(k) || 0) + f.eksik);
  }
  // Terminalden kabul edilip Vega'ya henüz yazılmamış (ya da okumanın başladığı andan sonra yazılmış, okumaya girmemiş olabilir)
  // miktar da havuzdan düşer; yoksa kısmi kabul sonrası aynı mal ikinci kez kabul edilebilirdi.
  const bekleyen = new Map();
  for (const r of db.all(
    `SELECT t.from_depo, t.to_depo, l.product_id, SUM(l.qty) AS q FROM transfer t JOIN transfer_line l ON l.transfer_id = t.id
     WHERE t.kind = 'RECEIVE' AND t.created_at >= ? AND t.durum <> 'GERI' AND (t.durum <> 'YAZILDI' OR t.yazildi_at > ?)
     GROUP BY t.from_depo, t.to_depo, l.product_id`,
    bas.getTime(), gorunum.okumaBasi || 0,
  )) {
    bekleyen.set(`${r.from_depo}|${r.to_depo}|${r.product_id}`, r.q);
  }
  const c = cift();
  const ciftte = (s) => !c || (c.includes(s.kaynak) && c.includes(s.hedef) && s.kaynak !== s.hedef);
  const bakiye = new Map();
  for (const h of oku.havuz) {
    const k = `${h.kaynak}|${h.hedef}|${h.stokno}`;
    bakiye.set(k, Math.max(0, yuvarla(h.gonderilen - h.alinan - (fark.get(k) || 0) - (bekleyen.get(k) || 0))));
  }
  const sevkler = [...oku.sevkler]
    .filter(ciftte)
    .map((s) => {
      // `tam`: belgenin Vega'daki bütün satırları (kapatırken kaydedilir); `kalemler`: açık görünecek aday satırlar.
      const tam = s.kalemler;
      if (!kapali.has(s.ind)) return { ...s, tam };
      const eski = kapanis.get(s.ind) || new Map();
      const kalemler = tam.map((k) => ({ stokno: k.stokno, miktar: yuvarla(k.miktar - (eski.get(String(k.stokno)) || 0)) })).filter((k) => k.miktar > EPS);
      return kalemler.length ? { ...s, kalemler, tam } : null;
    })
    .filter(Boolean)
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
    const c = cift(cfg);
    const bas = baslangic(cfg);
    const okumaBasi = now();
    // Çift seçilmemişse hiçbir şey okunmaz (özellik çalışmaz); seçiliyse yalnız bu iki depo arasındaki belgeler.
    const oku = c ? await vega.transferOku(cfg, { bas, alanlar: c, kaynaklar: c }) : { sevkler: [], havuz: [] };
    gorunum.okumaBasi = okumaBasi;
    const sevkler = acikHesapla(oku, bas);
    const ozet = JSON.stringify([yolda, c, tum.map((d) => [d.ind, d.ad]), sevkler.map((s) => [s.ind, s.satirlar])]);
    const degisti = ozet !== gorunum.ozet;
    gorunum = { at: now(), okumaBasi, yolda, depolar: tum, sevkler, ozet };
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
  const c = cift(cfg);
  return {
    on: Boolean(gorunum.yolda && c),
    yolda: gorunum.yolda,
    // Terminal çıkış deposunu bu ikiliden sorar; varış diğeridir. (1.6.x terminaller de bunu varış listesi sayar.)
    depots: c ? c.map((id) => ({ id, name: ad(id) })) : [],
    pair: c || [],
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

function satirlariOku(p, Ret, bilinen, { bosOlur = false } = {}) {
  const satirlar = [];
  for (const l of Array.isArray(p.lines) ? p.lines : []) {
    const pid = String(l.productId || '');
    const qty = Number(l.qty);
    if (!pid || !(qty > 0)) throw new Ret('Satırda ürün ya da miktar geçersiz');
    bilinen(pid);
    satirlar.push({ pid, qty: yuvarla(qty), shelf: depo().rafKodu(l.shelf) });
  }
  if (!satirlar.length && !bosOlur) throw new Ret('Transferde satır yok');
  return satirlar;
}

function ac(cfg, Ret) {
  // Sunucu yeni açıldıysa açık gönderim listesi henüz okunmamıştır: kalıcı ret değil, işlem terminalde bekler ve yeniden gelir.
  if (cfg.transfer?.aktif && !gorunum.at) throw new Error('Transfer verisi henüz okunmadı');
  if (!cfg.transfer?.aktif) throw new Ret('Depolar arası transfer yönetici programında açık değil (Ayarlar › Depolar arası transfer)');
  if (!gorunum.yolda) throw new Ret('Yoldaki depo (TRANSFER) belli değil; Ayarlar › Depolar arası transfer');
  const c = cift(cfg);
  if (!c) throw new Ret('Transfer yapılacak iki depo seçilmemiş (Ayarlar › Depolar arası transfer)');
  return c;
}

const ciftAdi = (c) => `${depo().depoAdi(c[0])} ↔ ${depo().depoAdi(c[1])}`;

/**
 * Gönderimde bir ürünün çıkış deposundaki raflardan düşülmesi. Terminal raf seçtiyse o raflardan düşer. Rafsız satır
 * (terminal raf stoku olmadığını sanmıştı: eski sürüm, çevrimdışı eşitleme) için sunucu son sözü söyler: ürünün çıkış
 * deposunda hâlâ raf stoku varsa eksiği kendisi düşer — önce ürünün asıl rafı (zimmet), sonra en çok stoklu raf; hareket
 * notuna "raf otomatik seçildi" yazılır. Raf stoku yetmezse işlem reddedilmez: raflar sıfıra çekilir, kalan rafsız geçer ve
 * not düşülür (mal fiziken gitmiştir). Rafta stoğu olmayan ürünün rafsız miktarı olduğu gibi geçer.
 * Dönen: transfer_line'a yazılacak satırlar.
 */
function gonderRafla(from, to, pid, raflar, rafsiz, h, izinli = () => true) {
  const d = depo();
  const out = [];
  const hedef = d.depoAdi(to);
  for (const [shelf, q] of raflar) {
    const vardi = d.miktar(from, pid, shelf);
    const not = q - vardi > EPS ? ` · rafta ${vardi} vardı, ${yuvarla(q - vardi)} fazlası da gitti` : '';
    d.miktarEkle(from, pid, shelf, -q, { ...h, kind: 'TRANSFER_OUT_DEPO', ref: `→ ${hedef}${not}` });
    if (d.miktar(from, pid, shelf) <= EPS) d.terminalZimmetBosalt(from, pid, shelf);
    out.push({ shelf, qty: q, otomatik: 0 });
  }
  let kalan = rafsiz;
  if (kalan > EPS) {
    const asil = d.zimmetler(from, pid).map((z) => z.shelf);
    // Raf sınırı olan kullanıcının görmediği rafa dokunulmaz (kalan rafsız geçer, mal fiziken gitmiştir).
    const stoklu = db.all('SELECT shelf, qty FROM location WHERE depo=? AND product_id=? AND qty>0', from, pid).filter((r) => izinli(r.shelf));
    stoklu.sort((a, b) => (asil.includes(b.shelf) - asil.includes(a.shelf)) || b.qty - a.qty || (a.shelf < b.shelf ? -1 : 1));
    for (const r of stoklu) {
      if (kalan <= EPS) break;
      const al = yuvarla(Math.min(kalan, r.qty));
      kalan = yuvarla(kalan - al);
      const yetmedi = kalan > EPS && r === stoklu[stoklu.length - 1] ? ` (raf stoku yetmedi, ${kalan} rafsız geçti)` : '';
      d.miktarEkle(from, pid, r.shelf, -al, { ...h, kind: 'TRANSFER_OUT_DEPO', ref: `→ ${hedef} · raf otomatik seçildi${yetmedi}` });
      if (d.miktar(from, pid, r.shelf) <= EPS) d.terminalZimmetBosalt(from, pid, r.shelf);
      out.push({ shelf: r.shelf, qty: al, otomatik: 1 });
    }
  }
  if (kalan > EPS) out.push({ shelf: '', qty: yuvarla(kalan), otomatik: 0 });
  return out;
}

function gonderUygula(op, p, h, { Ret, bilinen, yetkiDenetle = () => {}, rafIzinli = () => true }) {
  const cfg = config.load();
  const c = ac(cfg, Ret);
  const from = kur(p, 'from');
  const to = kur(p, 'to');
  if (from === null || to === null) throw new Ret('Gönderen ya da alan depo yok');
  if (from === to) throw new Ret('Gönderen ve alan depo aynı');
  // Mal gönderen depodan çıkar: kullanıcı o depoda çalışabiliyor olmalı (Toybelen kullanıcısı Merkez'den gönderemez).
  yetkiDenetle(null, from);
  if (!c.includes(from) || !c.includes(to)) throw new Ret(`Transfer yalnız ${ciftAdi(c)} arasında yapılır`);
  if (from === gorunum.yolda || to === gorunum.yolda) throw new Ret('Yoldaki depo gönderen ya da alan olamaz');
  if (!gorunum.depolar.some((d) => Number(d.ind) === to) || !gorunum.depolar.some((d) => Number(d.ind) === from)) throw new Ret('Depo Vega\'da bulunamadı');
  const satirlar = satirlariOku(p, Ret, bilinen);
  // Raf sınırı: terminalin seçtiği raflar kullanıcının sınırı içinde olmalı.
  for (const l of satirlar) if (l.shelf) yetkiDenetle(null, from, l.shelf);
  // Ürün başına: terminalin seçtiği raflar ve rafsız miktar.
  const urunler = new Map();
  for (const l of satirlar) {
    if (!urunler.has(l.pid)) urunler.set(l.pid, { raflar: new Map(), rafsiz: 0 });
    const u = urunler.get(l.pid);
    if (l.shelf) u.raflar.set(l.shelf, yuvarla((u.raflar.get(l.shelf) || 0) + l.qty));
    else u.rafsiz = yuvarla(u.rafsiz + l.qty);
  }
  const yazilacak = [];
  for (const [pid, u] of urunler) {
    for (const s of gonderRafla(from, to, pid, u.raflar, u.rafsiz, h, rafIzinli)) yazilacak.push({ pid, ...s });
  }
  db.run('INSERT INTO transfer(id, kind, from_depo, to_depo, user, device, created_at) VALUES(?,?,?,?,?,?,?)', op.id, 'SEND', from, to, h.user, h.device, now());
  for (const l of yazilacak) {
    db.run(
      'INSERT INTO transfer_line(transfer_id, product_id, qty, shelf, otomatik) VALUES(?,?,?,?,?) ON CONFLICT(transfer_id, product_id, shelf) DO UPDATE SET qty = qty + excluded.qty',
      op.id, l.pid, l.qty, l.shelf, l.otomatik,
    );
  }
}

function kabulUygula(op, p, h, { Ret, bilinen, yetkiDenetle = () => {} }) {
  const cfg = config.load();
  const c = ac(cfg, Ret);
  const sevk = gorunum.sevkler.find((s) => String(s.ind) === String(p.sevkId));
  if (!sevk) {
    if (db.get('SELECT 1 FROM transfer_kapali WHERE sevk_ind=?', Number(p.sevkId))) throw new Ret('Bu gönderimin kabulü daha önce tamamlandı');
    throw new Ret('Gönderim açık görünmüyor (kabul edilmiş, iptal edilmiş ya da Vega henüz okunmamış olabilir)');
  }
  if (!c.includes(sevk.kaynak) || !c.includes(sevk.hedef)) throw new Ret(`Transfer yalnız ${ciftAdi(c)} arasında yapılır`);
  // Mal alan depoya girer: kullanıcı o depoda çalışabiliyor olmalı.
  yetkiDenetle(null, sevk.hedef);
  // partial: kısmi kabul — okutulanlar alınır, gönderim açık kalır, eksik kaydı açılmaz. Eksik yalnız "Kabulü bitir" ile (partial değil) açılır;
  // önceden kısmi alınmış gönderimde bitirirken yeni satır olmayabilir (kalan hepsi eksik olur).
  const kismi = p.partial === true || p.partial === 1 || p.partial === 'true';
  const oncekiKismi = Boolean(db.get("SELECT 1 FROM transfer WHERE kind='RECEIVE' AND sevk_ind=? AND kismi=1", sevk.ind));
  const satirlar = satirlariOku(p, Ret, bilinen, { bosOlur: !kismi && oncekiKismi });
  for (const l of satirlar) if (l.shelf) yetkiDenetle(null, sevk.hedef, l.shelf);
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
  // Yazılacak satır yoksa (kısmi alınmışın ardından boş bitirme) Vega'ya yazılacak bir şey de yoktur.
  db.run(
    'INSERT INTO transfer(id, kind, from_depo, to_depo, sevk_ind, sevk_no, user, device, created_at, kismi, durum, yazildi_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    op.id, 'RECEIVE', from, to, sevk.ind, sevk.no, h.user, h.device, now(), kismi ? 1 : 0, satirlar.length ? 'BEKLIYOR' : 'YAZILDI', satirlar.length ? null : now(),
  );
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
  fisOnbellek.surum = -1;
  if (kismi) {
    // Gönderim açık kalır; alınan kadarı terminallere gidecek açık miktardan düşer (Vega okuması beklenmeden).
    for (const s of gorunum.sevkler) {
      if (s.ind !== sevk.ind) continue;
      s.satirlar = s.satirlar
        .map((l) => ({ ...l, open: yuvarla(l.open - (gelen.get(l.productId) || 0)) }))
        .filter((l) => l.open > EPS);
    }
    gorunum.sevkler = gorunum.sevkler.filter((s) => s.satirlar.length);
    return;
  }
  // Gelmeyen miktar kayıtlı kalır; gönderim terminallerde kapanır (belge açık kalmaz).
  const gonderilen = new Map(sevk.satirlar.map((l) => [l.productId, l.sent]));
  for (const [pid, beklenen] of acik) {
    const alinan = gelen.get(pid) || 0;
    const eksik = yuvarla(beklenen - alinan);
    if (eksik > EPS) {
      // Gönderilen miktar fişteki, alınan = gönderilen − eksik (önceki kısmi kabuller de alınmış sayılır).
      const sent = gonderilen.get(pid) ?? beklenen;
      db.run(
        'INSERT INTO transfer_fark(transfer_id, sevk_ind, sevk_no, from_depo, to_depo, product_id, sent, received, eksik, user, device, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        op.id, sevk.ind, sevk.no, from, to, pid, sent, yuvarla(sent - eksik), eksik, h.user, h.device, now(),
      );
    }
  }
  kapat(sevk, op.id);
  gorunum.sevkler = gorunum.sevkler.filter((s) => s.ind !== sevk.ind);
}

/**
 * Gönderimi kapalı işaretler ve belgenin o andaki satır miktarlarını saklar. Vega'da belgeye sonradan eklenen satır
 * kapanıştan fazla olarak yeniden açık görünür (acikHesapla). Yeniden açılıp tekrar kapatılan belge de güncellenir.
 */
function kapat(sevk, transferId) {
  db.run('INSERT OR REPLACE INTO transfer_kapali(sevk_ind, transfer_id, at) VALUES(?,?,?)', sevk.ind, transferId, now());
  db.run('DELETE FROM transfer_kapali_satir WHERE sevk_ind=?', sevk.ind);
  for (const k of sevk.tam || sevk.kalemler || []) {
    db.run(
      'INSERT INTO transfer_kapali_satir(sevk_ind, product_id, sent) VALUES(?,?,?) ON CONFLICT(sevk_ind, product_id) DO UPDATE SET sent = sent + excluded.sent',
      sevk.ind, String(k.stokno), yuvarla(k.miktar),
    );
  }
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
        db.run("UPDATE transfer SET durum='YAZILDI', vega_ind=?, belge_no=?, firma_donem=?, hata=NULL, yazildi_at=? WHERE id=?", r.ind, r.belgeNo, r.firmaDonem || null, now(), t.id);
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
    db.all("SELECT vega_ind, to_depo FROM transfer WHERE kind='RECEIVE' AND vega_ind IS NOT NULL AND durum<>'GERI'").map((r) => `D129-${r.vega_ind}-${r.to_depo}`),
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
     WHERE t.kind = 'RECEIVE' AND t.created_at >= ? AND t.durum <> 'GERI'
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
    const satirlar = db.all('SELECT product_id, qty, shelf, otomatik FROM transfer_line WHERE transfer_id=? ORDER BY product_id, shelf', t.id).map((l) => {
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
    ayar: { aktif: Boolean(cfg.transfer?.aktif), yoldaDepo: cfg.transfer?.yoldaDepo ?? null, userno: cfg.transfer?.userno ?? null, onek: cfg.transfer?.onek || 'A', gun: cfg.transfer?.gun || 45, cift: cift(cfg) || [] },
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
  const f = db.get('SELECT id, sevk_ind, product_id FROM transfer_fark WHERE id=?', Number(id));
  if (!f) return false;
  db.tx(() => {
    db.run('UPDATE transfer_fark SET durum=?, cozum=?, cozum_at=?, cozum_user=? WHERE id=?', cozum, String(not || '').slice(0, 300), now(), String(kim || ''), f.id);
    // Bulundu: eksik artık havuzdan düşmez; kapalı gönderimin o ürünü yeniden açık görünsün (kapanış kaydı o ürün için kalkar).
    if (cozum === 'BULUNDU' && f.sevk_ind != null) db.run('DELETE FROM transfer_kapali_satir WHERE sevk_ind=? AND product_id=?', f.sevk_ind, String(f.product_id));
  });
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
    kapat(s, id);
  });
  gorunum.sevkler = gorunum.sevkler.filter((x) => x.ind !== s.ind);
  depo().degisti();
  return true;
}

// ---- Geri alma (yalnız yönetici) ---------------------------------------------------------------

const hataYap = (mesaj, status = 400) => Object.assign(new Error(mesaj), { status });

/**
 * Yönetici, terminalden gelen bir transferi geri alır (yanlış depodan gönderim, yanlış kabul):
 *  - Fiş Vega'ya henüz yazılmamışsa (BEKLIYOR / HATA) yalnız programdaki etkisi geri alınır, fiş hiç yazılmaz.
 *  - Yazılmışsa Vega'daki fiş (128/129) silinir (vega.transferGeriAl: başlık, satır, envanter) ve programdaki etkisi geri alınır.
 * Gönderimde (128) raflardan düşen miktar rafa geri konur; kabulde (129) rafa giren miktar düşülür, gelmeyen miktar
 * (eksik) kaydı silinir ve gönderim terminallerde yeniden açılır. Kabulü başlamış bir gönderim geri alınmaz: önce kabul geri alınmalı.
 * Dönen: { belgeNo, vegaSilindi, uyarilar }.
 */
async function geriAl(id, kim = 'yönetici', not = '') {
  const t = db.get('SELECT * FROM transfer WHERE id=?', String(id));
  if (!t) throw hataYap('Transfer kaydı bulunamadı', 404);
  if (t.durum === 'GERI') throw hataYap('Bu transfer zaten geri alınmış');
  const gonderim = t.kind === 'SEND';
  const cfg = config.load();
  if (t.durum === 'BEKLIYOR' && yaziyor) throw hataYap('Fiş şu an Vega\'ya yazılıyor; birkaç saniye sonra yeniden deneyin');
  const satirlar = db.all('SELECT product_id, qty, shelf FROM transfer_line WHERE transfer_id=? ORDER BY product_id, shelf', t.id);
  const kodu = (pid) => depo().urun(pid)?.code || pid;
  // Yazılacak satırı olmayan kabul (kısmi kabulün ardından boş bitirme) YAZILDI görünür ama Vega'da fişi yoktur.
  const yazilmis = t.durum === 'YAZILDI' && Number.isInteger(t.vega_ind);
  if (t.durum === 'YAZILDI' && !yazilmis && satirlar.length) throw hataYap('Fişin Vega numarası kayıtlı değil; Vega\'da elle silin');

  if (yazilmis) {
    if (!cfg.transfer?.aktif || !vega.hazirMi(cfg.vega)) throw hataYap('Vega bağlantısı ya da transfer ayarı kapalı; fiş geri alınamaz');
    if (gonderim) {
      // Gönderimin hiç kabul edilmemiş olması şart: kabul edilen mal alan depoda rafa girmiş olabilir. Güncel durumu Vega'dan okuyup bakılır.
      await yenile();
      const sevk = gorunum.sevkler.find((s) => s.ind === t.vega_ind);
      if (!sevk) throw hataYap(`${t.belge_no || 'Gönderim'} açık görünmüyor (kabul edilmiş, kapatılmış ya da Vega okunamamış). Kabulü varsa önce kabulü geri alın`);
      const gonderilen = new Map();
      for (const l of satirlar) gonderilen.set(l.product_id, yuvarla((gonderilen.get(l.product_id) || 0) + l.qty));
      for (const [pid, q] of gonderilen) {
        const acik = sevk.satirlar.find((l) => l.productId === pid)?.open || 0;
        if (acik + EPS < q) throw hataYap(`${kodu(pid)} için gönderimin ${yuvarla(q - acik)} adedi kabul edilmiş; önce kabul fişini geri alın`);
      }
    }
    // Aynı fişin kabulden önce silinmesi: bu gönderime bağlı bir kabul programda kayıtlıysa onu önce geri almak gerekir (yukarıdaki açık miktar denetimi bunu yakalar).
    await vega.transferGeriAl(cfg, { tip: gonderim ? 128 : 129, ind: t.vega_ind, belgeNo: t.belge_no, firmaDonem: t.firma_donem });
  }

  const uyarilar = [];
  const h = { ts: now(), user: kim, device: 'PC' };
  const d = depo();
  const ref = `${t.belge_no || t.id} geri alındı`;
  try {
    db.tx(() => {
      if (gonderim) {
        // Gönderimde raflardan düşen miktar geri konur; rafsız satırın programda raf stoku yoktu.
        for (const l of satirlar) {
          if (!l.shelf) continue;
          d.miktarEkle(t.from_depo, l.product_id, l.shelf, l.qty, { ...h, kind: 'TRANSFER_GERI', ref });
          d.terminalZimmet(t.from_depo, l.product_id, l.shelf);
        }
      } else {
        const rafliToplam = satirlar.filter((l) => l.shelf).reduce((a, l) => a + l.qty, 0);
        for (const l of satirlar) {
          if (!l.shelf) continue;
          const mevcut = d.miktar(t.to_depo, l.product_id, l.shelf);
          const al = Math.min(mevcut, l.qty);
          if (al > EPS) d.miktarEkle(t.to_depo, l.product_id, l.shelf, -al, { ...h, kind: 'TRANSFER_GERI', ref });
          if (l.qty - al > EPS) uyarilar.push(`${kodu(l.product_id)} · ${l.shelf}: ${l.qty} adet girmişti, rafta ${mevcut} vardı, ${yuvarla(al)} düşüldü`);
          if (d.miktar(t.to_depo, l.product_id, l.shelf) <= EPS) d.terminalZimmetBosalt(t.to_depo, l.product_id, l.shelf);
        }
        // Belge olarak rafa kaldırılacak miktar (rafsız alınanlar) kalkar; sonradan rafa kaldırılmış kısım raf stokunda kalır, elle düzeltilir.
        const rafaKalkan = Number(db.get('SELECT COALESCE(SUM(shelved),0) AS q FROM receipt_shelved WHERE receipt_id=?', `TRF-${t.id}`).q);
        if (rafaKalkan - rafliToplam > EPS) uyarilar.push(`Rafsız alınan ${yuvarla(rafaKalkan - rafliToplam)} adet sonradan rafa kaldırılmıştı; o rafların stokunu Raflar sayfasından düzeltin`);
        db.run('DELETE FROM receipt_shelved WHERE receipt_id=?', `TRF-${t.id}`);
        // Kabulde açılan eksik kayıtları ve "kabulü bitti" işareti de kalkar: gönderim yeniden açık görünür.
        db.run('DELETE FROM transfer_fark WHERE transfer_id=?', t.id);
        const kapanan = db.get('SELECT sevk_ind FROM transfer_kapali WHERE transfer_id=?', t.id);
        if (kapanan) db.run('DELETE FROM transfer_kapali_satir WHERE sevk_ind=?', kapanan.sevk_ind);
        db.run('DELETE FROM transfer_kapali WHERE transfer_id=?', t.id);
      }
      db.run("UPDATE transfer SET durum='GERI', geri_at=?, geri_user=?, geri_not=?, hata=NULL WHERE id=?", now(), String(kim || ''), String(not || '').slice(0, 300) || null, t.id);
    });
  } catch (e) {
    if (yazilmis) log.hata(`Transfer ${t.belge_no} Vega'dan silindi ama program kaydı geri alınamadı (${t.id}); elle düzeltin`, e);
    throw e;
  }
  fisOnbellek.surum = -1;
  log.bilgi(`Transfer geri alındı: ${gonderim ? 'gönderim' : 'kabul'} ${t.belge_no || t.id} (${depo().depoAdi(t.from_depo)} → ${depo().depoAdi(t.to_depo)}) · ${kim}${yazilmis ? ' · Vega fişi silindi' : ' · Vega\'ya yazılmamıştı'}${uyarilar.length ? ' · ' + uyarilar.join('; ') : ''}`);
  depo().degisti();
  if (yazilmis) yenile().catch(() => {});
  return { belgeNo: t.belge_no || null, vegaSilindi: yazilmis, uyarilar };
}

module.exports = {
  programKabulFisleri,
  acikKapat,
  geriAl,
  uygula, yaz, yaziciTetikle, yenile, terminalGorunumu, programKabulBelgeleri, liste, yenidenDene, farkCoz, farkAc,
  yoldaDepo, tumDepolar, cift,
  // Testler için
  _gorunum: (g) => { if (g) gorunum = { ...gorunum, ...g }; return gorunum; },
  _acikHesapla: acikHesapla,
};
