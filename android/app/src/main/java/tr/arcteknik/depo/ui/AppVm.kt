package tr.arcteknik.depo.ui

import android.app.Application
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.Modifier
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import tr.arcteknik.depo.App
import tr.arcteknik.depo.data.Repo
import tr.arcteknik.depo.data.User
import tr.arcteknik.depo.diag.Diag
import tr.arcteknik.depo.sync.UserActivity
import tr.arcteknik.depo.ui.screens.CountDiffScreen
import tr.arcteknik.depo.ui.screens.CountListScreen
import tr.arcteknik.depo.ui.screens.CountScreen
import tr.arcteknik.depo.ui.screens.HomeScreen
import tr.arcteknik.depo.ui.screens.LoginScreen
import tr.arcteknik.depo.ui.screens.ProductQueryScreen
import tr.arcteknik.depo.ui.screens.PickScreen
import tr.arcteknik.depo.ui.screens.ProductPutAwayScreen
import tr.arcteknik.depo.ui.screens.PutAwayScreen
import tr.arcteknik.depo.ui.screens.QueueScreen
import tr.arcteknik.depo.ui.screens.ReceiptListScreen
import tr.arcteknik.depo.ui.screens.SettingsScreen
import tr.arcteknik.depo.ui.screens.ShelfQueryScreen
import tr.arcteknik.depo.ui.screens.TransferScreen

sealed interface Route {
    data object Login : Route
    data object Settings : Route
    data object Home : Route
    data object Receipts : Route
    data class PutAway(val receiptId: String) : Route
    data class PutAwayProduct(val productId: String) : Route
    data object Pick : Route
    data class ProductQuery(val scan: String? = null) : Route
    data class ShelfQuery(val shelf: String? = null) : Route
    data class Transfer(val productId: String? = null, val from: String? = null) : Route
    data object Counts : Route
    data class Count(val sessionId: String) : Route
    data class CountDiff(val sessionId: String) : Route
    data object Queue : Route
}

/** Okutulan tanımsız raf etiketi: kullanıcıya raf olarak eklensin mi diye sorulur. */
class ShelfAsk(val code: String, val depot: Int, val onAdded: (String) -> Unit)

class AppVm(app: Application) : AndroidViewModel(app) {
    private val a = app as App
    val repo = a.repo
    val sync = a.sync
    val feedback = a.feedback

    var user by mutableStateOf<User?>(null)
        private set

    val stack = mutableStateListOf<Route>(Route.Login)
    val route: Route get() = stack.last()

    var message by mutableStateOf<Pair<String, Boolean>?>(null)
        private set
    private var messageJob: Job? = null

    init {
        // İlk açılışta cihaz boşsa ana veriyi hemen almaya çalış.
        if (repo.db.isEmpty()) viewModelScope.launch { sync.run() }
    }

    fun go(r: Route) {
        stack += r
        routed()
    }

    private fun routed() {
        Diag.route = stack.joinToString(" › ")
        Diag.crumb("ekran: ${stack.last()}")
    }

    /** Geçerli ekranı [r] ile değiştirir; "rafa kaldır → belge listesine dön" gibi akışlar için. */
    fun replace(r: Route) {
        stack[stack.lastIndex] = r
        routed()
    }

    fun back() {
        if (stack.size > 1) stack.removeAt(stack.lastIndex)
        routed()
    }

    fun login(u: User) {
        user = u
        stack.clear()
        stack += Route.Home
        routed()
    }

    fun logout() {
        user = null
        stack.clear()
        stack += Route.Login
        routed()
    }

    fun ok(text: String) = show(text, false).also { feedback.ok() }

    fun error(text: String) = show(text, true).also { feedback.error() }

    private fun show(text: String, error: Boolean) {
        Diag.crumb((if (error) "hata: " else "mesaj: ") + text)
        message = text to error
        messageJob?.cancel()
        messageJob = viewModelScope.launch {
            delay(if (error) 5000 else 2500)
            message = null
        }
    }

    var shelfAsk by mutableStateOf<ShelfAsk?>(null)
        private set

    /** Tanımsız raf okutuldu: kod raf olabilecekse eklemeyi sor, değilse hata ver. */
    fun unknownShelf(code: String, depot: Int = repo.db.depot, onAdded: (String) -> Unit) {
        val s = code.trim().uppercase()
        val where = repo.db.depotName(depot).takeIf { it.isNotBlank() && repo.db.depots().size > 1 }?.let { "$it deposunda " } ?: ""
        error("\"$s\" ${where}tanımlı bir raf değil")
        if (Repo.validShelfCode(s)) shelfAsk = ShelfAsk(s, depot, onAdded)
    }

    fun confirmShelf(add: Boolean) {
        val a = shelfAsk ?: return
        shelfAsk = null
        if (!add) return
        repo.addShelf(a.code, a.depot, userName)
        saved("Raf ${a.code} eklendi")
        a.onAdded(a.code)
    }

    /** İşlem kaydedildikten sonra çağrılır; ağ varsa hemen gönderilir. */
    fun saved(text: String) {
        ok(text)
        UserActivity.touch()
        sync.trigger()
    }

    val userName: String get() = user?.username ?: ""

    /** Etiket sunucu bilgisayarındaki yazıcıdan çıkar; bağlantı yoksa kuyruğa alınmaz (sonradan basılması kafa karıştırır). */
    fun printLabel(type: String, id: String, copies: Int) {
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { sync.backend().printLabel(type, id, copies, userName, repo.db.depot) } }
            r.onSuccess { ok(it) }.onFailure { error(it.message ?: "Etiket basılamadı") }
        }
    }
}

@Composable
fun DepoApp(vm: AppVm) {
    val net by vm.sync.network.collectAsState()
    val reach by vm.sync.reachable.collectAsState()
    // Ekranlar veri değiştiğinde yeniden okusun diye sürüm izlenir.
    val version by vm.repo.version.collectAsState()
    val online = net && reach

    BackHandler(enabled = vm.stack.size > 1) { vm.back() }

    val r = vm.route
    // Android 15 uygulamayı kenardan kenara çizer; üst ve alt sistem çubukları için boşluk bırakılır.
    Column(Modifier.fillMaxSize().background(C.Bar).statusBarsPadding()) {
    Box(Modifier.weight(1f).fillMaxWidth().background(C.Ground).navigationBarsPadding().imePadding()) {
    // Aynı türden iki ekran üst üste açılınca (ürün sorgu → ürün sorgu) durum karışmasın.
    key(vm.stack.size, r) {
    when (r) {
        Route.Login -> LoginScreen(vm, version)
        Route.Settings -> SettingsScreen(vm, online)
        Route.Home -> HomeScreen(vm, online, version)
        Route.Receipts -> ReceiptListScreen(vm, online, version)
        is Route.PutAway -> PutAwayScreen(vm, online, version, r.receiptId)
        is Route.PutAwayProduct -> ProductPutAwayScreen(vm, online, version, r.productId)
        Route.Pick -> PickScreen(vm, online, version)
        is Route.ProductQuery -> ProductQueryScreen(vm, online, version, r.scan)
        is Route.ShelfQuery -> ShelfQueryScreen(vm, online, version, r.shelf)
        is Route.Transfer -> TransferScreen(vm, online, version, r.productId, r.from)
        Route.Counts -> CountListScreen(vm, online, version)
        is Route.Count -> CountScreen(vm, online, version, r.sessionId)
        is Route.CountDiff -> CountDiffScreen(vm, online, version, r.sessionId)
        Route.Queue -> QueueScreen(vm, online, version)
    }
    }
    }
    }
    vm.shelfAsk?.let { a ->
        // Düğmeler odak almaz: el terminalinin okuyucusu Enter gönderir, sonraki okutma kendiliğinden "Ekle"ye basmasın.
        AlertDialog(
            onDismissRequest = { vm.confirmShelf(false) },
            title = { Text("Raf eklensin mi?") },
            text = { Text("\"${a.code}\" tanımlı bir raf değil. ${vm.repo.db.depotName(a.depot).ifBlank { "Bu" }} deposuna raf olarak eklenir; yönetici programında da açılır.") },
            confirmButton = { TextButton({ vm.confirmShelf(true) }, Modifier.focusProperties { canFocus = false }) { Text("Rafı ekle") } },
            dismissButton = { TextButton({ vm.confirmShelf(false) }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") } },
        )
    }
}
