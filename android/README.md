# Ortaş Depo Terminali (Android)

Vega'da kabul edilen malzemeyi el terminaliyle rafa kaldırma, raf transferi, ürün/raf sorgu ve sayım.
Çevrimdışı çalışır; işlemler cihazda kuyruğa alınır, bağlantı gelince yönetici programındaki sunucuya gider.

- Kotlin + Jetpack Compose, minSdk 25 (Android 7.1; sahadaki en eski terminal 7.1.2), yerel veri SQLite (`data/Db.kt`).
- Sunucu sözleşmesi: [`../docs/API.md`](../docs/API.md). Terminal kurulumu: [`../docs/TERMINAL.md`](../docs/TERMINAL.md).
- Demo modu (varsayılan açık): sunucu olmadan `app/src/main/assets/demo.json` ile çalışır.
  Demo kullanıcı adları ve şifreleri o dosyadadır.
- İkonlar Reicon'dan (MIT), yazı tipi IBM Plex (OFL).

## Derleme

Proje yolunda `ş` olduğu için `gradle.properties` içinde `android.overridePathCheck=true` var.

```bash
./gradlew assembleDebug      # emülatör ve deneme
./gradlew assembleRelease    # cihazlara kurulacak sürüm (yalnız ARM)
```

Android Studio'nun JBR'ı (`C:\Program Files\Android\Android Studio\jbr`) `JAVA_HOME` olarak yeterli.

## İmza anahtarı

Sürüm APK'sı `keystore/ortas-depo.jks` ile imzalanır; parola `keystore.properties` içinde.
İkisi de depoya girmez (`.gitignore`). **Bu anahtar kaybolursa** cihazlardaki uygulama güncellenemez,
silip yeniden kurmak gerekir (gönderilmemiş işlemler kaybolur). Yedeğini güvenli yerde tutun.

## Yapı

| Klasör | İçerik |
|---|---|
| `data/` | SQLite şeması, ana veri içe alma, depo işlemleri (`Repo`) |
| `sync/` | Sunucu istemcisi, demo sunucusu, eşitleme sırası, WorkManager |
| `scan/` | Okuyucu yayınları, ses/titreşim, kamera ile okuma |
| `ui/` | Tema, ortak bileşenler, ekranlar |
