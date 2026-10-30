// Terminal kullanıcılarının yetkisi (1.9.0). İki ayrı sınır vardır:
//   izin  : kullanıcı hangi işlemleri yapabilir (rafa kaldır, raftan al, depoya gönder...)
//   depo  : kullanıcı hangi depolarda işlem yapabilir (Toybelen'deki kullanıcı Merkez'den mal çıkaramaz)
// Her ikisi `app_user` satırında tutulur: perms ve depots sütunları, '*' = hepsi, yoksa virgülle ayrılmış liste.
// Denetim sunucuda `depo.islemUygula` içinde yapılır; terminal aynı bilgiyi ana veriyle alıp menüyü ve seçimleri
// daraltır (arayüz kolaylığı), asıl sınır sunucudadır. Yönetici programı yetkiye tabi değildir.
//
// Sunucu işlemi yapan kullanıcıyı terminalin bildirdiği `payload.user`'dan alır; cihaz anahtarı doğrulanmış cihaza güvenilir,
// kullanıcının PIN'i işlem başına sınanmaz (kapsam: yanlışlıkla yapılan işlemler, kötü niyet değil).

/** Yetki kataloğu. `id` terminalde, sunucuda ve veritabanında aynıdır; değiştirilmez, yalnız eklenir. */
const IZINLER = [
  { id: 'putaway', grup: 'Mal giriş', ad: 'Rafa kaldır', not: 'Belgeli ve ürün okutarak rafa kaldırma' },
  { id: 'pick', grup: 'Raf işlemleri', ad: 'Raftan al', not: 'Raf stokunu eksiltir' },
  { id: 'transfer', grup: 'Raf işlemleri', ad: 'Raf transferi', not: 'Raftan rafa taşıma' },
  { id: 'shelf_add', grup: 'Raf işlemleri', ad: 'Terminalden raf ekle' },
  { id: 'home_remove', grup: 'Raf işlemleri', ad: 'Ürünün raf adresini sil' },
  { id: 'count', grup: 'Sayım', ad: 'Sayım gönder', not: 'Yönetici programında açılan sayıma raf sayımı gönderir' },
  { id: 'count_free', grup: 'Sayım', ad: 'Serbest sayım başlat', not: 'Terminalde kendiliğinden sayım açar' },
  { id: 'depot_send', grup: 'Depolar arası', ad: 'Depoya gönder', not: 'Vega\'ya depo gönderim fişi (128) yazılır' },
  { id: 'depot_receive', grup: 'Depolar arası', ad: 'Gönderim kabul', not: 'Vega\'ya gönderim kabul fişi (129) yazılır' },
  { id: 'label', grup: 'Diğer', ad: 'Etiket bas' },
  { id: 'queue_manage', grup: 'Diğer', ad: 'Bekleyen işlemleri yönet', not: 'Kuyruktaki hatalı işlemi yeniden dene / sil' },
];

const IZIN_AD = new Map(IZINLER.map((i) => [i.id, i.ad]));

/** Hazır izin kümeleri; yalnız formu doldurur, kayda `role` olarak yazılır ama geçerli olan kullanıcıdaki izin listesidir. */
const SABLONLAR = [
  { id: 'tam', ad: 'Tam yetkili', izinler: '*' },
  { id: 'depocu', ad: 'Depo görevlisi', izinler: ['putaway', 'pick', 'transfer', 'shelf_add', 'home_remove', 'count', 'label', 'queue_manage'] },
  { id: 'sube', ad: 'Şube deposu (kendi deposu)', izinler: ['putaway', 'pick', 'transfer', 'count', 'depot_send', 'depot_receive', 'label'] },
  { id: 'sevkiyat', ad: 'Sevkiyat', izinler: ['pick', 'transfer', 'depot_send', 'depot_receive', 'label'] },
  { id: 'sayim', ad: 'Sayım', izinler: ['count', 'count_free'] },
  { id: 'sorgu', ad: 'Yalnız sorgu', izinler: [] },
];

const SABLON_ID = new Set(SABLONLAR.map((s) => s.id));

/** İşlem türü → gereken izin. COUNT_SUBMIT ayrıca serbest sayım için `count_free` ister (bkz. denetle). */
const ISLEM_IZNI = {
  PUTAWAY: 'putaway',
  PICK: 'pick',
  TRANSFER: 'transfer',
  SHELF_ADD: 'shelf_add',
  HOME_REMOVE: 'home_remove',
  COUNT_SUBMIT: 'count',
  TRANSFER_SEND: 'depot_send',
  TRANSFER_RECEIVE: 'depot_receive',
};

function hata(mesaj) {
  return Object.assign(new Error(mesaj), { status: 400 });
}

/** Liste metnini ('*' ya da "a,b") normalleştirir: sıralı, tekrarsız. '*' ya da boş liste ayrı anlam taşır (hepsi / hiçbiri). */
function metinListe(x) {
  if (x === '*' || x === null || x === undefined) return '*';
  const dizi = Array.isArray(x) ? x : String(x).split(',');
  return [...new Set(dizi.map((s) => String(s).trim()).filter(Boolean))].sort().join(',') || '';
}

/** Yönetici arayüzünden gelen izin listesini doğrular ('*' ya da bilinen kimlikler); kayıt metnini döner. */
function izinlerDogrula(x) {
  const m = metinListe(x);
  if (m === '*') return '*';
  const bilinmeyen = m.split(',').filter((i) => i && !IZIN_AD.has(i));
  if (bilinmeyen.length) throw hata(`Bilinmeyen izin: ${bilinmeyen.join(', ')}`);
  return m;
}

/** Depo listesini doğrular ('*' ya da tam sayı depo numaraları). */
function depolariDogrula(x) {
  const m = metinListe(x);
  if (m === '*') return '*';
  const parcalar = m.split(',').filter(Boolean);
  if (parcalar.some((d) => !/^\d+$/.test(d))) throw hata('Depo numarası geçersiz');
  return [...new Set(parcalar.map(Number))].sort((a, b) => a - b).join(',');
}

function rolDogrula(x) {
  const r = String(x || '').trim();
  return SABLON_ID.has(r) ? r : 'ozel';
}

/** Kayıt metni → Set; '*' → null (sınırsız). */
function kume(metin, sayisal = false) {
  const m = String(metin ?? '*').trim();
  if (m === '*') return null;
  const parcalar = m.split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(sayisal ? parcalar.map(Number) : parcalar);
}

/**
 * app_user satırından yetki nesnesi. Satır yoksa (bilinmeyen kullanıcı adı, eski kayıt) null döner: sınırsız sayılır,
 * çünkü kullanıcı sonradan silinse bile kuyruktaki işi kaybolmamalı.
 */
function baglam(satir, depoAdi = (d) => String(d)) {
  if (!satir) return null;
  const izinler = kume(satir.perms);
  const depolar = kume(satir.depots, true);
  const kim = satir.username;
  return {
    kullanici: kim,
    izinler,
    depolar,
    izinVar: (id) => !izinler || izinler.has(id),
    depoVar: (d) => !depolar || depolar.has(Number(d)),
    /** Reddedilecekse kullanıcıya gösterilecek metin, yoksa null. */
    denetle(izin, depo = null) {
      if (izin && izinler && !izinler.has(izin)) return `${kim} bu işlemi yapamaz: "${IZIN_AD.get(izin) || izin}" yetkisi yok`;
      if (depo !== null && depo !== undefined && depolar && !depolar.has(Number(depo))) {
        const izinli = [...depolar].map((d) => depoAdi(d)).join(', ') || 'hiçbir depo';
        return `${kim} ${depoAdi(depo)} deposunda işlem yapamaz (yetkili depo: ${izinli})`;
      }
      return null;
    },
  };
}

/** Ana veriyle terminale giden hali: null = sınırsız. */
function terminalGorunumu(satir) {
  const izinler = kume(satir.perms);
  const depolar = kume(satir.depots, true);
  return {
    role: satir.role || 'tam',
    perms: izinler ? [...izinler].sort() : null,
    depots: depolar ? [...depolar].sort((a, b) => a - b) : null,
  };
}

module.exports = { IZINLER, SABLONLAR, ISLEM_IZNI, metinListe, izinlerDogrula, depolariDogrula, rolDogrula, baglam, terminalGorunumu };
