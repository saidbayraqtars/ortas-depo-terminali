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
{"on": true, "yolda": 3, "pair": [1, 108],
 "depots": [{"id": 1, "name": "MERKEZ"}, {"id": 108, "name": "TOYBELEN SANAYİ"}],
 "incoming": [{"id": "2631", "no": "A0000576", "date": "28.10.2026", "from": 1, "fromName": "MERKEZ", "to": 108, "toName": "TOYBELEN SANAYİ",
               "lines": [{"productId": "7058", "sent": 1, "open": 1}]}]}
```

`pair` / `depots` (1.8.0+): transfer yalnız yönetici programında seçilen **iki depo** arasında yapılır (Ayarlar › Depolar arası transfer,
Ortaş: Merkez ↔ Toybelen). Terminal çıkış deposunu bu ikiliden sorar, varış diğeridir. Çift seçilmemişse `on: false`. Sunucu bu çift
dışındaki gönderim ve kabulü kalıcı reddeder, Vega'dan da yalnız bu çifti okur. (1.6.x–1.7.0 sunucuda `depots` yoldaki hariç bütün depolardı, `pair` yoktu.)
`incoming`: kabul bekleyen gönderimler; `open` hâlâ alınmamış miktar (kısmi kabulden sonra azalır). Gönderim (128) ile kabul (129)
arasında Vega'da belge bağı yoktur; açık miktar (gönderen, alan, ürün) bazında toplam gönderilen − toplam alınan − kayıtlı eksik −
henüz Vega'ya yazılmamış kabul olarak hesaplanıp en yeni gönderimden geriye dağıtılır (`yonetici/server/transfer.js`).

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

## Belge kilidi (1.8.0+)

Mal kabul / rafa kaldırma belgesini ve gelen transfer belgesini ekranında açan terminal belgeyi kilitler; başka bir terminal aynı
belgeye girmek isterse "Ahmet (TRM-03) kullanıyor" uyarısı alır ve belge o terminalde açılmaz. **Sayım kapsam dışıdır.** Kilit
**arayüz korumasıdır**: `/api/ops` işlemleri kilide bakmadan işlenir, çakışmayı miktar sınırları çözer (rafa kaldırmada satırın kalanı,
transferde açık miktar). Kilitler sunucu veritabanında (`belge_kilit`) durur, yeniden başlatmada düşmez.

Belge kimliği: mal kabul / rafa kaldırma için ana verideki `receipts[].id`, gelen transfer için `"SEVK-" + transfer.incoming[].id`.
`kind`: `KABUL` ya da `TRANSFER` (yönetici ekranında gösterim için).

| Uç | Gövde | Cevap |
|---|---|---|
| `POST /api/lock` | `{docId, kind, docNo, user, device?}` | `{"ok": true, "token": "…", "sureSn": 180}` ya da belge başka cihazdaysa `{"ok": false, "holder": {"user", "device", "since", "mesaj": "Ahmet (TRM-03) kullanıyor"}}`. Aynı cihaz yeniden girerse kendi kilidini devralır (eski token geçersiz olur). |
| `POST /api/lock/ping` | `{docId, token}` | Tutan terminalin nabzı, **30 sn'de bir**: `{"ok": true}`. Kilit gittiyse `{"ok": false, "neden": "yonetici" \| "baska" \| "yok", "holder"?}`: `yonetici` yönetici kilidi açtı, `baska` süre dolup başkası aldı, `yok` kayıt yok. Süresi dolmuş ama kimsenin almadığı kilit nabızla sessizce sürer. |
| `POST /api/lock/release` | `{docId, token}` | Belgeden çıkış, "Kabulü bitir", oturum kapanması: `{"ok": true}`. Başkasının kilidine dokunmaz. |
| `GET /api/locks` | — | `{"locks": [{"id", "tur", "no", "user", "device", "since", "last"}]}`: şu an tutulan belgeler; terminal liste ekranlarında 🔒 göstermek için 10 sn'de bir okur. Ana veriyi (ve `surum`u) değiştirmez. |

Nabız **3 dakika** gelmezse kilit düşer. Terminal `lock` isteğine cevap alamazsa (ağ yok) belgeyi "kilitsiz" uyarısıyla açar; uç `404`
dönerse (eski yönetici programı) uyarısız açar. Nabızda `ok: false` gelirse terminal bekleyen işi kaydeder (gelen transferde
okutulanlar `partial: true` ile kısmi kabul olarak gider), uyarı gösterir ve belgeden çıkar; sessizce yeniden kilit almaz.
Yönetici programında Özet › **Açık belgeler**: belge, kim, hangi cihaz, ne zamandır, son nabız; satır başına *Bu kilidi aç*, üstte
*Tüm kilitleri sıfırla* (açılan kilidin satırı silinmez, durumu `ACILDI` olur; tutan terminal bir sonraki nabızda öğrenir).
Terminal sürümü 1.8.0'dan eskiyse kilidi bilmez; Cihazlar ve Özet'te "kilit desteği yok" etiketi görünür.

## `GET /api/ping` (1.8.0+)

Kimlik gerektirmez: `{"ok": true, "surum": "1.8.0", "zaman": 1793191232753}`. Toybelen köprüsünün "Merkez'e ulaşılıyor mu, gecikme kaç ms"
sınaması bunu kullanır.

## Toybelen köprüsü (1.8.0+)

Uzak şubede (Toybelen) Merkez'e VPN ile ulaşan bilgisayarda aynı exe **Köprü modunda** çalışır (`yonetici/server/kopru.js`): şubenin yerel
ağında `:5480` dinler, `/api/*`, `/apk` ve `/kur` isteklerini Merkez'in VPN adresine olduğu gibi iletir (uzun yoklama ve gzip dahil;
gövdeler çözülmeden akıtılır). Veritabanı ve Vega yoktur. Bağlantı koparsa köprü `502` (`{"error": "Köprü Merkez'e ulaşamıyor: …"}`) döner;
Merkez adresi girilmemişse `503`; terminal bunu "sunucuya ulaşılamıyor" sayar, çevrimdışı çalışıp işlemleri kuyruğa yazar.
Köprü Merkez'e şu başlıkları ekler: `X-Kopru: <köprü adı>`, `X-Kopru-Adresler: http://ip:port,…` (köprünün yerel adresleri),
`X-Kopru-Surum`, `X-Forwarded-For: <terminalin gerçek adresi>`. Merkez bunlardan köprüyü tanır (Özet: "Toybelen köprüsü: bağlı / son
görülme"; Cihazlar › kurulum QR'ında bağlantı adresi olarak köprü seçilebilir) ve terminalin son bağlantı adresini köprü arkasından
da doğru gösterir (`X-Forwarded-For` yalnız `X-Kopru` ile birlikte gelirse dikkate alınır). Köprünün kendi arayüzü
(`http://127.0.0.1:5480/`, yalnız o bilgisayardan): Merkez adresi, ulaşılıyor mu, gecikme, bağlı terminaller.

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
| `TRANSFER_SEND` (1.6.0+) | `from, to, lines[{productId, qty, shelf}], user, device` | Depolar arası gönderim; `from` ve `to` ayardaki çiftin iki ayrı deposu olmalı, değilse kalıcı ret (özellik kapalıysa, çift seçilmemişse ya da `to`/`from` yoldaki depoysa da). Kayıt `transfer` tablosunda bekler; sunucu arka planda Vega'ya **depo gönderim fişi (128)** yazar (ürün başına toplam miktar). **Raf kuralı (1.8.0+):** bir ürün birden çok satır olabilir (raf başına bir satır; `shelf` boş satır = rafsız). Raflı satırlar `from` deposunun o rafından düşer (rafta olandan fazlası raf sıfıra iner, eksiye düşmez, hareket notuna yazılır). Rafsız satır için sunucu son sözü söyler: ürünün `from` deposunda **hâlâ raf stoku varsa** rafsız miktarı kendisi düşer (önce ürünün asıl rafı, sonra en çok stoklu raf; hareket notu "raf otomatik seçildi", `transfer_line.otomatik`); raf stoku yetmezse raflar sıfıra çekilir, kalan rafsız geçer ve notlanır, işlem reddedilmez (mal fiziken gitmiştir). Rafta stoğu olmayan ürünün rafsız miktarı olduğu gibi geçer. Terminal bunu önceden uygular (1.8.2+ raf kendiliğinden seçilir, satıra dokunulunca değiştirilir): raf stoku olan ürün her zaman raftan düşer, raf stokunu aşan miktarın fazlası rafsız gider. |
| `TRANSFER_RECEIVE` (1.6.0+) | `sevkId, lines[{productId, qty, shelf}], partial, depot, user, device` | Gönderim kabulü. `sevkId` ana verideki `transfer.incoming[].id` (Vega 128 başlık IND'i); gönderimin iki deposu çiftin içinde olmalı. Gönderilenden (açık miktardan) fazla ya da gönderimde olmayan ürün kalıcı ret. `shelf` boş olabilir (1.7.0+ terminal raf sormaz): rafsız alınan mal ana verideki `receipts` içinde `TRF-<işlem kimliği>` belgesi olarak (rafa kaldırılacak, `PUTAWAY` ile yerleştirilir) bekler; rafla alınan kısım baştan yerleşmiş sayılır. **`partial: true` (1.8.0+):** okutulanlar kısmi kabuldür; gönderim açık kalır (`open` düşer), eksik kaydı açılmaz, `lines` boş olamaz. **`partial` yok/false ("Kabulü bitir"):** gönderimde olup gelmeyen miktar `transfer_fark`'a **eksik** olarak yazılır (gönderilen = fişteki miktar, alınan = gönderilen − eksik; önceki kısmi kabuller alınmış sayılır), gönderim kapanır; daha önce kısmi kabul yapılmışsa `lines` boş olabilir. Her kabul işlemi için sunucu Vega'ya ayrı bir **gönderim kabul fişi (129)** yazar (satır yoksa yazılacak bir şey yoktur). |
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
- Kurulum QR'ı: `ORTASDEPO|http://ip:port|ANAHTAR|TRM-01` (terminal Ayarlar › QR ile kur). Adres Merkez'in ya da Toybelen köprüsünün
  adresi olabilir (yönetici programında QR penceresinde seçilir).
