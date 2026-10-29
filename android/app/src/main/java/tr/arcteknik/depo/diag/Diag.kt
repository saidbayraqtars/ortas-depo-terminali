package tr.arcteknik.depo.diag

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.Process
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import tr.arcteknik.depo.BuildConfig
import tr.arcteknik.depo.data.Prefs
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Sahadaki çökme ve donmaları uzaktan görmek için. Said terminallere dokunamıyor; raporlar
 * yönetici programına (`/api/rapor`, günlüğe yazar) ve nevaqr VPS'teki hata toplayıcıya gider
 * (`araclar/hata-toplayici/`). Gönderilemeyen rapor cihazda bekler, sonraki eşitlemede yeniden denenir.
 *
 * Yakalananlar:
 *  - Kotlin/Java çökmesi (yakalanmamış istisna): yığın izi.
 *  - Donma: ana iş parçacığı 5 sn yanıt vermezse o anki yığını ve diğer iş parçacıkları (Android "yanıt vermiyor" der).
 *  - Önceki oturumun sistemce öldürülmesi: Android 11+ ApplicationExitInfo; eskilerde logcat'teki "Fatal signal" vb.
 * Her rapora son olaylar (okutmalar, ekran geçişleri, mesajlar, eşitleme süreleri) eklenir.
 */
object Diag {
    private const val APP = "ortas-terminal"
    private const val MAX_FILES = 40
    private const val ANR_MS = 5000L

    private lateinit var dir: File
    private lateinit var prefs: Prefs
    private lateinit var appContext: Context
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "diag").apply { isDaemon = true } }
    private val crumbs = ArrayDeque<String>()
    private var previousCrumbs: List<String> = emptyList()
    private val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private val started = System.currentTimeMillis()

    /** Ekranda o an hangi ekran açık; raporlara eklenir. */
    @Volatile
    var route: String = ""

    private val client by lazy {
        OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).writeTimeout(15, TimeUnit.SECONDS).build()
    }

    fun init(context: Context, prefs: Prefs) {
        appContext = context.applicationContext
        this.prefs = prefs
        dir = File(context.filesDir, "rapor").apply { mkdirs() }
        // Önceki oturumun son olayları: sistem öldürdüyse (yerel çökme, donma) rapor bunlarla gider.
        previousCrumbs = runCatching { File(dir, "olaylar.txt").readLines() }.getOrDefault(emptyList())

        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            runCatching {
                crumb("ÇÖKME ${t.name}: $e")
                write(report("crash", e.toString(), e.stackTraceToString(), mainThread = false))
                // Uygulama birazdan kapanacak; kısa bir gönderme denemesi, olmazsa sonraki açılışta.
                val th = Thread { runCatching { sendPending() } }
                th.start()
                th.join(2500)
            }
            previous?.uncaughtException(t, e)
        }

        crumb("açıldı ${BuildConfig.VERSION_NAME} pid ${Process.myPid()}")
        startWatchdog()
        io.execute { runCatching { checkPreviousExit() } }
    }

    /** Olay kaydı: okutma, ekran, mesaj, eşitleme. Son 400 olay saklanır (50-60 kalemlik belge okutması 150+ olay yazar). */
    fun crumb(text: String) {
        val line = "${time.format(Date())} ${text.take(300)}"
        val snapshot: List<String>
        synchronized(crumbs) {
            crumbs.addLast(line)
            while (crumbs.size > 400) crumbs.removeFirst()
            snapshot = crumbs.toList()
        }
        if (::dir.isInitialized) io.execute { runCatching { File(dir, "olaylar.txt").writeText(snapshot.joinToString("\n")) } }
    }

    /** Kullanıcı Ayarlar'dan "Tanı raporu gönder" dediğinde; logcat ve olaylarla. */
    fun manual(note: String) {
        io.execute {
            runCatching {
                val r = report("manual", note.ifBlank { "Elle gönderildi" }, null, mainThread = true)
                r.put("logcat", logcat(1500).joinToString("\n"))
                write(r)
                sendPending()
            }
        }
    }

    /** Yakalanmış ama önemli hata (örneğin eşitleme istisnası); aynı metin oturumda bir kez gider. */
    private val sentErrors = mutableSetOf<String>()

    fun error(where: String, e: Throwable) {
        val key = where + e.javaClass.name + e.message
        synchronized(sentErrors) { if (!sentErrors.add(key)) return }
        io.execute { runCatching { write(report("error", "$where: $e", e.stackTraceToString(), mainThread = false)) } }
    }

    // ---- Donma bekçisi ------------------------------------------------------------------------

    private fun startWatchdog() {
        val main = Handler(Looper.getMainLooper())
        Thread({
            var reported = false
            var blockedSince = 0L
            while (true) {
                val ticked = AtomicBoolean(false)
                val tick = Runnable { ticked.set(true) }
                val t0 = System.currentTimeMillis()
                main.post(tick)
                // Yarım saniyede bir bak; ana iş parçacığı dönünce hemen sonraki tura geç.
                while (!ticked.get() && System.currentTimeMillis() - t0 < ANR_MS) Thread.sleep(250)
                if (ticked.get()) {
                    if (reported) crumb("donma bitti ${System.currentTimeMillis() - blockedSince} ms")
                    reported = false
                    Thread.sleep(1000)
                    continue
                }
                main.removeCallbacks(tick)
                if (!reported && !Debug.isDebuggerConnected()) {
                    reported = true
                    blockedSince = t0
                    runCatching {
                        val stack = Looper.getMainLooper().thread.stackTrace.joinToString("\n") { "    at $it" }
                        val top = Looper.getMainLooper().thread.stackTrace.firstOrNull { it.className.startsWith("tr.arcteknik") }
                        crumb("DONMA 5 sn: ${top ?: "?"}")
                        write(report("anr", "Ana iş parçacığı ${ANR_MS / 1000} sn yanıt vermiyor${top?.let { " · $it" } ?: ""}", stack, mainThread = false))
                        sendPending()
                    }
                }
            }
        }, "diag-bekci").apply { isDaemon = true; priority = Thread.MAX_PRIORITY }.start()
    }

    // ---- Önceki oturum ------------------------------------------------------------------------

    private fun checkPreviousExit() {
        val sp = appContext.getSharedPreferences("tani", Context.MODE_PRIVATE)
        val last = sp.getLong("exitChecked", 0L)
        sp.edit().putLong("exitChecked", System.currentTimeMillis()).apply()
        if (Build.VERSION.SDK_INT >= 30) {
            val am = appContext.getSystemService(ActivityManager::class.java)
            for (x in am.getHistoricalProcessExitReasons(appContext.packageName, 0, 10)) {
                if (x.timestamp <= last) continue
                // Java çökmesini zaten kendimiz yakaladık; kullanıcının kapatması / güncelleme rapor değil.
                val interesting = when (x.reason) {
                    ApplicationExitInfo.REASON_ANR, ApplicationExitInfo.REASON_CRASH_NATIVE, ApplicationExitInfo.REASON_LOW_MEMORY,
                    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE, ApplicationExitInfo.REASON_INITIALIZATION_FAILURE,
                    ApplicationExitInfo.REASON_SIGNALED,
                    -> true
                    else -> false
                }
                if (!interesting) continue
                val trace = if (x.reason == ApplicationExitInfo.REASON_ANR) {
                    runCatching { x.traceInputStream?.bufferedReader()?.use { it.readText() } }.getOrNull()?.take(200_000)
                } else null
                val r = report("exit", "Önceki oturum kapandı: ${exitReason(x.reason)} · ${x.description ?: ""}", trace, mainThread = false)
                r.put("exit", JSONObject().put("reason", exitReason(x.reason)).put("status", x.status).put("importance", x.importance)
                    .put("pssKb", x.pss).put("rssKb", x.rss).put("at", iso(x.timestamp)))
                r.put("crumbs", JSONArray(previousCrumbs))
                write(r)
            }
        } else if (last > 0) {
            // Android 7–10: önceki sürecin ölümü logcat'te kalır (aynı uygulama kendi satırlarını okuyabilir).
            val me = Process.myPid().toString()
            val lines = logcat(3000)
            val others = lines.filter { pidOf(it).let { p -> p != null && p != me } }
            val fatal = others.lastOrNull { l -> FATAL.any { l.contains(it) } }
            if (fatal != null) {
                val r = report("exit", "Önceki oturum kapandı: ${fatal.substringAfter(": ").take(200)}", null, mainThread = false)
                r.put("logcat", others.takeLast(600).joinToString("\n"))
                r.put("crumbs", JSONArray(previousCrumbs))
                write(r)
            }
        }
        sendPending()
    }

    private val FATAL = listOf("Fatal signal", "FATAL EXCEPTION", "ANR in", "beginning of crash", "Out of memory", "OutOfMemoryError", "lowmemorykiller")

    private fun pidOf(line: String): String? =
        // threadtime: "10-26 14:03:11.123  1234  1250 E Tag: mesaj"
        line.trim().split(Regex("\\s+")).getOrNull(2)?.takeIf { it.all(Char::isDigit) }

    private fun exitReason(r: Int) = when (r) {
        ApplicationExitInfo.REASON_ANR -> "ANR (yanıt vermiyor)"
        ApplicationExitInfo.REASON_CRASH -> "çökme"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "yerel çökme"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "bellek yetersiz"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "aşırı kaynak"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "başlatma hatası"
        ApplicationExitInfo.REASON_SIGNALED -> "sinyal"
        else -> "neden $r"
    }

    private fun logcat(lines: Int): List<String> = runCatching {
        val p = ProcessBuilder("/system/bin/logcat", "-d", "-v", "threadtime", "-t", lines.toString()).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().use { it.readLines() }
        // -d ile logcat döküp çıkar; akış bitti demek süreç bitti demek. waitFor(süre) Android 8 ister.
        p.waitFor()
        out.ifEmpty { listOf("(logcat boş, çıkış ${runCatching { p.exitValue() }.getOrNull()})") }
    }.getOrElse { listOf("(logcat okunamadı: $it)") }

    // ---- Rapor --------------------------------------------------------------------------------

    private fun iso(ms: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US).format(Date(ms))

    private fun report(kind: String, summary: String, stack: String?, mainThread: Boolean): JSONObject {
        val rt = Runtime.getRuntime()
        val am = appContext.getSystemService(ActivityManager::class.java)
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val r = JSONObject()
            .put("id", UUID.randomUUID().toString().replace("-", ""))
            .put("app", APP)
            .put("kind", kind)
            .put("time", iso(System.currentTimeMillis()))
            .put("summary", summary)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("versionCode", BuildConfig.VERSION_CODE)
            .put("device", runCatching { prefs.deviceName }.getOrDefault(""))
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            .put("route", route)
            .put("uptimeSec", (System.currentTimeMillis() - started) / 1000)
            .put("memory", JSONObject()
                .put("heapMaxMb", rt.maxMemory() / 1048576)
                .put("heapUsedMb", (rt.totalMemory() - rt.freeMemory()) / 1048576)
                .put("deviceAvailMb", mem.availMem / 1048576)
                .put("deviceTotalMb", mem.totalMem / 1048576)
                .put("lowMemory", mem.lowMemory))
            .put("db", JSONObject()
                .put("sizeMb", appContext.getDatabasePath("depo.db").length() / 1048576.0)
                .put("walMb", File(appContext.getDatabasePath("depo.db").path + "-wal").length() / 1048576.0))
            .put("sync", runCatching {
                JSONObject().put("lastSync", if (prefs.lastSync > 0) iso(prefs.lastSync) else "").put("lastError", prefs.lastSyncError)
                    .put("demo", prefs.demo)
            }.getOrNull())
        if (stack != null) r.put("stack", stack.take(200_000))
        synchronized(crumbs) { r.put("crumbs", JSONArray(crumbs.toList())) }
        // Donmada ana iş parçacığı dışındakiler de önemli (eşitleme veritabanı kilidini tutuyor olabilir).
        if (!mainThread) {
            val threads = JSONObject()
            runCatching {
                // Ana iş parçacığı bu listede yok (Android); onun yığını zaten "stack"ta.
                for ((t, st) in Thread.getAllStackTraces()) {
                    if (st.isEmpty() || t.name.startsWith("diag")) continue
                    val interesting = st.any { it.className.startsWith("tr.arcteknik") || it.className.contains("sqlite", true) }
                    if (interesting) threads.put("${t.name} (${t.state})", st.take(40).joinToString("\n") { "    at $it" })
                }
            }.onFailure { threads.put("(okunamadı)", it.toString()) }
            r.put("threads", threads)
        }
        return r
    }

    private fun write(r: JSONObject) {
        File(dir, "${System.currentTimeMillis()}-${r.getString("kind")}-${r.getString("id")}.json").writeText(r.toString())
        val files = pending()
        if (files.size > MAX_FILES) files.take(files.size - MAX_FILES).forEach { it.delete() }
    }

    private fun pending(): List<File> =
        (dir.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray()).sortedBy { it.name }

    /** Bekleyen raporları gönderir. Eşitleme turunda da çağrılır. Ağ iş parçacığından çağrılmalı. */
    @Synchronized
    fun sendPending() {
        if (!::dir.isInitialized) return
        for (f in pending().take(20)) {
            val body = runCatching { f.readText() }.getOrNull() ?: continue
            var ok = false
            // 1) Yönetici programı: cihaz anahtarıyla; günlüğüne yazar ve VPS'e o da iletir.
            val server = prefs.serverUrl
            if (!prefs.demo && server.isNotBlank()) {
                ok = post("$server/api/rapor", body) {
                    header("X-Device-Key", prefs.deviceKey).header("X-Device-Name", prefs.deviceName).header("X-App-Version", BuildConfig.VERSION_NAME)
                }
            }
            // 2) Doğrudan VPS (terminalin internete çıkışı varsa). Aynı rapor iki yoldan gelirse kimlikle tekilleşir.
            if (BuildConfig.REPORT_KEY.isNotBlank()) {
                ok = post(BuildConfig.REPORT_URL, body) { header("X-Rapor-Anahtari", BuildConfig.REPORT_KEY) } || ok
            }
            if (ok) f.delete() else break
        }
    }

    private fun post(url: String, body: String, headers: Request.Builder.() -> Request.Builder): Boolean = runCatching {
        val req = Request.Builder().url(url).headers().post(body.toRequestBody("application/json; charset=utf-8".toMediaType())).build()
        client.newCall(req).execute().use { it.isSuccessful }
    }.getOrDefault(false)
}
