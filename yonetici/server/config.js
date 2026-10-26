// Ayarlar kullanıcı klasöründeki config.json'da durur (kurulum klasöründe değil: güncellemede silinmesin).
// Vega parolası düz yazılmaz: sabit anahtarla AES-256-GCM. Anahtar makineye bağlı değil; makine adı
// değişince ayarlar bozulmasın (vega_sorgu'da yaşandı).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY = crypto.createHash('sha256').update('ortas-depo-yonetici::v1').digest();

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
    baslangic: null, // YYYY-MM-DD; bundan eski belgeler gelmez (ilk açılışta bugün)
  },
  // Raf adresi Vega stok kartında: alan (KOD14 gibi) boşsa okunmaz. Bir kartta birden çok adres virgülle ayrılır.
  // Adresler `depo` deposunun raflarıdır (boş = varsayılan depo); ürün bu raflara zimmetlenir.
  // Varsayılan: yalnız programda tanımlı raf kodları alınır (alanda raf olmayan bilgi de olabilir).
  // yeniRafAc: tanımsız adres raf olarak açılsın (okuma). yaz: program alanın sahibi olur, zimmetleri karta yazar;
  // alandaki eski bilgi silinir (ilk değer vega_alan tablosunda saklanır). Ortaş: KOD10, yaz açık.
  rafAdresi: { alan: '', depo: null, yeniRafAc: false, yaz: false },
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
  if (!cfg.kabul.baslangic) {
    cfg.kabul.baslangic = new Date().toISOString().slice(0, 10);
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

module.exports = { init, load, save, update, publicView, parolaOzeti, parolaDogru, DEFAULTS };
