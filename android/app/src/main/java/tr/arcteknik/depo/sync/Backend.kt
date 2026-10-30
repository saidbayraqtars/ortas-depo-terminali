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
import java.io.Reader
import java.io.StringReader
import java.util.concurrent.TimeUnit

/**
 * Bir işlemin sunucudaki sonucu. `ok=false` kalıcı ret demek; işlem kuyrukta hata olarak kalır. [code] ret nedeni:
 * "YETKI" kullanıcının bu işleme ya da depoya yetkisi yok (1.9.0+ sunucu); eski sunucuda hep null.
 */
data class OpResult(val id: String, val ok: Boolean, val error: String?, val code: String? = null)

/**
 * Belge kilidi cevabı (1.8.0+ sunucu, docs/API.md "Belge kilidi"). [supported] false: sunucu kilidi bilmiyor (eski yönetici
 * programı), belge kilitsiz açılır. [ok] false ise [holder] "Ahmet (TRM-03) kullanıyor" gibi tutan kişiyi, nabızda [reason]
 * kilidin neden gittiğini söyler (yonetici: yönetici açtı, baska: başka terminal aldı, yok: kayıt yok).
 */
data class LockReply(val supported: Boolean = true, val ok: Boolean = false, val token: String = "", val holder: String = "", val reason: String = "")

/** Şu an tutulan bir belge ([id] terminalin kilitlerken kullandığı kimlik). */
data class LockInfo(val id: String, val user: String, val device: String)

/** Terminalin konuştuğu sunucu. Sözleşme: `docs/API.md`. */
interface Backend {
    /**
     * Ana veriyi [read]'e akış olarak verir (ikinci parametre yeni ETag); 130 bin ürünlük liste belleğe tek parça
     * alınmaz. Ulaşılamazsa IOException atar. [etag] verilirse ve sunucuda değişiklik yoksa [read] çağrılmaz,
     * false döner (304); her dakikalık eşitlemede bütün ürün listesi yeniden inmesin.
     */
    fun master(etag: String?, read: (Reader, String?) -> Unit): Boolean

    /**
     * Ana verinin yalnız değişen parçaları (1.3.0+ sunucu, `POST /api/master/parts`): [known] elimizdeki parça
     * özetleri, [max] bir istekte en çok kaç kova. Cevap [read]'e akış olarak verilir. Sunucu bunu bilmiyorsa
     * (eski yönetici programı) false döner; o zaman [master] kullanılır.
     */
    fun masterParts(known: Map<String, String>, max: Int, read: (Reader) -> Unit): Boolean

    /**
     * Sunucuda [since] sayacından sonra bir değişiklik olana kadar en çok [waitSec] sn bekler (1.5.0+ sunucu,
     * `GET /api/changes`). Dönen: sunucunun güncel sayacı; [since]'e eşitse süre doldu, değişiklik yok. Sunucu bu ucu
     * bilmiyorsa (eski yönetici programı) -1. Ulaşılamazsa IOException.
     */
    fun waitChange(since: Int, waitSec: Int): Int

    fun pushOps(ops: List<Op>, user: String): List<OpResult>

    /**
     * Sunucu bilgisayarındaki etiket yazıcısına etiket bastırır. [type]: "PRODUCT" ya da "SHELF".
     * Dönen: kullanıcıya gösterilecek metin. Ulaşılamazsa IOException.
     */
    fun printLabel(type: String, id: String, copies: Int, user: String, depot: Int): String

    /** Belgeyi kilitler (`POST /api/lock`). Ulaşılamazsa IOException. */
    fun lock(docId: String, kind: String, docNo: String, user: String): LockReply

    /** Tutan terminalin nabzı (`POST /api/lock/ping`), 30 sn'de bir. Ulaşılamazsa IOException. */
    fun lockPing(docId: String, token: String): LockReply

    /** Kilidi bırakır (`POST /api/lock/release`); en iyi çaba, hata yutulur. */
    fun lockRelease(docId: String, token: String)

    /** Şu an tutulan belgeler (`GET /api/locks`); listelerde kilit simgesi için. Sunucu bilmiyorsa null. */
    fun locks(): List<LockInfo>?
}

/**
 * Sunucu kurulmadan denemek için. Ana veri uygulamaya gömülü örnekten gelir; gönderilen işlemler
 * kabul edilir. Cihazın ağı kapalıyken sunucu da "kapalı" sayılır ki çevrimdışı kuyruk denenebilsin.
 */
class DemoBackend(private val context: Context, private val online: () -> Boolean) : Backend {
    override fun master(etag: String?, read: (Reader, String?) -> Unit): Boolean {
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
        read(StringReader(json.toString()), null)
        return true
    }

    override fun masterParts(known: Map<String, String>, max: Int, read: (Reader) -> Unit) = false

    override fun waitChange(since: Int, waitSec: Int) = -1

    override fun pushOps(ops: List<Op>, user: String): List<OpResult> {
        if (!online()) throw IOException("Ağ yok")
        return ops.map { OpResult(it.id, true, null) }
    }

    override fun printLabel(type: String, id: String, copies: Int, user: String, depot: Int): String =
        throw IOException("Demo modunda etiket basılmaz")

    override fun lock(docId: String, kind: String, docNo: String, user: String) = LockReply(supported = false)

    override fun lockPing(docId: String, token: String) = LockReply(supported = false)

    override fun lockRelease(docId: String, token: String) = Unit

    override fun locks(): List<LockInfo>? = null
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

    override fun master(etag: String?, read: (Reader, String?) -> Unit): Boolean {
        val req = request("/api/master").apply { if (etag != null) header("If-None-Match", etag) }.get().build()
        client.newCall(req).execute().use { r ->
            if (r.code == 304) return false
            if (!r.isSuccessful) throw IOException(errorText(r.code, r.body?.string()))
            read(r.body!!.charStream(), r.header("ETag"))
            return true
        }
    }

    override fun masterParts(known: Map<String, String>, max: Int, read: (Reader) -> Unit): Boolean {
        val k = JSONObject()
        known.forEach { (key, hash) -> k.put(key, hash) }
        // v=2: Vega stoku kovadan ayrı parçada gelir (docs/API.md "Stok parçaları"); eski sunucu bunu yok sayar.
        val body = JSONObject().put("known", k).put("max", max).put("v", 2).toString().toRequestBody("application/json; charset=utf-8".toMediaType())
        client.newCall(request("/api/master/parts").post(body).build()).execute().use { r ->
            if (r.code == 404) return false
            if (!r.isSuccessful) throw IOException(errorText(r.code, r.body?.string()))
            read(r.body!!.charStream())
            return true
        }
    }

    // Değişiklik beklerken sunucu 25 sn'ye kadar cevap vermez; okuma süresi buna göre uzun.
    private val waitClient = client.newBuilder().readTimeout(40, TimeUnit.SECONDS).build()

    override fun waitChange(since: Int, waitSec: Int): Int {
        val req = request("/api/changes?since=$since&wait=$waitSec").get().build()
        waitClient.newCall(req).execute().use { r ->
            if (r.code == 404) return -1
            if (!r.isSuccessful) throw IOException(errorText(r.code, r.body?.string()))
            return JSONObject(r.body!!.string()).optInt("surum", -1)
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
                OpResult(o.getString("id"), o.getBoolean("ok"), o.optString("error").ifBlank { null }, o.optString("code").ifBlank { null })
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

    private fun lockCall(path: String, body: JSONObject): LockReply {
        client.newCall(request(path).post(body.put("device", deviceName).toString().toRequestBody("application/json; charset=utf-8".toMediaType())).build()).execute().use { r ->
            if (r.code == 404) return LockReply(supported = false)
            if (!r.isSuccessful) throw IOException(errorText(r.code, r.body?.string()))
            val o = JSONObject(r.body!!.string())
            return LockReply(
                ok = o.optBoolean("ok", false),
                token = o.optString("token"),
                holder = o.optJSONObject("holder")?.optString("mesaj").orEmpty(),
                reason = o.optString("neden"),
            ).let { if (it.holder.isBlank() && o.optJSONObject("holder") != null) it.copy(holder = "Başka bir terminal kullanıyor") else it }
        }
    }

    override fun lock(docId: String, kind: String, docNo: String, user: String) =
        lockCall("/api/lock", JSONObject().put("docId", docId).put("kind", kind).put("docNo", docNo).put("user", user))

    override fun lockPing(docId: String, token: String) =
        lockCall("/api/lock/ping", JSONObject().put("docId", docId).put("token", token)).let {
            // Nabızda "başka" cevabı tutanı da taşır; mesaj olarak da kullanılır.
            if (!it.ok && it.reason == "baska" && it.holder.isBlank()) it.copy(holder = "Başka bir terminal aldı") else it
        }

    override fun lockRelease(docId: String, token: String) {
        runCatching { lockCall("/api/lock/release", JSONObject().put("docId", docId).put("token", token)) }
    }

    override fun locks(): List<LockInfo>? {
        client.newCall(request("/api/locks").get().build()).execute().use { r ->
            if (r.code == 404) return null
            if (!r.isSuccessful) throw IOException(errorText(r.code, r.body?.string()))
            val a = JSONObject(r.body!!.string()).optJSONArray("locks") ?: return emptyList()
            return (0 until a.length()).map { a.getJSONObject(it) }.map { LockInfo(it.getString("id"), it.optString("user"), it.optString("device")) }
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
