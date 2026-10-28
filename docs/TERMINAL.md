# El terminali kurulumu

Uygulama: `cikti/OrtasDepo-<sürüm>.apk`. Android 7.1 ve üstü.

## Kurulum

1. Yönetici programı › Cihazlar › Yeni cihaz. Açılan pencerede **1. QR** terminalin tarayıcısında
   `http://<sunucu>:5480/kur` sayfasını açar; APK'yı indirip kurun ("bilinmeyen kaynak" izni).
2. Uygulamada sağ üstteki ayar → **QR ile kur** alanına **2. QR**'ı okutun. Sunucu adresi, cihaz anahtarı ve adı
   dolar, eşitleme başlar. (Elle: Demo modunu kapatıp adres ve anahtarı yazın, **Kaydet ve eşitle**.)
3. Kullanıcı adı ve şifreyle giriş.

Barkodu okunmayan ürün için her okutma alanının altında **İsimle ara** var; adın bir kısmı yazılır, yazım hatası
olsa da yakın adlar listelenir. Ürün Sorgu ve Raf Sorgu ekranlarındaki **Etiket bas** düğmesi etiketi yönetici
programının bilgisayarındaki etiket yazıcısından çıkarır.

## Rafa kaldırma ve raftan alma (1.5.0+)

- **Rafa Kaldır** listesi çalışılan deponun belgelerini gösterir ("Bütün depolar" ile hepsi). Okutma alanına belge
  numarasının bir kısmı ya da belgedeki firma (tedarikçi) adı yazılınca liste süzülür: `2014` ya da `npe2014`
  `NPE2026000002014`'ü, `nipar oto` Nipar Otomotiv'den gelen belgeleri bulur (Türkçe harfsiz yazılabilir).
  Tam numara ya da e-Fatura karekodu okutulursa belge açılır.
- Aynı alana **ürün** okutulursa belge seçmeden rafa kaldırılır: ürün → miktar → raf. Miktar o depodaki açık belgelerden
  (en eski önce) düşülür; belgede olmayan kısım **belgesiz** kalkar (Vega'da stok var ama mal kabul belgesi yok:
  seçilmemiş belge türü, devir, başlangıç tarihinden eski giriş). En çok "belgede + belgesiz" kadar kaldırılır.
- Belge içinden rafa kaldırma da ürün → miktar → raf sırasındadır.
- **Raftan Al**: ürün → miktar → raf (okutulur ya da ürünün durduğu raflardan seçilir). Raf stoku azalır; Vega'daki çıkış
  (fatura, sevk) ayrıca Vega'da yapılır.
- Vega'da olup terminalde görünmeyen stok için yönetici programında Ürünler › **Neden terminalde yok?**: ürünün Vega
  girişleri belge belge ve her birinin neden terminale gitmediği (tür seçili değil, başlangıçtan eski, iade, depo seçili değil…).

## Depolar arası transfer (1.6.0+)

Yönetici programında Ayarlar › Depolar arası transfer açıksa ana menüde iki kutu çıkar.

- **Depoya Gönder:** önce hangi depodan çıkacağı, sonra hangi depoya gideceği sorulur. Ürün okutulur, miktar girilir, raf okutulursa
  (ya da listeden seçilirse) mal o raftan düşer. **Gönder** deyince yönetici programı Vega'ya *depo gönderim fişi* (128) yazar.
- **Gönderim Kabul:** çalışılan depoya gelen gönderimler listelenir. Gelen ürünler okutulur, rafa konur, **Kabulü bitir** deyince
  Vega'ya *gönderim kabul fişi* (129) yazılır. Gönderimde olup gelmeyen mal kabulde "eksik" olarak kaydedilir: belge açık kalmaz,
  ama yönetici programı Depo transferi › Eksikler'de gönderen depo, ürün ve miktarı gösterir; mal bulununca ya da kayıp
  sayılınca çözüldü işaretlenir.

Fişler terminali beklemeden arka planda yazılır; Vega'ya ulaşılamazsa yönetici programı yeniden dener, 5 denemeden sonra
Depo transferi › Gönderim ve kabuller'de "Yeniden dene" görünür.

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
Bağlantı gelince kuyruk kendiliğinden gönderilir. Uygulama açıkken terminal sunucudaki değişikliği bekler (1.5.0+ yönetici
programı: yönetici ya da başka terminalin işlemi ve Vega'daki yeni belge/stok birkaç saniyede gelir; eski programda dakikada bir
yoklar), kapalıyken Android 15 dakikada bir dener.

**Gecikme olmasın diye:** Android 7'nin pil tasarrufu (Doze) ekranı kapalı, hareketsiz cihazda ağı keser. Terminalde
Ayarlar › Pil › Pil optimizasyonu › Ortaş Depo → **Optimize etme** seçin ve çalışma sırasında ekranı otomatik kapanmaya bırakmayın
(Ekran › Uyku süresini uzatın). Yönetici programının kurulu olduğu bilgisayar uykuya geçmemeli (program bunu engeller, yine de
Güç seçeneklerinde "Uyku: Hiçbir zaman" olmalı).
Ana menü › **Kuyruk** ekranı bekleyen ve reddedilen işlemleri gösterir.
