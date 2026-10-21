package tr.arcteknik.depo.data

import android.content.Context
import org.json.JSONObject

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

    /** Son alınan ana verinin sürüm etiketi; değişmediyse sunucu 304 döner. */
    var masterEtag: String
        get() = sp.getString("masterEtag", "") ?: ""
        set(v) = sp.edit().putString("masterEtag", v).apply()

    /** Sunucudaki terminal uygulamasının sürümü (yönetici programıyla gelir). */
    var updateCode: Int
        get() = sp.getInt("updateCode", 0)
        set(v) = sp.edit().putInt("updateCode", v).apply()

    var updateName: String
        get() = sp.getString("updateName", "") ?: ""
        set(v) = sp.edit().putString("updateName", v).apply()

    var updatePath: String
        get() = sp.getString("updatePath", "/apk") ?: "/apk"
        set(v) = sp.edit().putString("updatePath", v).apply()

    /** Ana veriyle gelen depo adı ve uygulama sürümü bilgisini saklar. */
    fun applyMaster(json: JSONObject) {
        json.optString("warehouse").takeIf { it.isNotBlank() }?.let { warehouse = it }
        val app = json.optJSONObject("app")
        if (app != null) {
            updateCode = app.optInt("versionCode", 0)
            updateName = app.optString("versionName", "")
            updatePath = app.optString("path", "/apk")
        } else {
            updateCode = 0
        }
    }

    /** Sunucuda bu cihazdakinden yeni uygulama varsa indirme adresi. */
    fun updateUrl(currentCode: Int): String? =
        if (!demo && serverUrl.isNotBlank() && updateCode > currentCode) serverUrl + updatePath else null

    /** Telefonlarda kamera düğmesini gösterir; el terminalinde kapalı tutulabilir. */
    var cameraButton: Boolean
        get() = sp.getBoolean("cameraButton", true)
        set(v) = sp.edit().putBoolean("cameraButton", v).apply()
}
