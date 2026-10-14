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
import androidx.compose.runtime.Composable
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
import tr.arcteknik.depo.App
import tr.arcteknik.depo.data.User
import tr.arcteknik.depo.ui.screens.CountDiffScreen
import tr.arcteknik.depo.ui.screens.CountListScreen
import tr.arcteknik.depo.ui.screens.CountScreen
import tr.arcteknik.depo.ui.screens.HomeScreen
import tr.arcteknik.depo.ui.screens.LoginScreen
import tr.arcteknik.depo.ui.screens.ProductQueryScreen
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
    data class ProductQuery(val scan: String? = null) : Route
    data class ShelfQuery(val shelf: String? = null) : Route
    data class Transfer(val productId: String? = null, val from: String? = null) : Route
    data object Counts : Route
    data class Count(val sessionId: String) : Route
    data class CountDiff(val sessionId: String) : Route
    data object Queue : Route
}

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
    }

    /** Geçerli ekranı [r] ile değiştirir; "rafa kaldır → belge listesine dön" gibi akışlar için. */
    fun replace(r: Route) {
        stack[stack.lastIndex] = r
    }

    fun back() {
        if (stack.size > 1) stack.removeAt(stack.lastIndex)
    }

    fun login(u: User) {
        user = u
        stack.clear()
        stack += Route.Home
    }

    fun logout() {
        user = null
        stack.clear()
        stack += Route.Login
    }

    fun ok(text: String) = show(text, false).also { feedback.ok() }

    fun error(text: String) = show(text, true).also { feedback.error() }

    private fun show(text: String, error: Boolean) {
        message = text to error
        messageJob?.cancel()
        messageJob = viewModelScope.launch {
            delay(if (error) 5000 else 2500)
            message = null
        }
    }

    /** İşlem kaydedildikten sonra çağrılır; ağ varsa hemen gönderilir. */
    fun saved(text: String) {
        ok(text)
        sync.trigger()
    }

    val userName: String get() = user?.username ?: ""
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
}
