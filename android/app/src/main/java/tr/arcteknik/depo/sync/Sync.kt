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
import java.util.concurrent.TimeUnit

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
        // Uygulama açıkken dakikada bir; kapalıyken WorkManager 15 dakikada bir dener.
        scope.launch {
            while (true) {
                run()
                delay(60_000)
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

    /** Bir işlem kaydedilince hemen gönderilmeye çalışılır. */
    fun trigger() {
        scope.launch { run() }
    }

    /** @return hata metni, başarılıysa null. */
    suspend fun run(): String? = mutex.withLock {
        withContext(Dispatchers.IO) {
            _busy.value = true
            try {
                val db = repo.db
                val backend = backend()
                val pending = db.ops().filter { it.status == OpStatus.PENDING }
                if (pending.isNotEmpty()) {
                    // Gönderilen işlem reddedilirse cihazdaki hali sunucudan farklı kalır; sunucunun ana verisi
                    // değişmemiş olsa bile bu tur tam liste alınsın.
                    repo.prefs.masterEtag = ""
                    for (chunk in pending.chunked(50)) {
                        val results = backend.pushOps(chunk, repo.prefs.lastUser).associateBy { it.id }
                        for (op in chunk) {
                            val r = results[op.id] ?: continue
                            if (r.ok) db.deleteOp(op.id) else db.markOpError(op.id, r.error ?: "Sunucu reddetti")
                        }
                    }
                    repo.changed()
                }
                if (db.ops().none { it.status == OpStatus.PENDING }) {
                    // Demo "sunucusu" işlemleri saklamaz; örnek veri yalnız cihaz boşken yüklenir,
                    // yoksa her eşitleme yapılan işleri silerdi.
                    val etag = repo.prefs.masterEtag.takeIf { it.isNotBlank() && !db.isEmpty() }
                    backend.master(etag) { reader, newEtag ->
                        if (backend !is DemoBackend || db.isEmpty()) {
                            val head = db.replaceMaster(reader)
                            repo.prefs.applyMaster(head)
                            repo.ensureDepot(head.optInt("defaultDepot", 0))
                            repo.prefs.masterEtag = newEtag ?: ""
                        }
                    }
                    repo.prefs.lastSync = System.currentTimeMillis()
                }
                repo.prefs.lastSyncError = ""
                _reachable.value = true
                repo.changed()
                null
            } catch (e: Exception) {
                val msg = e.message ?: e.javaClass.simpleName
                repo.prefs.lastSyncError = msg
                _reachable.value = false
                repo.changed()
                msg
            } finally {
                _busy.value = false
            }
        }
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as App
        return if (app.sync.run() == null) Result.success() else Result.retry()
    }
}
