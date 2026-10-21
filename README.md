# Ortaş Depo Terminali

Ortaş Otomotiv için depo yönetimi (WMS). Vega ERP'de mal kabulü yapılan malzemeyi Android el terminaliyle
rafa kaldırma, raf transferi, ürün/raf sorgu, sayım ve raf/ürün etiketi. İnternet çekmeyen yerlerde de çalışır.

| Klasör | İçerik |
|---|---|
| [`android/`](android/) | Terminal ve telefon uygulaması (Kotlin + Compose, Android 8.0+) |
| [`yonetici/`](yonetici/) | Ortaş Depo Yönetici: Windows programı, terminallerin bağlandığı sunucu + yönetim ekranı (Electron) |
| [`docs/KURULUM.md`](docs/KURULUM.md) | Kurulum, günlük kullanım, sayım ve Vega, şubeler |
| [`docs/API.md`](docs/API.md) | Terminal ile sunucu arasındaki sözleşme |
| [`docs/TERMINAL.md`](docs/TERMINAL.md) | Terminal kurulumu ve okuyucu ayarları (marka marka) |
| [`tasarim/`](tasarim/) | Arayüz taslağı (10 ekran) ve PNG çıktıları |

Çıktılar (`cikti/`, depoda değil; [Releases](../../releases)):

- `OrtasDepoYonetici-Kurulum-<sürüm>.exe` — yönetici programı (APK içinde gelir; terminaller `/kur` adresinden indirir)
- `OrtasDepo-<sürüm>.apk` — terminal uygulaması (yalnız ARM; el terminalleri ve telefonlar)

Ekranlardaki ürün, belge ve tedarikçi adları örnektir.
