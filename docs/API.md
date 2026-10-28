# Terminal ↔ sunucu sözleşmesi

Terminal uygulaması (Android) yönetici programının içindeki sunucuyla bu iki uçla konuşur.
Sunucu firmanın yerel ağında çalışır (örnek: `http://192.168.1.20:5480`).

Her istekte iki başlık gelir:

| Başlık | Anlamı |
|---|---|
| `X-Device-Key` | Yönetici programında bu cihaz için üretilen anahtar. Tanınmayan anahtara `401` döner. |
| `X-Device-Name` | Terminalde ayarlanan cihaz adı (`TRM-01`). Kayıt ve günlük için. |
| `X-App-Version` | Terminal uygulamasının sürümü (`1.0.0`). Yönetici programı Cihazlar ekranında gösterir. |

Hata gövdesi: `{"error": "açıklama"}`. Terminal `401/403` gelince "Cihaz yetkili değil" gösterir.

## Eşitleme sırası

1. Terminal önce bekleyen işlemleri `POST /api/ops` ile gönderir. Ana veri çekilirken yeni işlem eklenirse çekim bırakılır, önce o gider.
2. Bekleyen işlem kalmadıysa ana veriyi alır: 1.3.0+ terminal `POST /api/master/parts` ile yalnız değişen parçaları,
   eski terminal (ya da bu ucu bilmeyen eski sunucu, `404`) `GET /api/master` ile hepsini.

Gönderilemeyen işlem varken ana veri çekilmez; çekilseydi sunucunun eski hali cihazdaki değişikliği silerdi.
Bu yüzden sunucu, kabul ettiği her işlemi `master` cevabına hemen yansıtmalıdır.

## `GET /api/master`

```json
{
  "products":  [{"id": "P1", "code": "YF-1042", "name": "Yağ filtresi", "unit": "Adet", "vegaStock": 24, "barcodes": ["8691234500412"]}],
  "shelves":   [{"code": "A-03-02", "zone": "A"}],
  "locations": [{"productId": "P1", "shelf": "A-03-02", "qty": 12}],
  "receipts":  [{"id": "R4182", "docNo": "İRS-004182", "supplier": "…", "date": "14.10.2026",
                 "lines": [{"id": "R4182-1", "productId": "P1", "accepted": 24, "shelved": 12}]}],
  "counts":    [{"id": "C7", "no": "SAY-0007", "title": "Koridor A", "blind": true}],
  "users":     [{"username": "ismail", "name": "İsmail", "salt": "…", "pinHash": "…"}]
}
```

Cevapta `ETag` başlığı gelir. Terminal sonraki istekte `If-None-Match` ile gönderir; değişiklik yoksa sunucu
`304` döner ve liste yeniden inmez. Terminal o turda işlem gönderdiyse etiketi göndermez (reddedilen işlem cihazdaki
hali sunucudan farklı bırakmış olabilir). Gövde gzip'lidir.

**Çok depo (1.1.0):** `depots` (`[{id, name}]`, Vega depo numarası ve adı), `defaultDepot`; `shelves`, `locations`,
`homes` (ürünün asıl rafı: `{depot, productId, shelf}`), `receipts` (`depot`, `depotName`) ve `counts` (`depot`)
depo taşır; ürünlerde `stocks` (`{"<depo>": miktar}`), `vegaStock` bütün depoların toplamı. İşlemlerde `payload.depot`
çalışılan depodur; `PUTAWAY`'de sunucu belgenin deposunu esas alır (belge depo bazlı).

Ek alanlar: `warehouse` (Vega depo adı, terminalde gösterilir) ve `app` (`{"versionName","versionCode","path"}`;
sunucudaki APK cihazdakinden yeniyse terminal "Yeni sürüm" gösterir, indirme `sunucu + path`).

- `products`: Vega stok kartları. `vegaStock` Vega'daki toplam stok; kabul edilip rafa kaldırılmamış malı da içerir.
- `shelves`: yönetici programında tanımlı raflar. Terminal tanımsız rafa işlem yaptırmaz.
- `locations`: ürünün raftaki miktarı (sunucunun kendi tablosu; Vega'da yok).
- `receipts`: Vega'da mal kabulü yapılmış, rafa kaldırılması bitmemiş belgeler. `shelved` sunucuda tutulur.
- `counts`: yönetici programında açılmış, terminalde sayılacak oturumlar. `scope` (1.4.0+): raf önekleri
  (`["KAT-1"]`); boşsa bütün raflar. Önek bir sayı ya da harf dizisini bölmez (`KAT-1` → `KAT-1-A1-20`, `KAT-10` değil),
  sonda `*` düz önektir. Kural `yonetici/server/kapsam.js` ve terminalde `Kapsam.kt`. Listede olmayan oturum
  (kapatılan, iptal edilen) terminalden silinir.
- `users`: terminal kullanıcıları. `pinHash = sha256(salt + pin)` küçük harf hex. Şifre düz gönderilmez;
  terminal internetsiz giriş için listeyi saklar.

## `POST /api/master/parts` (1.3.0+)

130 bin ürünlük liste (~30 MB) her işlemden sonra baştan inince el terminalleri donuyordu. Ana veri parçalara bölünür:

- `head`: `/api/master`'daki `products`, `shelves`, `locations`, `homes` dışındaki her şey (depolar, belgeler, sayımlar, kullanıcılar, `app`).
- `shelves`: raf listesi.
- `b0` … `b63`: ürün kovaları. Ürün, stokları, barkodları, raf konumları (`locations`) ve zimmetleri (`homes`)
  ürün kimliğinin kovasındadır: `FNV-1a 32 bit (UTF-16 kod birimleri) % 64` (`depo.js kova`, `Buckets.kt`).

İstek: `{"known": {"head": "<özet>", "b12": "<özet>", …}, "max": 8}`. Cevap yalnız özeti farklı (ya da bilinmeyen) parçaları
getirir, kovalardan en çok `max` tanesini:

```json
{"buckets": 64,
 "parts": [{"key": "b12", "hash": "…", "data": {"products": […], "locations": […], "homes": […]}}],
 "remaining": 3}
```

Terminal her parçayı ayrı kısa işlemle yazar (kovanın eski satırlarını silip yenilerini koyar) ve özetini saklar;
`remaining > 0` ise hemen yeniden ister. Değişiklik yoksa `parts` boş gelir. Bir rafa kaldırma ya da transfer
yalnız ilgili ürünün kovasını (ve belge ilerlemesi için `head`'i) değiştirir. Sunucu işlemi reddederse terminal
bütün özetleri unutur (sonraki tur hepsi yeniden iner). Sıra sabittir; Vega yenilemesi içerik değişmeden özet değiştirmez.

### Depolar arası transfer, `transfer` (1.6.0+)

`head` parçasında gelir. Özellik ayarda kapalıysa `{"on": false}`:

```json
{"on": true, "yolda": 3,
 "depots": [{"id": 1, "name": "MERKEZ"}],
 "incoming": [{"id": "2631", "no": "A0000576", "date": "28.10.2026", "from": 1, "fromName": "MERKEZ", "to": 108, "toName": "TOYBELEN SANAYİ",
               "lines": [{"productId": "7058", "sent": 1, "open": 1}]}]}
```

`depots`: gönderim hedefi olabilecek bütün Vega depoları (yoldaki hariç). `incoming`: kabul bekleyen gönderimler; `open` hâlâ alınmamış
miktar. Gönderim (128) ile kabul (129) arasında Vega'da belge bağı yoktur; açık miktar (gönderen, alan, ürün) bazında toplam
gönderilen − toplam alınan − kayıtlı eksik olarak hesaplanıp en yeni gönderimden geriye dağıtılır (`yonetici/server/transfer.js`).

### Stok parçaları, `v: 2` (1.5.0+)

Vega'da satış olunca stok her tur değişir; stok kovanın içindeyken bütün kovalar yeniden iniyordu. İstekte `"v": 2`
gönderen terminal için stok kovadan ayrılır:

- `b0` … `b63` ürünleri `vegaStock` ve `stocks` olmadan taşır; yalnız rafa kaldırma, transfer, zimmet ve yeni kart
  kovayı değiştirir.
- `q0` … `q63`: aynı kovaların stoku, `{"items": [{"id": "P1", "vs": 24, "st": {"1": 24}}]}` (`vs` toplam, `st` depo bazlı;
  stoksuz ürün yoktur). Terminal kovanın stokunu silip bu listeyi yazar.
- `qN` yalnız `bN` bu cevapta geliyorsa ya da terminalde `bN` güncelse gönderilir (terminal kovayı yazarken eski stokunu siler,
  yeni kovanın stoku eksik kalmasın). Terminal `bN` yazarken `qN` özetini de unutur. `q` parçaları `max` sınırından sayılmaz.
- Cevapta `"surum": N`: bu verinin değişiklik sayacı (aşağıdaki `/api/changes` için).

`v` yoksa ya da bu ucu bilmeyen eski sunucuda stok kovanın içindedir (1.3.0 / 1.4.0 davranışı).

## `GET /api/changes?since=N&wait=25` (1.5.0+)

Terminal ana veriyi aldıktan sonra cevaptaki `surum`u `since` ile gönderir. Sunucuda bir şey değişmediyse en çok `wait` sn
(1–30) bekler; değişiklik olunca ya da süre dolunca `{"surum": N}` döner. `N !== since` ise hemen döner. Terminal dakikada bir
yoklamak yerine bunu dinler: yönetici, başka terminal ya da Vega'daki yeni mal kabul/stok saniyeler içinde gelir. Vega'dan okunan
içerik değişmediyse sayaç artmaz. Uç yoksa (`404`, eski sunucu) terminal dakikada bir yoklar.

## `POST /api/rapor` (1.3.0+)

Terminalin çökme, donma (ANR) ve elle gönderilen tanı raporu (`diag/Diag.kt`). Sunucu günlüğe bir satır yazar,
raporu `<veri>/raporlar/` altına koyar ve destek sunucusuna iletir (`araclar/hata-toplayici/`). Gövde serbest JSON;
`id` (8–64 harf/rakam) zorunlu. Terminal aynı raporu destek sunucusuna doğrudan da yollar, orada kimlikle tekilleşir.

## `POST /api/ops`

İstek:

```json
{
  "device": "TRM-01",
  "user": "ismail",
  "ops": [
    {"id": "uuid", "type": "PUTAWAY", "createdAt": 1791970000000, "payload": { … }}
  ]
}
```

Cevap: her işlem için bir satır.

```json
{"results": [{"id": "uuid", "ok": true}, {"id": "uuid2", "ok": false, "error": "Belge Vega'da kapatılmış"}]}
```

- `id` terminalde üretilen UUID'dir. Sunucu aynı `id`'yi ikinci kez alırsa yeniden işlemez, `ok: true` döner
  (bağlantı cevap gelmeden koparsa terminal aynı işlemi tekrar yollar).
- `ok: false` kalıcı ret demektir; terminal işlemi "Hata" olarak gösterir, kullanıcı silebilir.
- Cevapta olmayan işlem terminalde bekler ve sonra yeniden gönderilir.

### İşlem türleri

| `type` | `payload` | Sunucuda yapılacak |
|---|---|---|
| `PUTAWAY` | `receiptId, lineId, productId, shelf, qty, depot, user, device` | `locations[productId, shelf] += qty`, satırın `shelved += qty`. `receiptId`/`lineId` yoksa belgesiz rafa kaldırmadır (1.5.0+ terminal: ürün okutarak; Vega stoku var, belgesi yok), mal `depot`'a girer. |
| `PICK` (1.5.0+) | `productId, shelf, qty, depot, user, device` | Raftan alma: `locations[productId, shelf] -= qty` (eksiye düşmez), hareket `PICK`. Raf boşalırsa terminal zimmeti kalkar. Vega'ya yazılmaz. |
| `TRANSFER` | `productId, from, to, qty, user, device` | `from -= qty`, `to += qty` |
| `COUNT_SUBMIT` | `sessionId, no, title, shelves[], lines[{shelf, productId, system, counted}], user, device` | Sayımı onay bekleyen olarak kaydet. Raf miktarları sayılan değere çekilir. Vega'ya sayım fişi yönetici onayıyla yazılır. `shelves` boş sayılan rafları da içerir. |
| `TRANSFER_SEND` (1.6.0+) | `from, to, lines[{productId, qty, shelf}], user, device` | Depolar arası gönderim. `shelf` boş olabilir (raf stoku değişmez). Gönderen depoda raf stoku düşer (eksiye düşmez), kayıt `transfer` tablosunda bekler; sunucu arka planda Vega'ya **depo gönderim fişi (128)** yazar. `to` yoldaki depo olamaz; özellik ayarda kapalıysa kalıcı ret. |
| `TRANSFER_RECEIVE` (1.6.0+) | `sevkId, lines[{productId, qty, shelf}], depot, user, device` | Gönderim kabulü. `sevkId` ana verideki `transfer.incoming[].id` (Vega 128 başlık IND'i). Alan depoda raf stoku artar; gönderilenden fazla ya da gönderimde olmayan ürün kalıcı ret. `shelf` boş olabilir (1.7.0+ terminal raf sormaz): rafsız alınan mal ana verideki `receipts` içinde `TRF-<işlem kimliği>` belgesi olarak (rafa kaldırılacak, `PUTAWAY` ile yerleştirilir) bekler; rafla alınan kısım baştan yerleşmiş sayılır. Gönderimde olup gelmeyen miktar `transfer_fark`'a **eksik** olarak yazılır, gönderim kapanır; sunucu Vega'ya **gönderim kabul fişi (129)** yazar. |
| `SHELF_ADD` (1.4.0+) | `code, depot, user, device` | Terminalde okutulan tanımsız raf etiketini o depoda raf olarak aç (kaynak `TERMINAL`). |

`sessionId` `LOCAL-` ile başlıyorsa terminalde başlatılmış serbest sayımdır; sunucuda karşılığı yoktur,
yeni kayıt açılır.

Miktarlar ondalıklı olabilir (litre, metre); sayı olarak gelir.

### Sunucunun kuralları

- Vega'da olmayan ürün kimliği (demo verisi, başka kurulum) `PUTAWAY`/`TRANSFER`'de kalıcı ret alır; sayımda o satır yok sayılır.
- Tanımsız rafa gelen mal reddedilmez (mal fiziken oradadır); raf "terminalde açıldı" notuyla tanımlanır.
- `TRANSFER` kaynak rafı eksiye düşürmez.
- `COUNT_SUBMIT`: sayılan raflarda, sunucuda olup terminalin saymadığı ürün sayımdan **önce** yerleştiyse 0 kabul edilir,
  sonra yerleştiyse (başka terminal) dokunulmaz. İptal edilmiş ya da onaylanmış sayıma gelen gönderim kalıcı ret alır;
  kapatılmış (onay bekleyen) sayıma geç gelen gönderim alınır.

## Diğer uçlar

- `GET /apk` — terminal APK'sı. `GET /kur` — terminal tarayıcısı için indirme sayfası.
- Kurulum QR'ı: `ORTASDEPO|http://ip:port|ANAHTAR|TRM-01` (terminal Ayarlar › QR ile kur).
