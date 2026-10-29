import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// İmza anahtarı depoya girmez: android/keystore.properties + android/keystore/ (bkz. README).
val keyProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "tr.arcteknik.depo"
    compileSdk = 36

    defaultConfig {
        applicationId = "tr.arcteknik.depo"
        // Sahadaki en eski el terminali Android 7.1.2 (API 25).
        minSdk = 25
        targetSdk = 35
        versionCode = 13
        versionName = "1.8.2"
        // Çökme/donma raporları: nevaqr VPS'teki hata toplayıcı (araclar/hata-toplayici). Anahtar keystore.properties'te.
        buildConfigField("String", "REPORT_URL", "\"https://lisans.neva.technology/hata/v1/rapor\"")
        buildConfigField("String", "REPORT_KEY", "\"${keyProps.getProperty("raporAnahtari", "")}\"")
    }

    signingConfigs {
        if (keyProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keyProps.getProperty("storeFile"))
                storePassword = keyProps.getProperty("storePassword")
                keyAlias = keyProps.getProperty("keyAlias")
                keyPassword = keyProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // R8: kullanılmayan kod ve kaynak atılır (başlangıç ve bellek). İsimler korunur (-dontobfuscate): uzaktan hata
            // raporlarındaki (diag/Diag.kt) yığın izleri okunur kalsın, eşleme dosyası gerekmesin.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            // El terminalleri ve telefonlar ARM; x86 yalnız emülatör için (debug'da kalır).
            ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a") }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.06.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Telefonlarda kamera ile okutma. ML Kit'in gömülü modeli Google Play Hizmetleri istemez.
    implementation("androidx.camera:camera-camera2:1.6.1")
    implementation("androidx.camera:camera-lifecycle:1.6.1")
    implementation("androidx.camera:camera-view:1.6.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
}
