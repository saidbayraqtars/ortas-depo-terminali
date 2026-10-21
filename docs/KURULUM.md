# Kurulum ve kullanım

Sistem iki parçadır:

- **Ortaş Depo Yönetici** (Windows): depodaki bir bilgisayara kurulur. Hem yönetim ekranı hem de el terminallerinin
  bağlandığı sunucudur. Vega'yı (SQL Server) okur; yalnız onaylanan sayımı Vega'ya yazar.
- **Ortaş Depo Terminali** (Android 8+): el terminali ya da telefon. Yönetici programındaki sunucuya bağlanır,
  internetsizken de çalışır.

## 1. Yönetici programı

1. `OrtasDepoYonetici-Kurulum-<sürüm>.exe` ile kurun (yönetici izni ister: Windows Güvenlik Duvarı'na programın
   kuralını ekler).
2. Program açılınca **Ayarlar › Vega bağlantısı**: SQL sunucu adı, kullanıcı, parola → **Bağlantıyı dene** →
   firma, dönem (Otomatik önerilir; yıl değişince yeni dönemi kendisi seçer) ve **depo** → **Kaydet**.
3. **Ayarlar › Mal kabul**: hangi Vega belgeleri rafa kaldırılacak iş sayılsın (alış faturası 20, alış irsaliyesi 26,
   stok giriş fişi 32) ve başlangıç tarihi (bundan eski belgeler gelmez; kurulum günü önerilir).
4. **Raflar › Toplu raf oluştur** (ör. A-C bölge, 1-10 koridor, 1-4 kat) → **Etiket yazdır** (PDF; A4 etiket
   kâğıdı ya da etiket yazıcısı boyutları). Yazdırırken ölçek **%100 / gerçek boyut**.
5. **Kullanıcılar › Yeni kullanıcı**: depo personeli, 4-8 haneli şifre.
6. **Cihazlar › Yeni cihaz** (TRM-01…): açılan pencerede iki QR var (aşağıda).

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

## 3. Günlük kullanım

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

## 4. Sayım ve Vega

- **Raf sayımı:** yalnız raf miktarları düzelir; Vega değişmez. İlk yerleşim (kurulumdan sonra bütün rafların bir kez
  sayılması) ve bölüm sayımları için.
- **Genel sayım:** onaylarken "Vega'ya sayım fişi yaz" seçilir. Ürün başına olması gereken = raflardaki toplam +
  rafa kaldırılmayı bekleyen. Fark, fiş kesildiği andaki Vega stokuna göre hesaplanır; artı fark **sayım giriş (93)**,
  eksi fark **sayım çıkış (94)** fişi olur, numara öneki ayardaki (varsayılan `T`). Hiç okutulmayan stoklu ürünler
  "Sayılmayan stoklu ürünleri ekle" ile dahil edilir.
- Yanlış onay **Onayı geri al** ile Vega'dan silinir.
- Terminalde başlatılan serbest sayım, gönderilince "Onay bekliyor" olarak gelir.

## 5. Şubeler (VPN)

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
