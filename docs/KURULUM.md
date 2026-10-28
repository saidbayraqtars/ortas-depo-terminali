# Kurulum ve kullanım

Sistem iki parçadır:

- **Ortaş Depo Yönetici** (Windows): depodaki bir bilgisayara kurulur. Hem yönetim ekranı hem de el terminallerinin
  bağlandığı sunucudur. Vega'yı (SQL Server) okur; yalnız onaylanan sayımı Vega'ya yazar.
- **Ortaş Depo Terminali** (Android 7.1 ve üstü): el terminali ya da telefon. Yönetici programındaki sunucuya bağlanır,
  internetsizken de çalışır.

## 1. Yönetici programı

1. `OrtasDepoYonetici-Kurulum-<sürüm>.exe` ile kurun (yönetici izni ister: Windows Güvenlik Duvarı'na programın
   kuralını ekler).
2. Program açılınca **Ayarlar › Vega bağlantısı**: SQL sunucu adı, kullanıcı, parola → **Bağlantıyı dene** →
   firma, dönem (Otomatik önerilir; yıl değişince yeni dönemi kendisi seçer), **varsayılan depo** ve istenirse
   **kullanılan depolar** (boş = firmanın bütün depoları) → **Kaydet**.
3. **Ayarlar › Mal kabul**: hangi Vega belgeleri rafa kaldırılacak iş sayılsın (alış faturası 20, alış irsaliyesi 26,
   stok giriş fişi 32) ve başlangıç tarihi (bundan eski belgeler gelmez; kurulum günü önerilir).
4. Raflar: B2B'deki depo/raf listesi varsa **Raflar › Excel'den içe aktar** (aşağıda), yoksa **Toplu raf oluştur**
   (ör. A-C bölge, 1-10 koridor, 1-4 kat) → **Etiket yazdır** (PDF ya da etiket yazıcısı).
   Yazdırırken ölçek **%100 / gerçek boyut**.
5. **Kullanıcılar › Yeni kullanıcı**: depo personeli, 4-8 haneli şifre.
6. **Cihazlar › Yeni cihaz** (TRM-01…): açılan pencerede iki QR var (aşağıda).
7. İstenirse **Ayarlar › Vega'daki raf adresi**: stok kartı alanı (Ortaş: KOD10), raflar hangi depoda, **Program bu alana yazsın**.
   Terminalde rafa kaldırılan, transfer edilen ya da sayımda bulunan ürünün rafı o ürünün adresi olur ve ~3 sn sonra karta yazılır
   (Excel ve yönetici zimmetleri de). Alan boşsa ya da kartlarda yoksa Ayarlar'da ve günlükte açık uyarı çıkar. Kartta tek alan
   olduğundan yalnız seçili deponun adresleri yazılır. İlk yazma o alandaki eski bilgiyi bütün kartlardan siler (programda saklanır).
   Vega'yı okuma aralığı **Ayarlar › Sunucu › Vega yenileme** (varsayılan 60 sn); Özet'te son deneme, süre ve hata görünür,
   günlükte her okuma bir satırdır. İçerik değişmediyse terminallere haber gitmez.

Program kapatılınca saat yanında çalışmaya devam eder; terminaller bağlı kalır. Windows açılınca kendiliğinden başlar
(Ayarlar › Sunucu'dan kapatılabilir). Sunucu bilgisayarına modemden **sabit IP** verin; adres değişirse terminaller
bağlanamaz.

Veriler `%APPDATA%\ortas-depo-yonetici` klasöründedir (depo.db, config.json, yedek/, gunluk/). Her gün kendiliğinden
yedeklenir, son 30 yedek saklanır. Güncellemeler GitHub Releases'tan kendiliğinden iner.

## 2. Terminal

1. Cihazlar ekranındaki **1. QR**'ı terminalin kamerası ya da tarayıcısıyla okutun → APK iner, kurun
   ("bilinmeyen kaynak" izni). Ya da tarayıcıda `http://<sunucu-ip>:5480/kur`.
2. Uygulamada sağ üstteki ayar → **QR ile kur** alanına **2. QR**'ı okutun (terminalin okuyucusu ya da kamera).
   Sunucu adresi, cihaz anahtarı ve adı kendiliğinden dolar, eşitleme başlar.
3. Kullanıcı adı ve şifreyle giriş.

Okuyucu ayarı (klavye modu / yayın modu, marka marka): [TERMINAL.md](TERMINAL.md).

Yeni terminal sürümü yönetici programıyla birlikte gelir; terminal ana menüde "Yeni sürüm hazır" gösterir,
dokununca iner.

## 3. Depolar

Raflar, raf stoku, sayım ve hareketler depo bazlıdır (Vega'nın depoları). Kesin bir sınır yoktur:

- **Mal kabul belgesi kendi deposunu taşır.** Alış faturası Vega'da MERKEZ depoya girdiyse terminal hangi depoyu
  seçmiş olursa olsun mal MERKEZ'deki rafa kaldırılır; raf okutulurken MERKEZ rafları geçerlidir.
- Terminalde ana menünün üstündeki depo adına dokunarak **çalışılan depo** seçilir. Raf transferi, sayım, ürün/raf
  sorgu ve etiket bu depoda yapılır. Mal kabul listesi bütün depoların belgelerini gösterir (çalışılan depo önce).
- Yönetim ekranında sol üstteki seçiciyle tek depo ya da bütün depolar görüntülenir.
- Aynı raf kodu iki depoda olabilir (ör. A-01-01 hem MERKEZ hem FABRİKA'da).

## 4. Excel'den raf içe aktarma

**Raflar › Excel'den içe aktar.** `.xlsx` ya da `.csv`, ilk satır başlık. Bir satır bir raf:

| Sütun | Zorunlu | Not |
|---|---|---|
| Depo | evet* | Vega depo adı ya da numarası. Büyük-küçük harf, Türkçe harf farkı önemsiz ("merkez" = MERKEZ). Eşleşmeyen adlar pencerede elle seçilir. *Sütun yoksa hepsi seçilen tek depoya. |
| Raf | evet | Raf kodu (A-01-02) |
| Bölge, Not | hayır | |
| Ürün | hayır | Vega stok kodu ya da barkod |
| Miktar | hayır | Ürün + miktar: rafa o miktar yazılır (ilk yerleşim). Ürün, miktarsız: ürünün **asıl rafı** olur, terminal rafa kaldırırken o rafı önerir. |

Sütun adları farklı olabilir (Ambar, Raf Kodu, Lokasyon, Stok Kodu, Adet…); program tahmin eder, pencereden
düzeltilir. Önizlemede atlanacak satırlar nedeniyle listelenir. Boş şablon: pencerede **Şablon indir**.

## 5. Günlük kullanım

| İş | Terminalde | Yönetici programında |
|---|---|---|
| Rafa kaldırma | Rafa Kaldır → belge seç ya da okut → ürün → raf → miktar | Mal kabul: belge belge ilerleme; mal başka yere konduysa **Elle kapat** |
| Raf transferi | Raf Transferi → kaynak raf → ürün → miktar → hedef raf | Hareketler |
| Ürün / raf sorgu | Ana menüde ne okutulursa açılır | Ürün ve stok, Raflar |
| Sayım | Sayım → sayım seç → raf okut → ürünleri okut → Sayımı bitir → Gönder | Sayımlar → aç, kapat, **onayla** |

**Barkodu olmayan / okunmayan ürün:** her ürün okutma alanının altında **İsimle ara** var. Adın bir kısmı yazılır
(ör. "yag filtre"); Türkçe harf ve yazım hatası farkı tolere edilir, yakın adlar listelenir. Okutma alanına barkod
yerine ad yazılırsa da aynı liste açılır. Ürün kodu da okutulabilir ya da yazılabilir.

**İnternet/Wi-Fi yoksa:** işlemler terminalde kuyruğa alınır, bağlantı gelince kendiliğinden gönderilir
(Kuyruk ekranı). Giriş internetsiz de yapılır.

## 6. Sayım ve Vega

- Sayım bir depoda açılır; terminalde yalnız o depoyu seçen cihazlarda görünür.
- **Raf sayımı:** yalnız raf miktarları düzelir; Vega değişmez. İlk yerleşim (kurulumdan sonra bütün rafların bir kez
  sayılması) ve bölüm sayımları için.
- **Genel sayım:** onaylarken "Vega'ya sayım fişi yaz" seçilir. Ürün başına olması gereken = raflardaki toplam +
  rafa kaldırılmayı bekleyen. Fark, fiş kesildiği andaki Vega stokuna göre hesaplanır; artı fark **sayım giriş (93)**,
  eksi fark **sayım çıkış (94)** fişi olur, numara öneki ayardaki (varsayılan `T`). Hiç okutulmayan stoklu ürünler
  "Sayılmayan stoklu ürünleri ekle" ile dahil edilir.
- Yanlış onay **Onayı geri al** ile Vega'dan silinir.
- Terminalde başlatılan serbest sayım, gönderilince "Onay bekliyor" olarak gelir.

## 7. Şubeler (VPN)

Her şube kendi Vega deposuyla çalışır. Önerilen kurulum: **her şubede o şubenin bir bilgisayarına Ortaş Depo
Yönetici kurulur** ve Ayarlar'da o şubenin Vega deposu seçilir. Şube terminalleri şubedeki bu bilgisayara bağlanır
(yerel ağ, VPN gerekmez). Yalnız bu bilgisayarın Vega SQL Server'a ulaşması gerekir (FortiClient VPN sürekli bağlı,
SQL portu — genelde 1433 — VPN kuralında açık).

- VPN koparsa terminaller ve şube programı çalışmaya devam eder; Vega verisi son okunan haliyle kalır, VPN gelince
  yenilenir. Yalnız sayımın Vega'ya yazılması VPN ister.
- Şubeye özel **sayım fiş öneki** verin (ör. Samsun `S`, Ankara `A`): Ayarlar › Vega'ya yazılan sayım fişi.
- Merkezden bir şubenin ekranına bakmak için: şube programında yönetici parolası belirlenir, merkezden tarayıcıda
  `http://<şube-pc-vpn-ip>:5480` açılır.

Şubelerde FortiGate cihazı varsa site-to-site VPN de mümkündür; o durumda da yukarıdaki kurulum değişmez.

### Toybelen köprüsü (1.8.0+)

Şubede ayrı bir yönetici programı (veritabanı, Vega) istenmiyorsa — Ortaş'ta Toybelen böyle çalışır — şubedeki **FortiClient VPN'li
bilgisayarda** aynı exe **Köprü modunda** çalıştırılır. Köprü Toybelen'in yerel ağında `:5480` dinler ve terminallerin isteklerini
(`/api`, `/apk`, `/kur`) Merkez bilgisayarına VPN üzerinden iletir. Tek gerçek sunucu Merkez'dir: Toybelen'e yönetici programı kurulmaz,
Vega Merkez'den okunur, raflar ve işlemler Merkez'de durur. Tek exe olduğu için otomatik güncelleme tek kanaldan (GitHub) gelmeye devam eder.

1. Merkez'de Ayarlar › Depolar arası transfer: iki depoyu seçin (Merkez ve Toybelen) ve transferi açın.
2. Toybelen'deki bilgisayara kurulum programını çalıştırın. İlk açılışta **"Toybelen köprüsü"** seçin (sonra tepsi simgesi › *Çalışma
   biçimini değiştir…* ile değişir).
3. Açılan durum ekranına **Merkez adresini** yazın (Merkez bilgisayarının yerel ağ adresi ve port, örn. `192.168.1.10:5480`) ve *Kaydet ve sına*
   deyin: "Merkez'e ulaşılıyor · 24 ms" görünmeli. Merkez'in Özet sayfasında "Toybelen köprüsü: bağlı" çıkar.
4. Merkez'de Cihazlar › Kurulum QR'ında **bağlantı adresi** olarak köprüyü seçin (Toybelen terminalleri için); Merkez'dekiler için Merkez adresi.
   Terminalde Ayarlar › QR ile kur.

Köprü bilgisayarı kapalıysa ya da VPN koparsa Toybelen terminalleri çevrimdışı çalışır, işlemleri kuyruğa yazar ve bağlantı gelince gönderir.
Bu yüzden köprü bilgisayarı mesai boyunca açık, FortiClient bağlı olmalı (program Windows açılınca kendiliğinden başlar, uykuya geçmez).

**Sahada kontrol listesi (köprü ilk kez denenecek):**

- [ ] FortiGate VPN kuralında Merkez bilgisayarına **TCP 5480** açık mı? (Şimdiki kural yalnız SQL için 1433 olabilir.) Köprü bilgisayarından
      tarayıcıyla `http://<merkez-ip>:5480/api/ping` açılınca `{"ok":true…}` gelmeli.
- [ ] FortiClient VPN bağlıyken **yerel ağ kesiliyor mu?** (Tüm trafiği tünele alan "split tunnel kapalı" ayarı.) Toybelen terminalleri köprü
      bilgisayarına ulaşabilmeli: terminalin tarayıcısında `http://<köprü-ip>:5480/kur` açılmalı.
- [ ] Köprü bilgisayarına **sabit IP** verildi mi (modem DHCP rezervasyonu)? IP değişirse terminallerin QR'ı yenilenmeli.
- [ ] Wi-Fi'de **cihazlar arası yalıtım** (client isolation) kapalı mı? Terminaller Wi-Fi'de köprü bilgisayarına (kablolu olabilir) ulaşabilmeli.
- [ ] Windows güvenlik duvarı 5480'i yerel ağa açıyor mu (kurulum programı kuralı ekler).
