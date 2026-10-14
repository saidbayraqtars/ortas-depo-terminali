package tr.arcteknik.depo.data

import android.content.Context

/** Cihaz ayarları. Sunucu adresi ve cihaz anahtarı yönetici programından alınır. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("ayarlar", Context.MODE_PRIVATE)

    /** Demo modunda sunucu yoktur; ana veri uygulamanın içindeki örnek veriden gelir. */
    var demo: Boolean
        get() = sp.getBoolean("demo", true)
        set(v) = sp.edit().putBoolean("demo", v).apply()

    /** Örnek: http://192.168.1.20:5480 */
    var serverUrl: String
        get() = sp.getString("serverUrl", "") ?: ""
        set(v) = sp.edit().putString("serverUrl", v.trim().trimEnd('/')).apply()

    var deviceKey: String
        get() = sp.getString("deviceKey", "") ?: ""
        set(v) = sp.edit().putString("deviceKey", v.trim()).apply()

    var deviceName: String
        get() = sp.getString("deviceName", "TRM-01") ?: "TRM-01"
        set(v) = sp.edit().putString("deviceName", v.trim()).apply()

    var warehouse: String
        get() = sp.getString("warehouse", "Merkez Depo") ?: "Merkez Depo"
        set(v) = sp.edit().putString("warehouse", v).apply()

    var lastUser: String
        get() = sp.getString("lastUser", "") ?: ""
        set(v) = sp.edit().putString("lastUser", v).apply()

    var lastSync: Long
        get() = sp.getLong("lastSync", 0L)
        set(v) = sp.edit().putLong("lastSync", v).apply()

    var lastSyncError: String
        get() = sp.getString("lastSyncError", "") ?: ""
        set(v) = sp.edit().putString("lastSyncError", v).apply()

    /** Telefonlarda kamera düğmesini gösterir; el terminalinde kapalı tutulabilir. */
    var cameraButton: Boolean
        get() = sp.getBoolean("cameraButton", true)
        set(v) = sp.edit().putBoolean("cameraButton", v).apply()
}
