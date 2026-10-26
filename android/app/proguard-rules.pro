# Hata raporlarında satır numaraları ve sınıf adları okunsun (diag/Diag.kt yığın izi gönderir).
-dontobfuscate
-keepattributes SourceFile,LineNumberTable
# Uyarı verip derlemeyi durdurmasın: ML Kit / CameraX isteğe bağlı sınıflar.
-dontwarn com.google.mlkit.**
