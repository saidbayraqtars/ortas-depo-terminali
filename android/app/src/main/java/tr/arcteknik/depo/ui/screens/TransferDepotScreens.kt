package tr.arcteknik.depo.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tr.arcteknik.depo.data.Db
import tr.arcteknik.depo.data.Incoming
import tr.arcteknik.depo.data.Location
import tr.arcteknik.depo.data.Product
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.data.TransferLine
import tr.arcteknik.depo.diag.Diag
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.DepotDialog
import tr.arcteknik.depo.ui.Divider
import tr.arcteknik.depo.ui.DocLockEffect
import tr.arcteknik.depo.ui.DocTakenScreen
import tr.arcteknik.depo.ui.DocUnlockedNotice
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.Ic
import tr.arcteknik.depo.ui.LockState
import tr.arcteknik.depo.ui.LockTag
import tr.arcteknik.depo.ui.LocksPoller
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.Notice
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.QtyStepper
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.ScanField
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton
import tr.arcteknik.depo.ui.Tone
import tr.arcteknik.depo.ui.UndoButton

/*
 * Depolar arası transfer. Yalnız ayarlardaki iki depo (örneğin Merkez ↔ Toybelen) arasında yapılır.
 *  Okutma mantığı (sepet): ürün okutulunca adet sorulmadan listeye girer, aynı ürün tekrar okutulunca 1 artar, arada başka
 *  ürün okutulabilir. Beklenen miktar aşılırsa okutma engellenmez: sesli ve görüntülü uyarı verilir, belge sonunda ayrıca
 *  uyarılır.
 *  - Depoya Gönder: çıkış deposu iki seçenekten sorulur, varış diğer depodur. Ürün çıkış deposunda raf stoku olan bir
 *    ürünse raf kendiliğinden seçilir (asıl raf / en çok stoklu; satıra dokunulunca adet ve raf panelinden değiştirilir,
 *    adet raflara bölünebilir); raf stoku olmayan ürün rafsız gider. Raf stoğu aşılırsa fazlası da rafsız geçer (rafa
 *    kaldırılmayı bekleyen mal olabilir). Gönder deyince varış onaylanır ve sunucu Vega'ya depo gönderim fişi (128) yazar.
 *  - Gönderim Kabul: gelen ürünler okutulur, her okutma 1 adet sayar. Gönderilenden fazlası sayılır ve uyarı verir, ama
 *    fişe yalnız gönderilen kadar yazılır (sunucu fazlasını reddeder). Okutulanlar "kaydet" ile kısmi kabul olarak gider,
 *    gönderim açık kalır; "Kabulü bitir" kalan miktarı eksik olarak kaydeder ve gönderimi kapatır. Alınan mal Rafa Kaldır'da
 *    belge olarak bekler. Belgeye girerken kilit alınır (başka terminal kullanıyorsa belge açılmaz).
 */

@Composable
private fun LinkText(text: String, color: Color = C.Info, onClick: () -> Unit) {
    Text(
        text, color = color, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
        modifier = Modifier.focusProperties { canFocus = false }.clickable(onClick = onClick).padding(10.dp),
    )
}

/** Listede [productId]'nin miktarını [qty] yapar; 0 ya da altı satırı siler. */
private fun MutableList<TransferLine>.setQty(productId: String, qty: Double) {
    val i = indexOfFirst { it.productId == productId }
    when {
        qty <= 1e-9 -> if (i >= 0) removeAt(i)
        i >= 0 -> this[i] = this[i].copy(qty = qty)
        else -> add(TransferLine(productId, qty))
    }
}

private fun List<TransferLine>.qtyOf(productId: String): Double = firstOrNull { it.productId == productId }?.qty ?: 0.0

/** Kabul fişine yazılacak satırlar: gönderilenden fazla okutulan miktar kırpılır (sunucu fazlasını kalıcı olarak reddeder). */
private fun writable(sevk: Incoming, lines: List<TransferLine>): List<TransferLine> =
    lines.mapNotNull { l ->
        val open = sevk.lines.firstOrNull { it.productId == l.productId }?.open ?: 0.0
        minOf(l.qty, open).takeIf { it > 1e-9 }?.let { l.copy(qty = it) }
    }

/** [productId]'nin [from] deposundaki dolu rafları: asıl raflar önce, sonra en çok stoklu olandan. */
internal fun sendStocks(db: Db, productId: String, from: Int): List<Location> {
    val home = db.homeShelves(productId, from)
    return db.locationsOf(productId, from).filter { it.qty > 1e-9 }
        .sortedWith(compareByDescending<Location> { it.shelf in home }.thenByDescending { it.qty })
}

/**
 * Gönderimdeki ürüne [add] adet ekler. Raf stoku varsa miktar raflara kendiliğinden dağılır: önce üründe zaten seçili raflar,
 * sonra [stocks] sırası; hiçbir rafta stoğun üstüne çıkılmaz, taşan miktar rafsız gider (panelin kuralıyla aynı).
 */
private fun addToSend(existing: List<TransferLine>, stocks: List<Location>, productId: String, add: Double): List<TransferLine> {
    val byShelf = LinkedHashMap<String, Double>()
    existing.filter { it.shelf.isNotBlank() }.forEach { byShelf[it.shelf] = (byShelf[it.shelf] ?: 0.0) + it.qty }
    var rafsiz = existing.filter { it.shelf.isBlank() }.sumOf { it.qty }
    var left = add
    for (s in stocks.sortedBy { if (it.shelf in byShelf) 0 else 1 }) {
        if (left <= 1e-9) break
        val cap = s.qty - (byShelf[s.shelf] ?: 0.0)
        if (cap <= 1e-9) continue
        val take = minOf(left, cap)
        byShelf[s.shelf] = (byShelf[s.shelf] ?: 0.0) + take
        left -= take
    }
    if (left > 1e-9) rafsiz += left
    return byShelf.map { TransferLine(productId, it.value, it.key) } + (if (rafsiz > 1e-9) listOf(TransferLine(productId, rafsiz)) else emptyList())
}

// ---- Depoya gönder ------------------------------------------------------------------------

@Composable
fun SendDepotScreen(vm: AppVm, online: Boolean, version: Int) {
    val db = vm.repo.db
    val info = remember(version) { vm.repo.transferInfo() }
    val draft = vm.sendDraft
    // Çıkış deposu her gönderimde sorulur; ilk açılışta çalışılan depo öneri olarak işaretli gelir.
    var pickFrom by remember { mutableStateOf(!draft.fromConfirmed) }
    var confirm by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Product?>(null) }
    var scanTick by remember { mutableStateOf(0) }

    // Transfer iki depo arasındadır (sunucu ayarı): çıkış bu ikiliden biri, varış diğeri.
    val pair = info.depots
    val from = pair.firstOrNull { it.id == draft.from }?.id ?: pair.firstOrNull { it.id == db.depot }?.id ?: pair.firstOrNull()?.id ?: 0
    val toDepot = pair.firstOrNull { it.id != from }
    val fromName = pair.firstOrNull { it.id == from }?.name ?: db.depotName(from).ifBlank { from.toString() }
    val toName = toDepot?.name ?: ""
    val lines = draft.lines
    // Ürün başına çıkış deposundaki raf stoku (satırda aşım uyarısı için); sorgu satır başına bir kez çalışır.
    val shelfTotals = remember(version, from) { HashMap<String, Double>() }
    fun shelfTotal(pid: String): Double = shelfTotals.getOrPut(pid) { sendStocks(db, pid, from).sumOf { it.qty } }

    if (!info.on || pair.size != 2) {
        Screen("Depoya Gönder", online = online, onBack = { vm.back() }) {
            Notice("Depolar arası transfer bu sunucuda açık değil ya da iki depo seçilmemiş. Yönetici programında Ayarlar › Depolar arası transfer.", Tone.Warn, icon = Ic.Warning)
            SecondaryButton("Geri", { vm.back() })
        }
        return
    }

    editing?.let { p ->
        SendProductPanel(
            vm, online, p, from, fromName, toName, lines.filter { it.productId == p.id },
            onSave = { draft.replace(p.id, it); editing = null; if (it.isNotEmpty()) vm.ok("${p.name} · ${fmt(it.sumOf { l -> l.qty })} ${p.unit.lowercase()}") },
            onCancel = { editing = null },
        )
        return
    }

    /** Okutulan ürün adet sorulmadan sepete girer, aynı ürün tekrar okutulunca 1 artar; ürün sepetin başına çıkar. */
    fun quickAdd(p: Product) {
        scanTick++
        val stocks = sendStocks(db, p.id, from)
        val next = addToSend(lines.filter { it.productId == p.id }, stocks, p.id, 1.0)
        draft.replace(p.id, emptyList())
        lines.addAll(next)
        shelfTotals[p.id] = stocks.sumOf { it.qty }
        val n = next.sumOf { it.qty }
        val st = shelfTotals.getValue(p.id)
        // Raf stoğu aşılırsa okutma yine geçer (fazlası rafsız gider): sesli ve görüntülü uyarı verilir.
        if (st > 1e-9 && n - st > 1e-9) vm.error("${p.name}: raf stoğu aşıldı · ${fmt(n)}/${fmt(st)}")
        else vm.ok("${p.name} · ${fmt(n)} ${p.unit.lowercase()}" + if (st <= 1e-9) " · rafsız" else "")
    }

    Screen(
        "Depoya Gönder", sub = "$fromName → $toName", online = online, onBack = { vm.back() }, scroll = false,
        footer = if (lines.isNotEmpty()) ({
            PrimaryButton("Gönder · ${lines.map { it.productId }.distinct().size} kalem", { confirm = true })
        }) else null,
    ) {
        // Çıkış ve varış üst çubukta yazılı; okutma alanı sabit, yalnız liste kayar (küçük ekranda da okutulanlar görünür).
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ProductScanField(vm, "Ürün okutun", "Her okutma +1 adet", onProduct = ::quickAdd, showSearchLink = false)
            MessageBar(vm.message?.takeIf { it.second }?.first, true)
            val shape = RoundedCornerShape(12.dp)
            val groups = lines.groupBy { it.productId }.entries.toList().asReversed()
            Column(Modifier.weight(1f).fillMaxWidth().clip(shape).background(C.Surface).border(1.dp, C.Line, shape)) {
                Row(Modifier.padding(start = 14.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Caption(if (groups.isEmpty()) "Gönderilecekler" else "${groups.size} kalem · ${fmt(lines.sumOf { it.qty })} adet", Modifier.weight(1f))
                    if (lines.isEmpty()) LinkText("Çıkışı değiştir") { pickFrom = true } else LinkText("Sıfırla", C.Err) { lines.clear() }
                }
                if (groups.isEmpty()) Hint("Okutulan her ürün burada listelenir; raf kendiliğinden seçilir.", Modifier.padding(start = 14.dp, end = 14.dp, bottom = 10.dp))
                // Anahtarlı liste başa eklenen satırda eski konumunu korur; her okutmada başa dönülür ki son okutulan görünsün.
                val listState = rememberLazyListState()
                LaunchedEffect(scanTick) { listState.scrollToItem(0) }
                LazyColumn(Modifier.weight(1f).padding(start = 14.dp, end = 4.dp), state = listState) {
                    items(groups, key = { it.key }) { g ->
                        val pid = g.key
                        val ls = g.value
                        val p = db.productById(pid, from)
                        val st = shelfTotal(pid)
                        val asti = st > 1e-9 && ls.sumOf { it.qty } - st > 1e-9
                        Divider()
                        Row(
                            Modifier.fillMaxWidth().background(if (g === groups.first()) C.AccentBg else Color.Transparent)
                                .clickable { p?.let { editing = it } }.padding(vertical = 5.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(p?.name ?: pid, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                                Text(
                                    ls.joinToString(" · ") { (if (it.shelf.isBlank()) "rafsız" else it.shelf) + " ×" + fmt(it.qty) },
                                    fontSize = 12.sp, color = C.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                if (asti) Text("raf stoğu aşıldı (rafta ${fmt(st)})", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = C.Err)
                            }
                            MonoText(fmt(ls.sumOf { it.qty }), size = 18, color = if (asti) C.Err else C.Ink)
                            LinkText("Sil", C.Err) { draft.replace(pid, emptyList()) }
                        }
                    }
                    if (groups.isNotEmpty()) item { Hint("Adet ya da raf değiştirmek için satıra dokunun.", Modifier.padding(vertical = 8.dp)) }
                }
            }
        }
    }

    if (pickFrom) {
        DepotDialog(
            pair, from,
            { draft.from = it; draft.fromConfirmed = true; pickFrom = false },
            { if (draft.fromConfirmed) pickFrom = false else vm.back() },
            title = "Hangi depodan çıkıyor?",
            note = "Mal bu depodan çıkar; varış karşıdaki depodur. Raf stoku varsa raf kendiliğinden seçilir.",
        )
    }
    if (confirm) {
        val total = lines.sumOf { it.qty }
        val rafsiz = lines.filter { it.shelf.isBlank() }.sumOf { it.qty }
        // Raf stoğunu aşanlar belge sonunda ayrıca uyarılır (okutma sırasında zaten uyarıldı).
        val asan = lines.groupBy { it.productId }.filter { (pid, ls) -> shelfTotal(pid) > 1e-9 && ls.sumOf { it.qty } - shelfTotal(pid) > 1e-9 }
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("$toName deposuna gönderilsin mi?") },
            text = {
                Text(
                    "Çıkış: $fromName\nVarış: $toName\n${lines.map { it.productId }.distinct().size} kalem, toplam ${fmt(total)}" +
                        (if (rafsiz > 1e-9) "\n${fmt(rafsiz)} adet rafsız gidiyor." else "") +
                        (if (asan.isNotEmpty()) "\n\nRaf stoğunu aşan ${asan.size} kalem var: " +
                            asan.entries.joinToString(", ") { (pid, ls) -> "${db.productById(pid, from)?.code ?: pid} ${fmt(ls.sumOf { it.qty })}/${fmt(shelfTotal(pid))}" } else "") +
                        "\n\nVega'ya depo gönderim fişi yazılır; mal alan depo kabul edene kadar yolda görünür.",
                )
            },
            confirmButton = {
                TextButton({
                    confirm = false
                    vm.repo.sendTransfer(from, toDepot!!.id, lines.toList(), vm.userName)
                    draft.clear()
                    vm.saved("Gönderim kaydedildi: $fromName → $toName")
                    vm.back()
                }, Modifier.focusProperties { canFocus = false }) { Text("Gönder", fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton({ confirm = false }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") } },
        )
    }
}

/**
 * Gönderimde bir ürünün adedi ve rafları. Ürünün çıkış deposunda raf stoku S varsa: adet raflara bölünür, her rafta o rafın
 * stoğu aşılamaz ve min(adet, S) kadarı raflardan seçilmeden eklenemez; adet S'yi aşarsa fazlası rafsız gider. Raf stoku
 * yoksa ürün "rafsız gönder" uyarısıyla geçer. (Sunucu son sözü söyler: eski terminalden gelen rafsız satırı da raf stoku
 * varsa kendisi düşer.)
 */
@Composable
private fun SendProductPanel(
    vm: AppVm,
    online: Boolean,
    product: Product,
    from: Int,
    fromName: String,
    toName: String,
    existing: List<TransferLine>,
    onSave: (List<TransferLine>) -> Unit,
    onCancel: () -> Unit,
) {
    val db = vm.repo.db
    val stocks = remember(product.id, from) { sendStocks(db, product.id, from) }
    val total = stocks.sumOf { it.qty }
    var qty by remember { mutableStateOf(if (existing.isEmpty()) 1.0 else existing.sumOf { it.qty }) }
    val alloc = remember { mutableStateMapOf<String, Double>() }

    /** Adet için raflardan gereken miktarı asıl raf / en çok stoklu raftan başlayarak paylaştırır. */
    fun autoFill(q: Double) {
        alloc.clear()
        var left = minOf(q, total)
        for (s in stocks) {
            if (left <= 1e-9) break
            val take = minOf(left, s.qty)
            alloc[s.shelf] = take
            left -= take
        }
    }
    remember(product.id) {
        if (existing.any { it.shelf.isNotBlank() }) existing.filter { it.shelf.isNotBlank() }.forEach { alloc[it.shelf] = it.qty } else autoFill(qty)
        true
    }

    val needed = minOf(qty, total)
    val assigned = alloc.values.sum()
    val rafsiz = (qty - assigned).coerceAtLeast(0.0)
    val valid = qty > 1e-9 && kotlin.math.abs(assigned - needed) < 1e-6
    val remaining = (needed - assigned).coerceAtLeast(0.0)

    fun onShelf(code: String) {
        val s = code.trim().uppercase()
        if (db.findProduct(code) != null) return vm.error("Raf barkodu okutun; bu bir ürün barkodu")
        val st = stocks.firstOrNull { it.shelf == s } ?: return vm.error("$s rafında ${product.name} yok; $fromName deposunda bu ürünün rafları aşağıda")
        val cur = alloc[s] ?: 0.0
        val add = minOf(st.qty - cur, remaining)
        if (add <= 1e-9) return vm.error(if (remaining <= 1e-9) "Raflardan gereken miktar zaten seçildi" else "$s rafındaki stok tamamı seçildi")
        alloc[s] = cur + add
        vm.ok("$s · ${fmt(cur + add)}")
    }

    Screen(
        "Depoya Gönder", sub = "$fromName → $toName", online = online, onBack = onCancel, scroll = false,
        footer = ({
            MessageBar(vm.message?.first, vm.message?.second == true)
            PrimaryButton(
                if (total <= 1e-9) "Rafsız gönder · ${fmt(qty)} ${product.unit.lowercase()}" else "Ekle · ${fmt(qty)} ${product.unit.lowercase()}",
                {
                    val out = mutableListOf<TransferLine>()
                    stocks.forEach { s -> (alloc[s.shelf] ?: 0.0).takeIf { it > 1e-9 }?.let { out += TransferLine(product.id, it, s.shelf) } }
                    if (rafsiz > 1e-9) out += TransferLine(product.id, rafsiz)
                    onSave(out)
                },
                enabled = valid,
            )
            SecondaryButton("Vazgeç", onCancel)
        }),
    ) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Card {
                Column {
                    Text(product.name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    MonoText(listOfNotNull(product.code, product.barcode).joinToString(" · "), size = 13, weight = FontWeight.Medium, color = C.Muted)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Adet", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = C.Text2)
                        Hint("${product.unit} · $fromName deposundaki raf stoku ${fmt(total)}")
                    }
                    QtyStepper(qty, { qty = it; autoFill(it) })
                }
            }
            if (total <= 1e-9) {
                Notice(
                    "$fromName deposunda bu ürün hiçbir rafta görünmüyor. Rafsız gönder: raftan düşülmez, yalnız Vega'ya gönderim fişi yazılır.",
                    Tone.Warn, title = "Rafsız gönder", icon = Ic.Warning,
                )
            } else {
                Card(padding = PaddingValues(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Caption("Hangi raftan?", Modifier.weight(1f))
                        Text(
                            "${fmt(assigned)} / ${fmt(needed)}", fontWeight = FontWeight.Bold, fontSize = 15.sp,
                            color = if (valid) C.Ok else C.Warn,
                        )
                    }
                    ScanField("Raf okutun (isteğe bağlı)", "Okutulan raftan kalan miktar düşülür", true, vm.repo.prefs.cameraButton, ::onShelf)
                    stocks.forEach { s ->
                        val a = alloc[s.shelf] ?: 0.0
                        Divider()
                        Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                MonoText(s.shelf, size = 16, weight = FontWeight.SemiBold)
                                Hint("rafta ${fmt(s.qty)}")
                            }
                            QtyStepper(a, { alloc[s.shelf] = it.coerceIn(0.0, s.qty).let { v -> minOf(v, a + remaining) } }, max = s.qty, small = true)
                        }
                    }
                }
                if (!valid) {
                    Notice(
                        "Raf stoku olan ürün raftan düşülmeden gönderilemez: ${fmt(needed)} ${product.unit.lowercase()} için raf seçin" +
                            (if (assigned > needed + 1e-6) " (seçilen fazla)." else "."),
                        Tone.Warn, icon = Ic.Warning,
                    )
                }
                if (qty > total + 1e-9) {
                    Hint("Raf stoku ${fmt(total)}; kalan ${fmt(qty - total)} ${product.unit.lowercase()} rafsız gider (rafa kaldırılmayı bekleyen mal olabilir).")
                }
            }
        }
    }
}

// ---- Gönderim kabul: liste ----------------------------------------------------------------

@Composable
fun ReceiveListScreen(vm: AppVm, online: Boolean, version: Int) {
    val db = vm.repo.db
    val info = remember(version) { vm.repo.transferInfo() }
    val d = db.depot
    val mine = info.incoming.filter { it.to == d }
    val others = info.incoming.filter { it.to != d }
    LocksPoller(vm)
    Screen("Gönderim Kabul", sub = db.depotName(d).ifBlank { null }, online = online, onBack = { vm.back() }, scroll = false) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (mine.isEmpty()) {
                Notice("Bu depoya kabul bekleyen gönderim yok. Gönderen taraf fişi kestikten sonra liste birkaç saniye içinde yenilenir.", Tone.Info, icon = Ic.Inbox)
            }
            mine.forEach { s ->
                val started = vm.receiveDraft(s.id).isNotEmpty()
                Card(onClick = { vm.go(Route.ReceiveDoc(s.id)) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        MonoText(s.no, size = 17, modifier = Modifier.weight(1f))
                        Hint(s.date)
                    }
                    Text("${s.fromName} deposundan", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    LockTag(vm, "SEVK-${s.id}")
                    Hint("${s.lines.size} kalem · toplam ${fmt(s.lines.sumOf { it.open })}" + if (started) " · okutma sürüyor" else "")
                }
            }
            if (others.isNotEmpty()) {
                Hint("Başka depolara ${others.size} gönderim daha var (${others.map { it.toName }.distinct().joinToString(", ")}); o depoyu çalışılan depo seçerek kabul edin.")
            }
        }
    }
}

// ---- Gönderim kabul: belge ----------------------------------------------------------------

@Composable
fun ReceiveDocScreen(vm: AppVm, online: Boolean, version: Int, sevkId: String) {
    val db = vm.repo.db
    val info = remember(version) { vm.repo.transferInfo() }
    val sevk: Incoming? = info.incoming.firstOrNull { it.id == sevkId }
    val draft = vm.receiveDraft(sevkId)
    var confirm by remember { mutableStateOf(false) }
    var leaveAsk by remember { mutableStateOf(false) }
    // Sepet gibi okutma: 0 okutulanlar (en son okutulan üstte), 1 kalanlar, 2 gönderimin tamamı.
    var tab by remember { mutableStateOf(0) }
    var lastPid by remember { mutableStateOf<String?>(null) }
    var scanTick by remember { mutableStateOf(0) }

    // Belge kilidi: girerken alınır; yönetici açarsa ya da başka terminal alırsa okutulanlar kısmi kabul olarak kaydedilip çıkılır.
    DocLockEffect(vm, "SEVK-$sevkId", "TRANSFER", sevk?.no ?: sevkId)
    LaunchedEffect(vm.docLock.state) {
        if (vm.docLock.state == LockState.LOST) {
            val s = info.incoming.firstOrNull { it.id == sevkId }
            if (s != null && draft.isNotEmpty()) {
                vm.repo.receiveTransfer(s, writable(s, draft.toList()), vm.userName, partial = true)
                vm.dropReceiveDraft(sevkId)
                vm.saved("${vm.docLock.message}; okutulanlar kısmi kabul olarak kaydedildi")
            } else vm.error(vm.docLock.message)
            vm.back()
        }
    }
    if (vm.docLock.state == LockState.TAKEN) {
        DocTakenScreen(vm, online, sevk?.no ?: "Gönderim")
        return
    }
    if (sevk == null) {
        // Okutma alanı bu dalda yoktur; buraya düşen okutmalar kaybolur. Sürerse tanı raporunda görünsün.
        Diag.crumb("kabul: gönderim listede yok ($sevkId, ${info.incoming.size} gönderim)")
        Screen("Gönderim Kabul", online = online, onBack = { vm.back() }) {
            Notice("Bu gönderim artık açık görünmüyor (kabul edilmiş ya da iptal edilmiş olabilir).", Tone.Warn, icon = Ic.Warning)
            SecondaryButton("Geri", { vm.back() })
        }
        return
    }

    fun have(pid: String) = draft.qtyOf(pid)
    fun remaining(pid: String): Double = (sevk.lines.firstOrNull { it.productId == pid }?.open ?: 0.0) - have(pid)

    fun onProduct(p: Product) {
        val l = sevk.lines.firstOrNull { it.productId == p.id } ?: return vm.error("${p.name} bu gönderimde yok")
        lastPid = p.id
        scanTick++
        val n = have(p.id) + 1
        // Okutulan ürün sepetin başına çıkar: liste okutma sırasını gösterir.
        draft.removeAll { it.productId == p.id }
        draft.add(TransferLine(p.id, n))
        // Gönderilen aşılsa da okutma geçer: sesli ve görüntülü uyarı verilir, belge sonunda ayrıca uyarılır.
        if (n - l.open > 1e-9) vm.error("${p.name}: gönderilenden fazla · ${fmt(n)}/${fmt(l.open)}")
        else vm.ok("${p.name} · ${fmt(n)}/${fmt(l.open)}")
    }

    /** Okutulanlar kısmi kabul olarak gider; gönderim açık kalır, eksik kaydı açılmaz. */
    fun savePartial(thenLeave: Boolean) {
        vm.repo.receiveTransfer(sevk, writable(sevk, draft.toList()), vm.userName, partial = true)
        vm.dropReceiveDraft(sevk.id)
        vm.saved("Okutulanlar kısmi kabul olarak kaydedildi")
        if (thenLeave) vm.back()
    }

    val missing = sevk.lines.filter { remaining(it.productId) > 1e-9 }
    val over = sevk.lines.filter { remaining(it.productId) < -1e-9 }
    // Daha önce kısmi alınmışsa yeni okutma olmasa da kabul bitirilebilir (kalan eksik olur).
    val hadPartial = sevk.lines.any { it.open < it.sent - 1e-9 }
    BackHandler(enabled = draft.isNotEmpty()) { leaveAsk = true }
    Screen(
        "Gönderim Kabul", sub = "${sevk.no} · ${sevk.fromName} → ${sevk.toName}", online = online,
        onBack = { if (draft.isNotEmpty()) leaveAsk = true else vm.back() }, scroll = false,
        footer = ({
            PrimaryButton(
                if (missing.isEmpty()) "Kabulü bitir" else "Kabulü bitir · ${missing.size} kalem eksik",
                { confirm = true }, enabled = draft.isNotEmpty() || hadPartial,
            )
        }),
    ) {
        // Okutma sepet gibi çalışır: her okutma 1 adet sayar, ürün "Okutulan" listesinin başına çıkar. Adet girilmez;
        // +/− yalnız düzeltme içindir. 50-60 kalemlik gönderimde eksiği aramak için "Kalan" sekmesi yalnız gelmeyenleri gösterir.
        val totalOpen = sevk.lines.sumOf { it.open }
        val gotTotal = sevk.lines.sumOf { minOf(have(it.productId), it.open) }
        val scanned = draft.map { it.productId }.asReversed().mapNotNull { pid -> sevk.lines.firstOrNull { it.productId == pid } }
        val shown = when (tab) {
            0 -> scanned
            1 -> missing.sortedByDescending { have(it.productId) > 1e-9 }
            else -> sevk.lines
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            DocUnlockedNotice(vm)
            // Okutulan/gönderilen adet okutma alanının ipucunda; gönderilenden fazla okutma engellenmez, ipucunda görünür (ayrıca bitirme penceresinde uyarılır).
            ProductScanField(
                vm, "Ürün okutun",
                "${fmt(gotTotal)}/${fmt(totalOpen)}" + if (over.isNotEmpty()) " · fazla +${fmt(over.sumOf { -remaining(it.productId) })}" else " adet",
                ::onProduct, showSearchLink = false,
            )
            // Başarılı okutma listenin başındaki vurgulu satırda görünür; çubuk yalnız hatada çıkar (liste yerinden oynamasın).
            MessageBar(vm.message?.takeIf { it.second }?.first, true)
            // Okutma alanı ve sekmeler sabit, yalnız liste kayar: küçük ekranda bile okunanlar hep görünür.
            val shape = RoundedCornerShape(12.dp)
            Column(Modifier.weight(1f).fillMaxWidth().clip(shape).background(C.Surface).border(1.dp, C.Line, shape)) {
                Column(Modifier.padding(start = 14.dp, end = 8.dp, top = 8.dp)) {
                    Row(Modifier.padding(end = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Segment("Okunan ${scanned.size}", tab == 0, Modifier.weight(1f)) { tab = 0 }
                        Segment("Kalan ${missing.size}", tab == 1, Modifier.weight(1f)) { tab = 1 }
                        Segment("Tümü ${sevk.lines.size}", tab == 2, Modifier.weight(1f)) { tab = 2 }
                    }
                    if (shown.isEmpty()) {
                        if (tab == 0) Hint("Henüz ürün okutulmadı. Okutulan her ürün burada listelenir.", Modifier.padding(bottom = 8.dp))
                        else Notice("Gönderimdeki her ürün okutuldu; kabulü bitirebilirsiniz.", Tone.Ok)
                    }
                }
                // Anahtarlı liste, eklenen satır başa gelse de eski konumda kalır; her okutmada en başa dönülür ki son okutulan görünsün.
                val listState = rememberLazyListState()
                LaunchedEffect(scanTick, tab) { listState.scrollToItem(0) }
                LazyColumn(Modifier.weight(1f).padding(start = 14.dp, end = 8.dp), state = listState) {
                    items(shown, key = { it.productId }) { l ->
                        val pr = db.productById(l.productId)
                        val got = have(l.productId)
                        val done = l.open - got <= 1e-9
                        val fazla = got - l.open > 1e-9
                        val renk = if (fazla) C.Err else if (done) C.Ok else if (got > 1e-9) C.Warn else C.Muted
                        Divider()
                        // Son okutulan satır renkli: yeşil tamam, kırmızı fazla, sarı devam ediyor.
                        val vurgu = if (l.productId != lastPid) Color.Transparent else if (fazla) C.ErrBg else if (done) C.OkBg else C.AccentBg
                        Row(
                            Modifier.fillMaxWidth().background(vurgu).padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(pr?.name ?: l.productId, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                                Text(
                                    listOfNotNull(pr?.code, if (l.sent - l.open > 1e-9) "gönderilen ${fmt(l.sent)}" else null).joinToString(" · "),
                                    fontSize = 12.sp, color = C.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            }
                            // Adet girilmez: okutma sayar. Yanlış okutma için tek adım geri alınır.
                            MonoText("${fmt(got)}/${fmt(l.open)}", size = 18, color = renk)
                            if (got > 1e-9) UndoButton { draft.setQty(l.productId, got - 1) }
                        }
                    }
                    item {
                        Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            // Seyrek işlemler listenin sonunda: ekranı sabit başlıkla doldurmasınlar.
                            if (draft.isNotEmpty()) {
                                Row {
                                    LinkText("Okutulanları kısmi kaydet · ${fmt(writable(sevk, draft.toList()).sumOf { it.qty })}") { savePartial(false) }
                                    LinkText("Sıfırla", C.Err) { draft.clear(); lastPid = null }
                                }
                            }
                            if (hadPartial) Hint("Bu gönderimden bir kısmı daha önce alındı; yukarıdakiler kalan miktardır.")
                            Hint("Alınan mal Rafa Kaldır'da belge olarak bekler; oradan rafa yerleştirilir.")
                        }
                    }
                }
            }
        }
    }

    if (leaveAsk) {
        AlertDialog(
            onDismissRequest = { leaveAsk = false },
            title = { Text("Okutulanlar kaydedilsin mi?") },
            text = { Text("${fmt(draft.sumOf { it.qty })} adet okutuldu, henüz kaydedilmedi. Kısmi kabul olarak kaydedilirse gönderim açık kalır; kalanı sonra alınır ya da \"Kabulü bitir\" ile eksik yazılır.") },
            confirmButton = {
                TextButton({ leaveAsk = false; savePartial(true) }, Modifier.focusProperties { canFocus = false }) { Text("Kısmi kaydet", fontWeight = FontWeight.Bold) }
            },
            dismissButton = {
                Row {
                    TextButton({ leaveAsk = false }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") }
                    TextButton({ leaveAsk = false; vm.back() }, Modifier.focusProperties { canFocus = false }) { Text("Taslak kalsın") }
                }
            },
        )
    }
    if (confirm) {
        val eksik = missing.sumOf { remaining(it.productId) }
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(if (missing.isEmpty() && over.isEmpty()) "Kabul tamamlansın mı?" else if (missing.isEmpty()) "Fazla okutulan var, yine de bitsin mi?" else "Eksik var, yine de bitsin mi?") },
            text = {
                if (missing.isEmpty() && over.isEmpty()) Text("Gönderimdeki her ürün alındı. Vega'ya gönderim kabul fişi yazılır; mal Rafa Kaldır'da bekler.")
                else Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (missing.isNotEmpty()) {
                        Text("${missing.size} kalemde toplam ${fmt(eksik)} adet eksik:", fontWeight = FontWeight.SemiBold)
                        missing.forEach { l ->
                            val pr = db.productById(l.productId)
                            Text("• ${pr?.name ?: l.productId} · ${pr?.code ?: ""} ×${fmt(remaining(l.productId))}", fontSize = 14.sp)
                        }
                    }
                    if (over.isNotEmpty()) {
                        Text("${over.size} kalemde gönderilenden fazla okutuldu:", fontWeight = FontWeight.SemiBold, color = C.Err)
                        over.forEach { l ->
                            val pr = db.productById(l.productId)
                            Text("• ${pr?.name ?: l.productId} · ${pr?.code ?: ""} +${fmt(-remaining(l.productId))} (${fmt(have(l.productId))}/${fmt(l.open)})", fontSize = 14.sp, color = C.Err)
                        }
                        Text("Fazla okutulan miktar fişe yazılmaz; yalnız gönderilen kadar kabul edilir.", fontSize = 13.sp, color = C.Err)
                    }
                    Text(
                        "Vega'ya yalnız gelen miktar için kabul fişi yazılır." +
                            (if (missing.isNotEmpty()) " Eksik mal kayıtlı kalır (gönderen depo ve ürün), yönetici programında takip edilir; gönderim kapanır." else " Gönderim kapanır."),
                        fontSize = 13.sp, color = C.Muted,
                    )
                }
            },
            confirmButton = {
                TextButton({
                    confirm = false
                    vm.repo.receiveTransfer(sevk, writable(sevk, draft.toList()), vm.userName)
                    vm.dropReceiveDraft(sevk.id)
                    vm.saved(
                        "Gönderim kabul edildi: ${sevk.no}" + (if (missing.isNotEmpty()) " · eksik ${missing.size} kalem" else "") +
                            (if (over.isNotEmpty()) " · fazla ${over.size} kalem" else ""),
                    )
                    vm.back()
                }, Modifier.focusProperties { canFocus = false }) { Text(if (missing.isEmpty() && over.isEmpty()) "Kabul et" else if (missing.isEmpty()) "Yine de bitir" else "Eksikle bitir", fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton({ confirm = false }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") } },
        )
    }
}
