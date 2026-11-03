// Ayarlar kullanıcı klasöründeki config.json'da durur (kurulum klasöründe değil: güncellemede silinmesin).
// Vega parolası düz yazılmaz: sabit anahtarla AES-256-GCM. Anahtar makineye bağlı değil; makine adı
// değişince ayarlar bozulmasın (vega_sorgu'da yaşandı).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY = crypto.createHash('sha256').update('ortas-depo-yonetici::v1').digest();

// Terminaller bu tarihten itibaren gerçek işte kullanılıyor; öncesi test aşamasıydı (Said, 2026-11-03).
const MILAT = '2026-10-31';

const DEFAULTS = {
  port: 5480,
  vega: {
    server: 'localhost',
    port: '',
    database: 'VEGADB',
    user: 'sa',
    password: '',
    firma: null, // 101 gibi (TBLFIRMA.IND)
    donem: null, // null = yıla göre kendisi seçer
    depo: null, // varsayılan depo (F{firma}TBLDEPOLAR.IND): terminal ilk açılışta ve depo bilgisi gelmeyen işlemde
    depolar: [], // kullanılan depolar; boş = firmanın bütün depoları
  },
  // Mal kabul: hangi stok girişleri rafa kaldırılacak belge sayılır.
  kabul: {
    izahat: ['20', '26'], // 20 alış faturası, 26 alış irsaliyesi
    baslangic: MILAT, // YYYY-MM-DD (milat); bundan eski belgeler gelmez. Ortaş: terminaller 2026-10-31'den beri canlı, öncesi testti
    gun: 0, // ek olarak yalnız son N günün belgeleri (0 = kapalı, yalnız milat)
    milatSurum: 0, // 1 = milat bir kez uygulandı (eski kurulumun başlangıç tarihi MILAT'a çekildi)
  },
  // Raf adresi Vega stok kartında: alan (KOD14 gibi) boşsa okunmaz. Bir kartta birden çok adres virgülle ayrılır.
  // Adresler `depo` deposunun raflarıdır (boş = varsayılan depo); ürün bu raflara zimmetlenir.
  // Varsayılan: yalnız programda tanımlı raf kodları alınır (alanda raf olmayan bilgi de olabilir).
  // yeniRafAc: tanımsız adres raf olarak açılsın (okuma). yaz: program alanın sahibi olur, zimmetleri karta yazar;
  // alandaki eski bilgi silinir (ilk değer vega_alan tablosunda saklanır). Ortaş: KOD10, yaz açık.
  // tumDepolar: yazarken bütün depoların zimmetleri karta birlikte yazılır (terminal hangi depoda çalışırsa çalışsın
  // kartta görünür); kapalıysa yalnız `depo` deposununkiler.
  rafAdresi: { alan: '', depo: null, yeniRafAc: false, yaz: false, tumDepolar: true },
  // Depolar arası transfer (terminalden Vega'ya depo gönderim 128 / gönderim kabul 129 fişi yazılır).
  // aktif: ayar anahtarı, kapalıyken terminalde ekran görünmez ve işlem reddedilir. yoldaDepo: malın gönderimle kabul
  // arasında durduğu Vega deposu (Ortaş: 3 TRANSFER); boşsa adı TRANSFER olan depo. userno: fişe yazılan Vega kullanıcı
  // numarası; boşsa aynı türde en çok kullanılan. onek: belge numarası öneki (Ortaş: A0000575). gun: açık gönderim kaç gün geriye bakılır.
  // cift: transfer yapılabilen iki depo (Ortaş: [1, 108] Merkez ↔ Toybelen). Sunucu bu çift dışındaki gönderim ve kabulü
  // reddeder, açık gönderimleri yalnız bu çiftten okur; boşken özellik çalışmaz.
  transfer: { aktif: false, yoldaDepo: null, userno: null, onek: 'A', gun: 45, cift: [] },
  // Sanal bekleme depoları (Ortaş: 106, 109): mal fiziken `hedef` depoda durur, muhasebe fiyatlandırınca Vega'da 37 ile geçirir.
  // Açıkken bu depoların belgesi ve raf kaydı hedef depoda çalışır, grup içi 37 iş üretmez (bekleme.js). Yalnız Bekleme
  // depoları sayfasından açılır, çünkü açılırken raf kayıtları da hedefe taşınır. gecis: son açılışın özeti.
  bekleme: { aktif: false, depolar: [], hedef: null, gecis: null },
  // Terminale giden ürün listesi: 'aktif' = stoklu, son N günde hareketli ya da rafta olan kartlar.
  urun: { kapsam: 'aktif', gun: 365 },
  sayim: {
    onek: 'T', // Vega'ya yazılan sayım fişlerinin numara öneki; Vega'nın kendi serisiyle çakışmasın
    ozelkod1: null, // null = mevcut belgelerden okunur
    ozelkod2: null,
    userno: null,
  },
  // Etiket yazıcısı bu bilgisayara bağlı olandır; terminalden istenen etiket de buradan çıkar.
  etiket: {
    yazici: '', // boş = Windows varsayılan yazıcısı
    urunBicim: 'y-60x40',
    rafBicim: 'y-100x50',
    rafGoster: true, // ürün etiketine bulunduğu raf yazılsın
  },
  // Program verisinin yedeği (depo.db). Vega yedeği alınmaz. adet: tutulan en çok yedek, fazlası en eskiden silinir.
  yedek: { klasor: 'C:/ortaşdepo-yedekler', adet: 5 },
  yenileme: 60, // Vega'dan ana veri yenileme aralığı (sn)
  yoneticiParola: '', // scrypt özeti; boşsa program parolasız açılır
};

let dosya = null;
let cache = null;

function init(file) {
  dosya = file;
  cache = null;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  try {
    const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(dosya, 'utf8'));
  } catch {
    raw = {};
  }
  const cfg = merge(DEFAULTS, raw);
  cfg.vega.password = raw.vega && raw.vega.passwordEnc ? decrypt(raw.vega.passwordEnc) : '';
  delete cfg.vega.passwordEnc;
  if (!cfg.kabul.baslangic || cfg.kabul.milatSurum !== 1) {
    // 1.15.0: rafa bekleyen mal ürün bazlı; test dönemi belgeleri bir kez kesilir (sonra Ayarlar'dan değişebilir).
    cfg.kabul.baslangic = MILAT;
    cfg.kabul.gun = 0;
    cfg.kabul.milatSurum = 1;
    cache = cfg;
    save(cfg);
  }
  cache = cfg;
  return cfg;
}

function save(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  out.vega.passwordEnc = cfg.vega.password ? encrypt(cfg.vega.password) : '';
  delete out.vega.password;
  fs.mkdirSync(path.dirname(dosya), { recursive: true });
  fs.writeFileSync(dosya, JSON.stringify(out, null, 2), 'utf8');
  cache = cfg;
}

function update(patch) {
  const cfg = merge(load(), patch);
  save(cfg);
  return cfg;
}

// Arayüze parola gitmez.
function publicView(cfg = load()) {
  const v = JSON.parse(JSON.stringify(cfg));
  v.vega.hasPassword = Boolean(cfg.vega.password);
  delete v.vega.password;
  v.yoneticiParolaVar = Boolean(cfg.yoneticiParola);
  delete v.yoneticiParola;
  return v;
}

function parolaOzeti(parola) {
  const tuz = crypto.randomBytes(16);
  return `${tuz.toString('base64')}:${crypto.scryptSync(String(parola), tuz, 32).toString('base64')}`;
}

function parolaDogru(parola, cfg = load()) {
  if (!cfg.yoneticiParola) return true;
  const [tuz, ozet] = String(cfg.yoneticiParola).split(':');
  if (!tuz || !ozet || !parola) return false;
  const beklenen = Buffer.from(ozet, 'base64');
  const gelen = crypto.scryptSync(String(parola), Buffer.from(tuz, 'base64'), beklenen.length);
  return crypto.timingSafeEqual(beklenen, gelen);
}

/**
 * Mal kabulde gerçekten geçerli başlangıç tarihi (YYYY-MM-DD): ayardaki sabit başlangıç ile "son N gün" sınırından yeni olanı.
 * Gün sınırı her gün kayar; Vega okuması bu tarihle yapılır, eski açık kalanlar listeye girmez.
 */
function kabulBaslangic(cfg = load()) {
  const sabit = cfg.kabul?.baslangic || '2000-01-01';
  const gun = Math.max(0, Math.min(365, Math.floor(Number(cfg.kabul?.gun) || 0)));
  if (!gun) return sabit;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - gun);
  const yerel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return yerel > sabit ? yerel : sabit;
}

module.exports = { init, kabulBaslangic, load, save, update, publicView, parolaOzeti, parolaDogru, DEFAULTS };
