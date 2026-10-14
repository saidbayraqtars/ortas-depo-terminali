# El terminali kurulumu

Uygulama: `cikti/OrtasDepo-<sürüm>.apk`. Android 8.0 ve üstü.

## Kurulum

1. APK'yı terminale kopyalayın (USB, e-posta ya da paylaşılan klasör) ve açın.
   "Bilinmeyen kaynaklar" izni istenirse verin.
2. Uygulamayı açın, sağ üstteki ayar düğmesine basın.
3. **Demo modu**nu kapatın, **Sunucu adresi** ve **Cihaz anahtarı**nı yönetici programından girin.
4. **Kaydet ve eşitle**. Ürün, raf ve kullanıcı listesi gelir; sonra kullanıcı adı ve şifreyle giriş yapılır.

## Okuyucu ayarı

Uygulama iki yolu da dinler; terminale göre biri seçilir.

### 1. Klavye modu (en kolay)

Okuyucu okuduğu barkodu klavyeden yazılmış gibi gönderir ve sonuna **Enter** ekler.
Çoğu terminal fabrikadan böyle gelir. Okuyucu ayarında "suffix / son ek: Enter (CR/LF)" açık olmalı.

### 2. Yayın (broadcast) modu (daha sağlam)

Okuyucu her okumayı bir Android Intent'i olarak yollar; odak hangi alanda olursa olsun okuma kaybolmaz.

| Marka | Ayar yeri | Eylem (action) | Veri (extra) |
|---|---|---|---|
| Zebra | DataWedge › profil › Intent output: *Broadcast* | `tr.arcteknik.depo.SCAN` | `com.symbol.datawedge.data_string` |
| Urovo | Scanner settings › Output mode: *Intent* | `android.intent.ACTION_DECODE_DATA` | `barcode_string` |
| Honeywell | Scanner › Data intent | `com.honeywell.decode.intent.action.EDIT_DATA` | `data` |
| Newland | Scan settings › Output: *Broadcast* | `nlscan.action.SCANNER_RESULT` | `SCAN_BARCODE1` |
| Sunmi | Scanner › Output: *Broadcast* | `com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED` | `data` |
| iData | Scan › Output mode: *Broadcast* | `android.intent.action.SCANRESULT` | `value` |
| Chainway | Keyboard emulator › Broadcast | `com.scanner.broadcast` | `data` |

Listede olmayan marka için eylem ve veri adını not edin; uygulamaya eklenir (`scan/Scanner.kt`).

Yayın modunda klavye modunu kapatın; ikisi açıksa aynı barkod iki kez okunur.

## Telefonlar

Okutma alanındaki kamera düğmesiyle telefon kamerası barkod okur (Google Play Hizmetleri gerekmez).
El terminalinde bu düğme Ayarlar › Kamera düğmesi ile gizlenebilir.

## Çevrimdışı çalışma

Depoda çekmeyen yerde işlemler cihazda saklanır, üstteki gösterge "Çevrimdışı" olur.
Bağlantı gelince kuyruk kendiliğinden gönderilir (uygulama açıkken dakikada bir, kapalıyken 15 dakikada bir).
Ana menü › **Kuyruk** ekranı bekleyen ve reddedilen işlemleri gösterir.
