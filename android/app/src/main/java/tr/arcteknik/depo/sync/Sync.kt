package tr.arcteknik.depo.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import tr.arcteknik.depo.App
import tr.arcteknik.depo.data.OpStatus
import tr.arcteknik.depo.data.Repo
import tr.arcteknik.depo.diag.Diag
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Kullanıcının son okutma/kaydı. Çalışılırken ana veri yeniden yazılmaz (aşağıda). */
object UserActivity {
    @Volatile
    var at = 0L
        private set

    fun touch() {
        at = System.currentTimeMillis()
    }

    fun idleFor(ms: Long) = System.currentTimeMillis() - at > ms
}

/**
 * Eşitleme sırası: önce kuyruktaki işlemler gönderilir, sonra ana veri çekilir. Gönderilemeyen
 * işlem varken ana veri çekilmez; yoksa sunucunun eski hali cihazdaki değişikliği silerdi.
 */
class Sync(private val context: Context, private val repo: Repo) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()

    private val _network = MutableStateFlow(false)
    val network: StateFlow<Boolean> = _network

    /** Son denemede sunucuya ulaşıldı mı. Gösterge bu ikisinden çıkar. */
    private val _reachable = MutableStateFlow(true)
    val reachable: StateFlow<Boolean> = _reachable

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    /** İlk yüklemede "ana veri 24/64" gibi ilerleme; yoksa null. */
    private val _progress = MutableStateFlow<String?>(null)
    val progress: StateFlow<String?> = _progress

    /**
     * Ana veriyi parça parça çeker (1.3.0+ sunucu): yalnız değişen kovalar, istekte en çok 8 kova, her kova ayrı kısa
     * işlemle yazılır. Bu yüzden kullanıcı çalışırken de güvenle çalışır. Sunucu desteklemiyorsa false (eski yol).
     */
    private fun pullParts(backend: Backend): Boolean {
        val db = repo.db
        var done = 0
        val t0 = System.currentTimeMillis()
        // Tam eşitlenene kadar sayaç bilinmez; değişiklik beklemesi ancak tam eşitlenmişse başlar.
        serverSurum = -1
        for (round in 0 until 40) {
            // Çekim sürerken kullanıcı işlem kaydettiyse çekimi bırak: işlem önce gitsin (eskiden çekim bitene kadar beklerdi).
            if (round > 0 && db.pendingCount() > 0) {
                again = true
                return true
            }
            var result: tr.arcteknik.depo.data.Db.PartsResult? = null
            val supported = backend.masterParts(db.masterParts(), 8) { reader -> result = db.applyParts(reader) }
            if (!supported) return false
            val r = result ?: return true
            r.head?.let {
                repo.prefs.applyMaster(it)
                repo.ensureDepot(it.optInt("defaultDepot", 0))
            }
            done += r.parts
            if (r.parts > 0) repo.changed()
            if (r.remaining == 0) {
                serverSurum = r.surum
                break
            }
            _progress.value = "Ana veri alınıyor · ${db.masterParts().count { it.key.startsWith("b") }}/${tr.arcteknik.depo.data.Buckets.COUNT}"
        }
        if (done > 0) Diag.crumb("eşitleme: $done parça yazıldı ${System.currentTimeMillis() - t0} ms")
        return true
    }

    /** Son tam eşitlemedeki sunucu değişiklik sayacı; bilinmiyorsa -1 (bkz. [waitForChange]). */
    @Volatile
    private var serverSurum = -1

    /** Çekim yarıda bırakıldı; bekleyen işlem gönderilsin diye hemen yeni tur gerekir. */
    @Volatile
    private var again = false

    fun backend(): Backend {
        val p = repo.prefs
        return if (p.demo || p.serverUrl.isBlank()) DemoBackend(context) { _network.value }
        else HttpBackend(p.serverUrl, p.deviceKey, p.deviceName)
    }

    fun start() {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        _network.value = cm.activeNetwork?.let { cm.getNetworkCapabilities(it)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) } == true
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                _network.value = true
                trigger()
            }

            override fun onLost(network: Network) {
                _network.value = false
                _reachable.value = false
            }
        })
        // Uygulama açıkken sunucudaki değişiklik beklenir (1.5.0+ sunucu: saniyeler içinde gelir); eski sunucuda
        // dakikada bir yoklanır. Uygulama kapalıyken WorkManager 15 dakikada bir dener.
        scope.launch {
            while (true) {
                val err = run(force = false)
                delay(
                    when {
                        err != null -> 20_000L
                        serverSurum < 0 -> 60_000L
                        else -> waitForChange()
                    },
                )
            }
        }
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            "esitleme",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build(),
        )
    }

    /**
     * Sunucuda değişiklik olana kadar bekler (her seferinde 25 sn'lik uzun yoklama; süre dolarsa tekrar). Dönen: sonraki
     * eşitlemeden önce beklenecek ms. Beklerken yeni işlem kaydedilirse hemen biter.
     */
    private fun waitForChange(): Long {
        val seen = serverSurum
        while (true) {
            val n = try {
                backend().waitChange(seen, 25)
            } catch (e: Exception) {
                return 15_000L
            }
            if (n < 0) return 60_000L
            if (n != seen) return 1_000L
            if (repo.db.pendingCount() > 0) return 0L
        }
    }

    /** Bir işlem kaydedilince hemen gönderilmeye çalışılır. */
    fun trigger() {
        scope.launch { run(force = false) }
    }

    /**
     * Ana veri yeni sunucudan parça parça gelir ([pullParts]). Eski sunucuda tek parça iner:
     * @param force kullanıcı "eşitle" dediyse true. Değilse ve kullanıcı son 2 dakikada okutma/kayıt yaptıysa eski
     *   sunucudan ana veri çekilmez, yalnız kuyruk gönderilir: 130 bin kalemlik liste yazılırken veritabanı kilitli
     *   kalıyor, ekrandaki kayıt bunu bekleyip terminali donduruyordu (her rafa kaldırmadan sonra baştan iniyordu).
     * @return hata metni, başarılıysa null.
     */
    suspend fun run(force: Boolean = true): String? {
        val sonuc = mutex.withLock { runLocked(force) }
        if (again) {
            again = false
            trigger()
        }
        return sonuc
    }

    private suspend fun runLocked(force: Boolean): String? =
        withContext(Dispatchers.IO) {
            _busy.value = true
            try {
                val db = repo.db
                val backend = backend()
                val pending = db.ops().filter { it.status == OpStatus.PENDING }
                if (pending.isNotEmpty()) {
                    val t0 = System.currentTimeMillis()
                    for (chunk in pending.chunked(50)) {
                        val results = backend.pushOps(chunk, repo.prefs.lastUser).associateBy { it.id }
                        for (op in chunk) {
                            val r = results[op.id] ?: continue
                            if (r.ok) {
                                db.deleteOp(op.id)
                            } else {
                                db.markOpError(op.id, r.error ?: "Sunucu reddetti")
                                // Reddedilen işlem cihazdaki hali sunucudan farklı bıraktı; sunucunun ana verisi
                                // değişmemiş olsa bile sonraki tur tam liste alınsın.
                                repo.prefs.masterEtag = ""
                                db.clearMasterParts()
                            }
                        }
                    }
                    Diag.crumb("eşitleme: ${pending.size} işlem gönderildi ${System.currentTimeMillis() - t0} ms")
                    repo.changed()
                }
                if (db.ops().none { it.status == OpStatus.PENDING } && pullParts(backend)) {
                    repo.prefs.lastSync = System.currentTimeMillis()
                } else if (db.ops().none { it.status == OpStatus.PENDING } && (force || db.isEmpty() || UserActivity.idleFor(120_000))) {
                    // Demo "sunucusu" işlemleri saklamaz; örnek veri yalnız cihaz boşken yüklenir,
                    // yoksa her eşitleme yapılan işleri silerdi.
                    val etag = repo.prefs.masterEtag.takeIf { it.isNotBlank() && !db.isEmpty() }
                    backend.master(etag) { reader, newEtag ->
                        if (backend !is DemoBackend || db.isEmpty()) {
                            val t0 = System.currentTimeMillis()
                            Diag.crumb("eşitleme: ana veri iniyor")
                            val head = db.replaceMaster(reader)
                            Diag.crumb("eşitleme: ana veri yazıldı ${System.currentTimeMillis() - t0} ms")
                            repo.prefs.applyMaster(head)
                            repo.ensureDepot(head.optInt("defaultDepot", 0))
                            repo.prefs.masterEtag = newEtag ?: ""
                        }
                    }
                    repo.prefs.lastSync = System.currentTimeMillis()
                }
                repo.prefs.lastSyncError = ""
                _reachable.value = true
                _progress.value = null
                repo.changed()
                null
            } catch (e: Exception) {
                val msg = e.message ?: e.javaClass.simpleName
                Diag.crumb("eşitleme hatası: $msg")
                // Ağ hatası olağan; başka türlü istisna (veri, SQLite) rapor edilir.
                if (e !is IOException) Diag.error("eşitleme", e)
                repo.prefs.lastSyncError = msg
                _reachable.value = false
                repo.changed()
                msg
            } finally {
                _busy.value = false
                _progress.value = null
                runCatching { Diag.sendPending() }
            }
        }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as App
        return if (app.sync.run(force = false) == null) Result.success() else Result.retry()
    }
}
