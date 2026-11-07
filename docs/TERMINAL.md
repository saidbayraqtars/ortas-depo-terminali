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

**Ürün beklenirken raf okutulursa (1.13.1+):** Rafa Kaldır listesinde, Gönderim Kabul ve Depoya Gönder'de raf barkodu okutulunca
isimle arama penceresi açılmaz; "Raf barkodu okuttunuz (TK2-NSN-20). Şimdi ürün ya da belge okutun." uyarısı çıkar. Okutulan kod hiçbir
şeye uymadığı için İsimle ara kendiliğinden açıldığında klavye açılmaz (elle yazmak için alana dokunulur) ve **Geri tuşu pencereyi tek
basışta kapatır** (klavye açık olsa bile).

## Okutma mantığı: sepet (1.8.2+)

Rafa Kaldır (belge içi), Raftan Al, Raf Transferi, Depoya Gönder ve Gönderim Kabul aynı mantıkla çalışır: **adet sorulmaz**. Ürün okutulunca
listeye girer, **aynı ürün tekrar okutulunca adet 1 artar**, arada başka ürün okutulabilir. Liste en son okutulan üstte olacak şekilde
sıralıdır (son okutulan renkli), satırdaki **−** tek adım geri alır. Beklenen miktar (belgede kalan, raftaki stok, gönderilen) aşılırsa okutma
**engellenmez**: sesli ve görüntülü uyarı verilir, işlem sonunda onay penceresinde ayrıca uyarılır.

**Gönderim Kabul'de elle ekleme (1.13.2+):** okutulmayan mal (ör. dükkâna girmeden müşteriye verilen) için her satırda **+** düğmesi vardır
(Okunan, Kalan ve Tümü sekmelerinde); her dokunuş 1 adet ekler, **−** geri alır. Satırın adedine (`2/3`) dokununca adet yazılabilir. Elle ekleme de
okutma gibi sayılır (yarım bırakılınca saklanır, Kısmi kaydet / Kabulü bitir ile işlenir) ama gönderilen miktarı aşamaz.

## Belgeyi yarım bırakma (1.13.0+)

**Rafa Kaldır** (belge içi), **Gönderim Kabul** ve **Depoya Gönder** belgeleri yarım bırakılabilir: okutulanlar her okutmada
terminale (cihazdaki `doc_draft` tablosu) yazılır, belgeden çıkınca, uygulama kapanınca, terminal yeniden başlayınca ya da başka
kullanıcı girince **kaybolmaz**; belgeye dönünce kaldığı yerden devam edilir ("Yarım bırakılan okutma geri yüklendi · kim · ne zaman").
Taslak **Vega'ya ve sunucuya hiçbir şey yazmaz**; okutulanlar ancak **Rafa kaldır / Kısmi kaydet / Kabulü bitir / Gönder** ile işlenir.

- Okutulanlarla geri tuşuna basınca açılan pencerede birincil seçenek **Yarım bırak**tır. Diğerleri: **Rafa kaldır** (Rafa Kaldır) ya da
  **Kısmi kaydet (Vega'ya yaz)** (Gönderim Kabul), **Atıp çık**, **Belgede kal**. Depoya Gönder'de geri tuşu sormadan yarım bırakır.
  Gönderim Kabul'de ayrıca listenin sonunda **Yarım bırak** bağlantısı vardır.
- Yarım bırakılan belgeler görünür: belge kartında **Yarım · 12 adet okutuldu · Ahmet · 31.10 17:40**, ana menüde ilgili kartın altında
  sarı **"2 belge yarım"** / **"Yarım gönderim var"** / **"Yarım kalan var"** (Raf Düzenle) yazısı.
- Taslak **terminale** aittir (başka terminalde görünmez). Aynı belgeyi başka terminal alırsa ya da yönetici kilidi açarsa, bu terminaldeki
  taslak değil işlenmiş kısım esas alınır: kilit gidince terminal okutulanları kaydedip (Rafa kaldır / kısmi kabul) belgeden çıkar (1.8.0).
- Gönderim kapanmış / belge tamamlanmış ise taslağın işi kalmaz: Gönderim Kabul'de "Yarım okutmayı sil" düğmesi çıkar; 30 gün
  dokunulmayan taslak kendiliğinden silinir.
- Raftan Al, Raf Transferi ve belgesiz Rafa Kaldır (ürün okutarak) anlık işlemlerdir, belge değildir; yarım bırakılmaz. Sayım ve Raf Düzenle
  oturumları zaten cihazda saklanır.

## Rafa kaldırma ve raftan alma (1.5.0+)

- **Rafa Kaldır** listesi çalışılan deponun belgelerini gösterir ("Bütün depolar" ile hepsi). Okutma alanına belge
  numarasının bir kısmı ya da belgedeki firma (tedarikçi) adı yazılınca liste süzülür: `2014` ya da `npe2014`
  `NPE2026000002014`'ü, `nipar oto` Nipar Otomotiv'den gelen belgeleri bulur (Türkçe harfsiz yazılabilir).
  Tam numara ya da e-Fatura karekodu okutulursa belge açılır.
- Aynı alana **ürün** okutulursa belge seçmeden rafa kaldırılır: ürün → raf (1.9.1+: ilk okutma **1 adet**, ürün tekrar okutulunca +1,
  çok adet için **Değiştir**; eskiden miktar kalan stoğun tamamıyla açılırdı). Miktar o depodaki açık belgelerden
  (en eski önce) düşülür; belgede olmayan kısım **belgesiz** kalkar (Vega'da stok var ama mal kabul belgesi yok:
  seçilmemiş belge türü, devir, başlangıç tarihinden eski giriş). En çok "belgede + belgesiz" kadar kaldırılır.
- Belge içinden rafa kaldırma (1.8.2+): **raf okutulur, ürünler peş peşe okutulur** (her okutma +1), **Rafa kaldır** hepsini işler. Raf
  değiştirilecekse yeni raf okutulur (3. kat, 2. kat, zemin gibi bölerek). Raf okutulmadıysa ürünün durduğu ya da asıl rafı kullanılır;
  kayıtlı rafı yoksa önce raf istenir. Belgede kalandan fazlası da rafa kalkar (uyarıyla). Ayrılırken okutulanlar için "rafa kaldırılsın mı"
  sorulur. **Kalan** sekmesi belgede henüz okutulmamış kalemleri gösterir.
- **Özel raf: SIPARIS SATIS** (2.3.0+): mal kabulden raf yerine doğrudan sipariş hazırlığına giden mal için. Raf yerine **SIPARIS SATIS**
  barkodu okutulur (ya da belge içinde **SIPARIS SATIS · doğrudan siparişe** düğmesine dokunulur, okutmakla aynıdır; ürün okutarak
  rafa kaldırmada "Ürünün rafları" listesinden seçilir), ürünler her zamanki gibi okutulur; **Rafa kaldır**dan sonra seçim kalkar, sonraki
  mal için düğmeye yeniden dokunulur (yanlışlıkla siparişe yazılmasın); böylece 50 adetlik girişin 5'i
  SIPARIS SATIS'e, 45'i rafa kaldırılırsa belgede/Rafa bekleyen'de eksik kalmaz. Bu rafta **stok tutulmaz** (rafta görünmez, sayıma girmez),
  ürüne **raf adresi verilmez** (Vega KOD10'a yazılmaz), raf sınırı uygulanmaz, "önerilen raf / farklı raf" uyarısı çıkmaz. Yalnız Rafa Kaldır'da
  okutulur; Raftan Al, Raf Transferi, Sayım ve Raf Düzenle'de reddedilir. Kayıt Hareketler'de rafa kaldırma olarak durur, yönetici geri alabilir.
  Özel raf listesi sunucuda (`config.json` › `ozelRaflar`, varsayılan `["SIPARIS SATIS"]`) tutulur ve ana veriyle terminallere gider.
- **Raftan Al** (1.8.2+): ürünler peş peşe okutulur (+1), **Raftan al** hepsini işler. Raf okutulursa ürünler o raftan alınır (**Otomatik**
  ile bırakılır); okutulmazsa her ürün için raf kendiliğinden seçilir (önce sepetteki raf, sonra asıl raf / en çok stoklu). Raf stoku
  azalır; raftaki miktar aşılırsa raf sıfırda kesilir. Vega'daki çıkış (fatura, sevk) ayrıca Vega'da yapılır. Ürünün raf adresini silmek
  için Ürün Sorgu'daki **Raf adresleri › Sil** kullanılır.
- **Raf Transferi** (1.8.2+): kaynak raf okutulur, ürünler peş peşe okutulur (+1), hedef raf okutulunca onaydan sonra hepsi taşınır.
  Kaynak raftaki miktar aşılırsa kaynak sıfırda kesilir, okutulan adedin tamamı hedefe girer.
- Vega'da olup terminalde görünmeyen stok için yönetici programında Ürünler › **Neden terminalde yok?**: ürünün Vega
  girişleri belge belge ve her birinin neden terminale gitmediği (tür seçili değil, başlangıçtan eski, iade, depo seçili değil…).

## Depolar arası transfer (1.6.0+, 1.8.0'da değişti)

Yönetici programında Ayarlar › Depolar arası transfer açık ve **iki depo seçilmişse** (Ortaş: Merkez ↔ Toybelen) ana menüde iki kutu çıkar.
Transfer yalnız bu iki depo arasındadır; başka depoya gönderilemez.

- **Depoya Gönder:** önce **hangi depodan çıkıldığı** sorulur (iki seçenek); varış karşıdaki depodur. Sonra her ürün için:
  **ürünler peş peşe okutulur** (her okutma +1, adet sorulmaz).
  - Ürün çıkış deposunda **rafta stoğu olan** bir ürünse raf **kendiliğinden seçilir** (önce sepetteki raf, sonra asıl raf / en çok stoklu);
    adet ya da raf değiştirmek için satıra dokunulur (adet raflara bölünebilir). Adet raf stokunu aşarsa fazlası **rafsız** gider
    (rafa kaldırılmayı bekleyen mal olabilir); okutmada ve gönder penceresinde uyarılır. Seçilen raflardan düşülür.
  - Rafta stoğu olmayan ürün rafsız gider; raftan düşülmez.
  - Ürünlerin hepsi eklenince **Gönder** → varış deposu onaylanır → yönetici programı Vega'ya *depo gönderim fişi* (128) yazar.
    (Sunucu son sözü söyler: eski sürüm bir terminal rafsız yollarsa ve ürünün rafında stok varsa eksiği kendisi raftan düşer.)
- **Gönderim Kabul:** çalışılan depoya gelen gönderimler listelenir. Gelen ürünler okutulur, **her okutma 1 adet sayar**, yanlış okutma
  satırdaki − ile geri alınır. Gönderilenden fazlası okutulabilir (uyarı verir) ama fişe yalnız gönderilen kadar yazılır; **Kalan** sekmesi
  henüz okutulmayanları gösterir. İki yol:
  - **Kısmi kaydet:** okutulanlar kabul edilir, gönderim **açık kalır** (kalan miktar listede durur), eksik kaydı açılmaz.
  - **Kabulü bitir:** kalan miktar "eksik" olarak kaydedilir ve gönderim kapanır; daha önce kısmi kabul yapılmışsa yeni okutma olmadan da
    bitirilebilir.
  Her kabul için Vega'ya *gönderim kabul fişi* (129) yazılır. Alınan mal **Rafa Kaldır'da belge olarak bekler**; çalışan oradan girip
  rafa yerleştirir (belgeden raf → ürünler peş peşe). Eksikler yönetici programında Depo transferi › Eksikler'de gönderen depo, ürün ve
  miktarla görünür; mal bulununca ya da kayıp sayılınca çözüldü işaretlenir.

Fişler terminali beklemeden arka planda yazılır; Vega'ya ulaşılamazsa yönetici programı yeniden dener, 5 denemeden sonra
Depo transferi › Gönderim ve kabuller'de "Yeniden dene" görünür.

## Belge kilidi (1.8.0+)

Mal kabul / rafa kaldırma belgesine ve gelen transfer belgesine girince belge o terminale kilitlenir; belge listesinde başka terminalin
tuttuğu belge **🔒 Ahmet (TRM-03) kullanıyor** ile görünür, o belgeye girilmek istenirse uyarı verilir ve belge açılmaz. Kilit belgeden
çıkınca, "Kabulü bitir"de ve oturum kapanınca kalkar; terminal 30 sn'de bir sunucuya nabız yollar, **3 dakika nabız gelmezse** (terminal
kapandı, Wi-Fi koptu) kilit kendiliğinden düşer. Sunucuya ulaşılamıyorsa belge "kilitsiz" uyarısıyla açılır.

- Yönetici bir kilidi açarsa terminal bekleyen işini kaydedip belgeden çıkar (gelen transferde okutulanlar kısmi kabul olarak gider);
  yapılan işler kaybolmaz.
- Kilit yalnız arayüz korumasıdır; iki terminal yine de aynı belgeye işlem yollarsa sunucu miktar sınırlarıyla çakışmayı çözer.
- Sayım kilitlenmez. 1.8.0'dan eski terminaller kilidi bilmez (Cihazlar'da "kilit desteği yok" etiketi).

## Okuyucu ayarı

Uygulama iki yolu da dinler; terminale göre biri seçilir.

### 1. Klavye modu (en kolay)

Okuyucu okuduğu barkodu klavyeden yazılmış gibi gönderir ve sonuna **Enter** ekler.
Çoğu terminal fabrikadan böyle gelir. Okuyucu ayarında "suffix / son ek: Enter (CR/LF)" açık olmalı.
**Peş peşe okutma (Gönderim Kabul, Depoya Gönder, Rafa Kaldır, Raftan Al) için yayın modu önerilir.** iData K1'de (Toybelen,
2026-10-30) klavye modunda ekran klavyesi kapalıyken ekrana girişteki ilk okutmadan sonrası kayboluyordu (klavye açılınca düzeliyordu);
neden doğrulanmadı, yayın modu klavyeye hiç bağlı olmadığından bu sorunu yaşamaz.
**iData K1 (Toybelen) için doğrulandı (2026-10-30):** Application Setting › *Scan result sending mode* **Focus** iken aynı ürünün
art arda ikinci okutması kayboluyordu (farklı ürünler okunuyordu); **Broadcast**'e alınınca sorun bitti (uygulama güncellemesi gerekmedi).
Bu cihazlarda modu Focus'ta bırakmayın.

Ekran klavyesinin açık olması gerekmez. Okutma alanı her tuşu ekran klavyesinden (IME) **önce** de görür (1.9.0). IME karakterleri alana
yazmazsa ya da Enter'ı yutarsa okuma bu kopyadan okutma sayılır (Enter'dan 120 ms sonra, alan hâlâ boşsa); IME çalışıyorsa alan kendisi gönderir ve
kopya kullanılmaz, aynı okuma iki kez sayılmaz. Okuyucu tuşları okutma alanına hiç ulaşmazsa (odak başka yerdeyse, ya da okuyucu barkodu tek
parça "toplu" tuş olayı olarak yolluyorsa) uygulama okuyucu hızında gelen karakter dizisini Enter'la birlikte okutma sayar; elle yazma bu yollara girmez
(karakterler arası 80 ms'den uzun, 3 karakterden kısa diziler okuma sayılmaz).
Sorun sürerse Ayarlar › Tanı raporu gönder: izde `okutma (…) · IME'den önce yakalandı` satırları kurtarma yolunun kullanıldığını (IME okumayı almamış),
`tuş işlenmedi: …` satırları okuyucunun ne yolladığını gösterir.

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
