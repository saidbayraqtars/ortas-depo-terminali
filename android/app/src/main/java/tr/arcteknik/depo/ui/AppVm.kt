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
import tr.arcteknik.depo.data.Depot
import tr.arcteknik.depo.data.Perm
import tr.arcteknik.depo.data.Repo
import tr.arcteknik.depo.data.TransferLine
import tr.arcteknik.depo.data.User
import tr.arcteknik.depo.data.isArrangeId
import tr.arcteknik.depo.diag.Diag
import tr.arcteknik.depo.sync.LockInfo
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
import tr.arcteknik.depo.ui.screens.ReceiveDocScreen
import tr.arcteknik.depo.ui.screens.ReceiveListScreen
import tr.arcteknik.depo.ui.screens.SendDepotScreen
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
    /** Depolar arası transfer: depoya gönder ve gönderim kabul (1.6.0+ sunucu). */
    data object SendDepot : Route
    data object ReceiveList : Route
    data class ReceiveDoc(val sevkId: String) : Route
}

/**
 * Depoya gönder taslağı: ekrandan çıkılsa da (başka ekrana gidilse de) uygulama açık olduğu sürece kaybolmaz.
 * Varış deposu yoktur: transfer yalnız iki depo arasında olduğu için çıkışın karşısındaki depodur.
 * Bir ürün birden çok satır olabilir (raf başına bir satır, rafsız kalan için shelf boş bir satır).
 */
class SendDraft {
    var from by mutableStateOf(0)

    /** Çıkış deposu bu gönderim için sorulup seçildi mi (her gönderimde yeniden sorulur). */
    var fromConfirmed by mutableStateOf(false)
    val lines = mutableStateListOf<TransferLine>()

    fun clear() {
        fromConfirmed = false
        lines.clear()
    }

    /** [productId]'nin satırlarını [new] ile değiştirir (boşsa ürün listeden çıkar). */
    fun replace(productId: String, new: List<TransferLine>) {
        val at = lines.indexOfFirst { it.productId == productId }
        lines.removeAll { it.productId == productId }
        if (new.isNotEmpty()) lines.addAll(if (at in 0..lines.size) at else lines.size, new)
    }

    fun qtyOf(productId: String): Double = lines.filter { it.productId == productId }.sumOf { it.qty }
}

/** Belge kilidinin terminaldeki durumu (docs/API.md "Belge kilidi"). */
enum class LockState {
    /** Kilit yok: belge bir kilit gerektirmeyen ekranda. */
    NONE,
    /** Kilit isteniyor; belge hemen açılır, cevap gelince durum netleşir. */
    CHECKING,
    /** Kilit bu terminalde; 30 sn'de bir nabız gider. */
    HELD,
    /** Kilitsiz açıldı: sunucuya ulaşılamadı ya da sunucu kilidi bilmiyor. Belge kullanılır, uyarı gösterilir. */
    UNLOCKED,
    /** Belgeyi başka bir terminal kullanıyor; belge bu terminalde açılmaz. */
    TAKEN,
    /** Kilit sonradan gitti (yönetici açtı ya da başka terminal aldı); ekran bekleyen işi kaydedip belgeden çıkar. */
    LOST,
}

class DocLock {
    var docId by mutableStateOf<String?>(null)
    var state by mutableStateOf(LockState.NONE)

    /** TAKEN: "Ahmet (TRM-03) kullanıyor". LOST: nedeni. UNLOCKED: uyarı metni (boşsa uyarı yok). */
    var message by mutableStateOf("")
    var token = ""
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

    val sendDraft = SendDraft()
    val docLock = DocLock()
    private var lockJob: Job? = null

    /** Listelerde kilit simgesi için: şu an başka terminallerde açık belgeler (kimlik → tutan). */
    var locks by mutableStateOf<Map<String, LockInfo>>(emptyMap())
        private set
    private val receiveDrafts = HashMap<String, androidx.compose.runtime.snapshots.SnapshotStateList<TransferLine>>()

    /** Gönderim kabulünde okutulanlar; kabul bitene ya da vazgeçilene kadar saklanır. */
    fun receiveDraft(sevkId: String) = receiveDrafts.getOrPut(sevkId) { mutableStateListOf() }

    fun dropReceiveDraft(sevkId: String) {
        receiveDrafts.remove(sevkId)
    }

    val stack = mutableStateListOf<Route>(Route.Login)
    val route: Route get() = stack.last()

    var message by mutableStateOf<Pair<String, Boolean>?>(null)
        private set
    private var messageJob: Job? = null

    init {
        // İlk açılışta cihaz boşsa ana veriyi hemen almaya çalış.
        if (repo.db.isEmpty()) viewModelScope.launch { sync.run() }
    }

    // ---- Kullanıcı yetkisi (yönetici programı Kullanıcılar sayfası; docs/API.md "Kullanıcı yetkisi") --------

    /** Oturumdaki kullanıcı bu işlemi yapabilir mi. Giriş yapılmamışsa ya da yetki bilgisi yoksa (eski sunucu) kısıt yok. */
    fun can(perm: String): Boolean = user?.perms?.contains(perm) ?: true

    /** Kullanıcı bu depoda çalışabilir mi. */
    fun canDepot(depot: Int): Boolean = user?.depots?.contains(depot) ?: true

    /** Kullanıcının çalışabileceği depolar (ana veride tanımlı olanlar). */
    fun depots(): List<Depot> = repo.db.depots().filter { canDepot(it.id) }

    /** Çalışılan depo kullanıcıya kapalıysa ilk izinli depoya geçilir (Toybelen kullanıcısı Merkez açıkken girerse). */
    private fun ensureWorkingDepot() {
        val d = depots()
        if (d.isNotEmpty() && d.none { it.id == repo.db.depot }) repo.selectDepot(d.first().id)
    }

    /** Ana veri yenilenince yöneticinin değiştirdiği yetki açık oturuma da yansır. */
    fun refreshUser() {
        val u = user ?: return
        val n = repo.db.user(u.username) ?: return
        if (n.perms != u.perms || n.depots != u.depots) {
            user = u.copy(perms = n.perms, depots = n.depots)
            ensureWorkingDepot()
        }
    }

    /** Ekranı açmak için gereken izin; birden çoksa herhangi biri yeter. Kısıtsız ekran null. */
    private fun needed(r: Route): List<String>? = when (r) {
        Route.Receipts, is Route.PutAway, is Route.PutAwayProduct -> listOf(Perm.PUTAWAY)
        Route.Pick -> listOf(Perm.PICK)
        is Route.Transfer -> listOf(Perm.TRANSFER)
        Route.Counts -> listOf(Perm.COUNT, Perm.COUNT_FREE)
        // Raf Düzenle sayım ekranlarını kullanır ama kendi iznine bağlıdır (Perm.SHELF_ARRANGE).
        is Route.Count -> if (isArrangeId(r.sessionId)) listOf(Perm.SHELF_ARRANGE) else listOf(Perm.COUNT, Perm.COUNT_FREE)
        is Route.CountDiff -> if (isArrangeId(r.sessionId)) listOf(Perm.SHELF_ARRANGE) else listOf(Perm.COUNT, Perm.COUNT_FREE)
        Route.SendDepot -> listOf(Perm.DEPOT_SEND)
        Route.ReceiveList, is Route.ReceiveDoc -> listOf(Perm.DEPOT_RECEIVE)
        else -> null
    }

    private fun allowed(r: Route): Boolean {
        val need = needed(r) ?: return true
        if (need.any { can(it) }) return true
        error("Bu işlem için yetkiniz yok")
        return false
    }

    fun go(r: Route) {
        if (!allowed(r)) return
        stack += r
        routed()
    }

    private fun routed() {
        Diag.route = stack.joinToString(" › ")
        Diag.crumb("ekran: ${stack.last()}")
    }

    /** Geçerli ekranı [r] ile değiştirir; "rafa kaldır → belge listesine dön" gibi akışlar için. */
    fun replace(r: Route) {
        if (!allowed(r)) return
        stack[stack.lastIndex] = r
        routed()
    }

    fun back() {
        if (stack.size > 1) stack.removeAt(stack.lastIndex)
        routed()
    }

    fun login(u: User) {
        user = u
        ensureWorkingDepot()
        stack.clear()
        stack += Route.Home
        routed()
    }

    /** Kilitli belge listesini sunucudan yeniler (liste ekranları 10 sn'de bir çağırır). Ulaşılamazsa eski liste kalır. */
    fun refreshLocks() {
        viewModelScope.launch {
            val l = withContext(Dispatchers.IO) { runCatching { sync.backend().locks() } }.getOrNull() ?: return@launch
            locks = l.filter { it.device != repo.prefs.deviceName }.associateBy { it.id }
        }
    }

    /**
     * Belgeyi kilitler ve tutulduğu sürece 30 sn'de bir nabız yollar. Belge hemen açılır (durum CHECKING); cevap gelince
     * HELD, TAKEN (başkası kullanıyor), UNLOCKED (sunucu yok ya da bilmiyor) olur. Nabız kilidin gittiğini söylerse LOST.
     * Kilit arayüz korumasıdır: işlemler kilide bakılmadan sunucuya gider, miktar sınırları çakışmayı çözer.
     */
    fun enterDoc(docId: String, kind: String, docNo: String) {
        leaveDoc()
        docLock.docId = docId
        docLock.state = LockState.CHECKING
        docLock.message = ""
        docLock.token = ""
        lockJob = viewModelScope.launch {
            while (docLock.docId == docId) {
                if (docLock.token.isEmpty()) {
                    val reply = withContext(Dispatchers.IO) { runCatching { sync.backend().lock(docId, kind, docNo, userName) } }.getOrNull()
                    if (docLock.docId != docId) return@launch
                    when {
                        reply == null -> { docLock.state = LockState.UNLOCKED; docLock.message = "Sunucuya ulaşılamıyor: belge kilitsiz açıldı; başka terminal de açmış olabilir."; return@launch }
                        !reply.supported -> { docLock.state = LockState.UNLOCKED; docLock.message = ""; return@launch }
                        !reply.ok -> { docLock.state = LockState.TAKEN; docLock.message = reply.holder.ifBlank { "Başka bir terminal kullanıyor" }; return@launch }
                        else -> { docLock.token = reply.token; docLock.state = LockState.HELD }
                    }
                } else {
                    val reply = withContext(Dispatchers.IO) { runCatching { sync.backend().lockPing(docId, docLock.token) } }.getOrNull()
                    if (docLock.docId != docId) return@launch
                    // Ağ hatasında kilit sunucuda 3 dk dayanır; bir sonraki nabızda yeniden denenir.
                    if (reply != null && reply.supported && !reply.ok) {
                        docLock.token = ""
                        docLock.state = LockState.LOST
                        docLock.message = when (reply.reason) {
                            "yonetici" -> "Yönetici bu belgenin kilidini açtı"
                            "baska" -> "Belgeyi başka bir terminal aldı"
                            else -> "Belge kilidi kalktı"
                        }
                        return@launch
                    }
                }
                delay(30_000)
            }
        }
    }

    /** Belgeden çıkış, kabulü bitirme ya da oturum kapanması: kilit bırakılır. [docId] verilirse yalnız o belgenin kilidi. */
    fun leaveDoc(docId: String? = null) {
        if (docId != null && docLock.docId != docId) return
        lockJob?.cancel()
        lockJob = null
        val id = docLock.docId
        val token = docLock.token
        docLock.docId = null
        docLock.state = LockState.NONE
        docLock.message = ""
        docLock.token = ""
        if (id != null && token.isNotEmpty()) viewModelScope.launch(Dispatchers.IO) { runCatching { sync.backend().lockRelease(id, token) } }
    }

    fun logout() {
        leaveDoc()
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
        if (Repo.validShelfCode(s) && can(Perm.SHELF_ADD)) shelfAsk = ShelfAsk(s, depot, onAdded)
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
        if (!can(Perm.LABEL)) return error("Etiket basma yetkiniz yok")
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
    // Yönetici yetkiyi değiştirdiyse açık oturum da bir sonraki eşitlemede yeni yetkiyle devam eder.
    androidx.compose.runtime.LaunchedEffect(version) { vm.refreshUser() }

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
        Route.SendDepot -> SendDepotScreen(vm, online, version)
        Route.ReceiveList -> ReceiveListScreen(vm, online, version)
        is Route.ReceiveDoc -> ReceiveDocScreen(vm, online, version, r.sevkId)
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
