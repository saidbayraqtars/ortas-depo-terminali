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

1. Terminal önce bekleyen işlemleri `POST /api/ops` ile gönderir.
2. Bekleyen işlem kalmadıysa `GET /api/master` ile ana veriyi alır ve yerel tablolarının yerine koyar.

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
- `counts`: yönetici programında açılmış, terminalde sayılacak oturumlar.
- `users`: terminal kullanıcıları. `pinHash = sha256(salt + pin)` küçük harf hex. Şifre düz gönderilmez;
  terminal internetsiz giriş için listeyi saklar.

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
| `PUTAWAY` | `receiptId, lineId, productId, shelf, qty, user, device` | `locations[productId, shelf] += qty`, satırın `shelved += qty` |
| `TRANSFER` | `productId, from, to, qty, user, device` | `from -= qty`, `to += qty` |
| `COUNT_SUBMIT` | `sessionId, no, title, shelves[], lines[{shelf, productId, system, counted}], user, device` | Sayımı onay bekleyen olarak kaydet. Raf miktarları sayılan değere çekilir. Vega'ya sayım fişi yönetici onayıyla yazılır. |

`sessionId` `LOCAL-` ile başlıyorsa terminalde başlatılmış serbest sayımdır; sunucuda karşılığı yoktur,
yeni kayıt açılır.

Miktarlar ondalıklı olabilir (litre, metre); sayı olarak gelir.

### Sunucunun kuralları

- Vega'da olmayan ürün kimliği (demo verisi, başka kurulum) `PUTAWAY`/`TRANSFER`'de kalıcı ret alır; sayımda o satır yok sayılır.
- Tanımsız rafa gelen mal reddedilmez (mal fiziken oradadır); raf "terminalde açıldı" notuyla tanımlanır.
- `TRANSFER` kaynak rafı eksiye düşürmez.
- `COUNT_SUBMIT`: sayılan raflarda, sunucuda olup terminalin saymadığı ürün sayımdan **önce** yerleştiyse 0 kabul edilir,
  sonra yerleştiyse (başka terminal) dokunulmaz.

## Diğer uçlar

- `GET /apk` — terminal APK'sı. `GET /kur` — terminal tarayıcısı için indirme sayfası.
- Kurulum QR'ı: `ORTASDEPO|http://ip:port|ANAHTAR|TRM-01` (terminal Ayarlar › QR ile kur).
