package tr.arcteknik.depo.sync

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import tr.arcteknik.depo.BuildConfig
import tr.arcteknik.depo.data.Op
import tr.arcteknik.depo.data.Repo
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Bir işlemin sunucudaki sonucu. `ok=false` kalıcı ret demek; işlem kuyrukta hata olarak kalır. */
data class OpResult(val id: String, val ok: Boolean, val error: String?)

/** Sunucudan gelen ana veri ve sürüm etiketi (ETag). */
class Master(val json: JSONObject, val etag: String?)

/** Terminalin konuştuğu sunucu. Sözleşme: `docs/API.md`. */
interface Backend {
    /**
     * Ulaşılamazsa IOException atar. [etag] verilirse ve sunucuda değişiklik yoksa null döner (304);
     * her dakikalık eşitlemede bütün ürün listesi yeniden inmesin.
     */
    fun master(etag: String?): Master?

    fun pushOps(ops: List<Op>, user: String): List<OpResult>

    /**
     * Sunucu bilgisayarındaki etiket yazıcısına etiket bastırır. [type]: "PRODUCT" ya da "SHELF".
     * Dönen: kullanıcıya gösterilecek metin. Ulaşılamazsa IOException.
     */
    fun printLabel(type: String, id: String, copies: Int, user: String, depot: Int): String
}

/**
 * Sunucu kurulmadan denemek için. Ana veri uygulamaya gömülü örnekten gelir; gönderilen işlemler
 * kabul edilir. Cihazın ağı kapalıyken sunucu da "kapalı" sayılır ki çevrimdışı kuyruk denenebilsin.
 */
class DemoBackend(private val context: Context, private val online: () -> Boolean) : Backend {
    override fun master(etag: String?): Master {
        if (!online()) throw IOException("Ağ yok")
        val json = JSONObject(context.assets.open("demo.json").bufferedReader(Charsets.UTF_8).use { it.readText() })
        val users = json.optJSONArray("users") ?: JSONArray()
        for (i in 0 until users.length()) {
            val u = users.getJSONObject(i)
            if (!u.has("pinHash")) {
                val salt = "demo-" + u.getString("username")
                u.put("salt", salt).put("pinHash", Repo.hashPin(salt, u.getString("demoPin")))
                u.remove("demoPin")
            }
        }
        return Master(json, null)
    }

    override fun pushOps(ops: List<Op>, user: String): List<OpResult> {
        if (!online()) throw IOException("Ağ yok")
        return ops.map { OpResult(it.id, true, null) }
    }

    override fun printLabel(type: String, id: String, copies: Int, user: String, depot: Int): String =
        throw IOException("Demo modunda etiket basılmaz")
}

class HttpBackend(private val baseUrl: String, private val deviceKey: String, private val deviceName: String) : Backend {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun request(path: String) = Request.Builder()
        .url(baseUrl + path)
        .header("X-Device-Key", deviceKey)
        .header("X-Device-Name", deviceName)
        .header("X-App-Version", BuildConfig.VERSION_NAME)

    override fun master(etag: String?): Master? {
        val req = request("/api/master").apply { if (etag != null) header("If-None-Match", etag) }.get().build()
        client.newCall(req).execute().use { r ->
            if (r.code == 304) return null
            if (!r.isSuccessful) throw IOException(errorText(r.code, r.body?.string()))
            return Master(JSONObject(r.body!!.string()), r.header("ETag"))
        }
    }

    override fun pushOps(ops: List<Op>, user: String): List<OpResult> {
        val arr = JSONArray()
        ops.forEach {
            arr.put(JSONObject().put("id", it.id).put("type", it.type).put("createdAt", it.createdAt).put("payload", JSONObject(it.payload)))
        }
        val body = JSONObject().put("device", deviceName).put("user", user).put("ops", arr).toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        client.newCall(request("/api/ops").post(body).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException(errorText(r.code, r.body?.string()))
            val res = JSONObject(r.body!!.string()).getJSONArray("results")
            return (0 until res.length()).map {
                val o = res.getJSONObject(it)
                OpResult(o.getString("id"), o.getBoolean("ok"), o.optString("error").ifBlank { null })
            }
        }
    }

    override fun printLabel(type: String, id: String, copies: Int, user: String, depot: Int): String {
        val body = JSONObject().put("type", type).put("copies", copies).put("user", user).put("depot", depot)
            .put(if (type == "SHELF") "shelf" else "productId", id).toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        client.newCall(request("/api/label").post(body).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException(errorText(r.code, r.body?.string()))
            val o = JSONObject(r.body!!.string())
            return "${o.optInt("etiket", copies)} etiket ${o.optString("yazici", "yazıcıya")} yazıcısına gönderildi"
        }
    }

    private fun errorText(code: Int, body: String?): String {
        val msg = runCatching { JSONObject(body ?: "").optString("error") }.getOrNull().orEmpty()
        return when (code) {
            401, 403 -> "Cihaz yetkili değil. Yönetici programında bu cihazı onaylayın."
            else -> "Sunucu hatası ($code) $msg".trim()
        }
    }
}
