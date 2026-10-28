package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tr.arcteknik.depo.data.Incoming
import tr.arcteknik.depo.data.Product
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.data.TransferLine
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.DepotDialog
import tr.arcteknik.depo.ui.Divider
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.Ic
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.Notice
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.ScanField
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton
import tr.arcteknik.depo.ui.Tone

/*
 * Depolar arası transfer.
 *  - Depoya Gönder: çıkış deposu sorulur, varış deposu seçilir, ürünler okutulur (raf okutulursa o raftan düşer);
 *    Gönder deyince sunucu Vega'ya depo gönderim fişi (128) yazar.
 *  - Gönderim Kabul: alan depoya gelen gönderimler listelenir; gelen ürünler okutulur ve rafa konur; kabulü bitirince
 *    sunucu gönderim kabul fişi (129) yazar. Gelmeyen miktar kayıtlı kalır, gönderim kapanır.
 */

@Composable
private fun LinkText(text: String, color: androidx.compose.ui.graphics.Color = C.Info, onClick: () -> Unit) {
    Text(
        text, color = color, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
        modifier = Modifier.focusProperties { canFocus = false }.clickable(onClick = onClick).padding(10.dp),
    )
}

/** Taslaktaki satırlar; her satırın yanında Sil. */
@Composable
private fun DraftLines(vm: AppVm, title: String, lines: List<TransferLine>, onRemove: (Int) -> Unit, onReset: (() -> Unit)? = null) {
    if (lines.isEmpty()) return
    val db = vm.repo.db
    Card(padding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Caption(title, Modifier.weight(1f))
            if (onReset != null) LinkText("Sıfırla", C.Err, onReset)
        }
        lines.forEachIndexed { i, l ->
            val p = db.productById(l.productId)
            Divider()
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                    Text(p?.name ?: l.productId, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                    Hint(listOfNotNull(p?.code, l.shelf.takeIf { it.isNotBlank() }).joinToString(" · "))
                }
                Text("${fmt(l.qty)} ${p?.unit?.lowercase() ?: ""}", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                LinkText("Sil", C.Err) { onRemove(i) }
            }
        }
    }
}

/** Aynı ürün ve raf tekrar eklenirse miktarlar toplanır. */
private fun MutableList<TransferLine>.addMerged(productId: String, qty: Double, shelf: String) {
    val i = indexOfFirst { it.productId == productId && it.shelf == shelf }
    if (i >= 0) this[i] = this[i].copy(qty = this[i].qty + qty) else add(TransferLine(productId, qty, shelf))
}

// ---- Depoya gönder ------------------------------------------------------------------------

@Composable
fun SendDepotScreen(vm: AppVm, online: Boolean, version: Int) {
    val db = vm.repo.db
    val info = remember(version) { vm.repo.transferInfo() }
    val draft = vm.sendDraft
    // Çıkış deposu her gönderimde sorulur; ilk açılışta çalışılan depo öneri olarak işaretli gelir.
    var pickFrom by remember { mutableStateOf(!draft.fromConfirmed) }
    var pickTo by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf(false) }
    var product by remember { mutableStateOf<Product?>(null) }
    var qty by remember { mutableStateOf(1.0) }

    val from = if (draft.from == 0) db.depot else draft.from
    val to = draft.to
    val fromName = db.depotName(from).ifBlank { from.toString() }
    val toName = info.depots.firstOrNull { it.id == to }?.name ?: ""
    val lines = draft.lines

    fun drafted(pid: String, shelf: String) = lines.filter { it.productId == pid && it.shelf == shelf }.sumOf { it.qty }

    fun addLine(p: Product, shelf: String) {
        lines.addMerged(p.id, qty, shelf)
        vm.ok("${p.name}: ${fmt(qty)} ${p.unit.lowercase()}" + if (shelf.isNotBlank()) " · $shelf" else "")
        product = null
        qty = 1.0
    }

    fun onShelf(code: String) {
        val p = product ?: return
        val s = code.uppercase()
        if (db.findProduct(code) != null) return vm.error("Raf barkodu okutun; bu bir ürün barkodu")
        val here = db.qtyAt(p.id, s, from) - drafted(p.id, s)
        when {
            !db.shelfExists(s, from) -> vm.error("\"$s\" $fromName deposunda tanımlı bir raf değil")
            here <= 0 -> vm.error("${p.name} $s rafında görünmüyor")
            here + 1e-9 < qty -> vm.error("$s rafında yalnız ${fmt(here)} ${p.unit.lowercase()} var")
            else -> addLine(p, s)
        }
    }

    Screen(
        "Depoya Gönder", sub = "$fromName → ${toName.ifBlank { "?" }}", online = online, onBack = { vm.back() },
        footer = if (lines.isNotEmpty() && product == null) ({
            PrimaryButton("Gönder · ${lines.size} kalem", { confirm = true })
        }) else null,
    ) {
        if (product == null) {
            Card(padding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Çıkış", fontSize = 12.sp, color = C.Muted, modifier = Modifier.width(52.dp))
                    Text(fromName, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    if (lines.isEmpty()) LinkText("Değiştir") { pickFrom = true } else Hint("satırlar silinince değişir")
                }
                Divider()
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Varış", fontSize = 12.sp, color = C.Muted, modifier = Modifier.width(52.dp))
                    Text(toName.ifBlank { "Seçilmedi" }, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = if (to == 0) C.Warn else C.Ink, modifier = Modifier.weight(1f))
                    LinkText(if (to == 0) "Seç" else "Değiştir") { pickTo = true }
                }
            }
        }
        if (to == 0) {
            Hint("Mal gönderilecek depoyu seçin. Sonra ürünleri okutun.")
            return@Screen
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val p = product
            if (p == null) {
                ProductScanField(vm, "Ürün okutun", "Gönderilecek ürünün barkodu ya da listeden seçin", { x ->
                    product = x
                    qty = 1.0
                    vm.ok(x.name)
                })
                MessageBar(vm.message?.first, vm.message?.second == true)
                DraftLines(vm, "Gönderilecekler", lines, { lines.removeAt(it) })
            } else {
                val locs = remember(version, p.id, from) { db.locationsOf(p.id, from).filter { it.qty > 0 } }
                val total = locs.sumOf { it.qty }
                Card {
                    Text(p.name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    MonoText(listOfNotNull(p.code, p.barcode).joinToString(" · "), size = 13, weight = FontWeight.Medium, color = C.Muted)
                    Hint(if (total > 0) "$fromName deposunda raflarda toplam ${fmt(total)} ${p.unit.lowercase()}" else "$fromName deposunda rafta görünmüyor; raf belirtmeden eklenebilir.")
                }
                QtyRow(qty, { qty = it }, p.unit, if (total > 0) total else 9999.0)
                ScanField("Raf okutun", "Ürünün alındığı raf; ya da aşağıdan seçin", true, vm.repo.prefs.cameraButton, onScan = ::onShelf)
                MessageBar(vm.message?.first, vm.message?.second == true)
                if (locs.isNotEmpty()) {
                    Card(padding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 14.dp, top = 10.dp)) {
                        Caption("Ürünün rafları")
                        locs.take(8).forEach { l ->
                            Column(Modifier.focusProperties { canFocus = false }.clickable { onShelf(l.shelf) }) {
                                Divider()
                                Row(Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    MonoText(l.shelf, size = 16, modifier = Modifier.weight(1f))
                                    Hint("rafta ${fmt(l.qty - drafted(p.id, l.shelf))}")
                                }
                            }
                        }
                    }
                }
                SecondaryButton("Raf belirtmeden ekle", { addLine(p, "") })
                SecondaryButton("Vazgeç", { product = null })
            }
        }
    }

    if (pickFrom) {
        DepotDialog(
            db.depots().filter { it.id != to && it.id != info.yolda }, from,
            { draft.from = it; draft.fromConfirmed = true; pickFrom = false; if (draft.to == 0) pickTo = true },
            { if (draft.fromConfirmed) pickFrom = false else vm.back() },
            title = "Hangi depodan çıkıyor?",
            note = "Mal bu depodan çıkar; raf stoku bu depodan düşülür.",
        )
    }
    if (pickTo) {
        DepotDialog(
            info.depots.filter { it.id != from }, to,
            { draft.to = it; pickTo = false },
            { pickTo = false },
            title = "Hangi depoya gidiyor?",
            note = "Alan depo gönderimi kendi terminalinden kabul eder.",
        )
    }
    if (confirm) {
        val total = lines.sumOf { it.qty }
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Gönderilsin mi?") },
            text = { Text("$fromName → $toName\n${lines.size} kalem, toplam ${fmt(total)}\n\nVega'ya depo gönderim fişi yazılır; mal alan depo kabul edene kadar yolda görünür.") },
            confirmButton = {
                TextButton({
                    confirm = false
                    vm.repo.sendTransfer(from, to, lines.toList(), vm.userName)
                    draft.clear()
                    vm.saved("Gönderim kaydedildi: $fromName → $toName")
                    vm.back()
                }, Modifier.focusProperties { canFocus = false }) { Text("Gönder", fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton({ confirm = false }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") } },
        )
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
    Screen("Gönderim Kabul", sub = db.depotName(d).ifBlank { null }, online = online, onBack = { vm.back() }) {
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
    if (sevk == null) {
        Screen("Gönderim Kabul", online = online, onBack = { vm.back() }) {
            Notice("Bu gönderim artık açık görünmüyor (kabul edilmiş ya da iptal edilmiş olabilir).", Tone.Warn, icon = Ic.Warning)
            SecondaryButton("Geri", { vm.back() })
        }
        return
    }
    val draft = vm.receiveDraft(sevk.id)
    val got = draft.groupBy { it.productId }.mapValues { e -> e.value.sumOf { it.qty } }
    var product by remember { mutableStateOf<Product?>(null) }
    var qty by remember { mutableStateOf(1.0) }
    var confirm by remember { mutableStateOf(false) }
    val d = sevk.to

    fun remaining(pid: String): Double = (sevk.lines.firstOrNull { it.productId == pid }?.open ?: 0.0) - (got[pid] ?: 0.0)

    fun addLine(p: Product, shelf: String) {
        draft.addMerged(p.id, qty, shelf)
        vm.ok("${p.name}: ${fmt(qty)} ${p.unit.lowercase()}" + if (shelf.isNotBlank()) " · $shelf" else "")
        product = null
        qty = 1.0
    }

    fun onProduct(p: Product) {
        if (sevk.lines.none { it.productId == p.id }) return vm.error("${p.name} bu gönderimde yok")
        val rem = remaining(p.id)
        if (rem <= 1e-9) return vm.error("${p.name}: gönderilen miktar zaten okutuldu")
        product = p
        qty = minOf(1.0, rem)
        vm.ok(p.name)
    }

    fun onShelf(code: String) {
        val p = product ?: return
        val s = code.uppercase()
        if (db.findProduct(code) != null) return vm.error("Raf barkodu okutun; bu bir ürün barkodu")
        if (!db.shelfExists(s, d)) vm.unknownShelf(s, d) { addLine(p, it) } else addLine(p, s)
    }

    val missing = sevk.lines.filter { remaining(it.productId) > 1e-9 }
    Screen(
        "Gönderim Kabul", sub = "${sevk.no} · ${sevk.fromName} → ${sevk.toName}", online = online, onBack = { vm.back() }, monoTitle = false,
        footer = if (product == null) ({
            PrimaryButton("Kabulü bitir", { confirm = true }, enabled = draft.isNotEmpty())
        }) else null,
    ) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val p = product
            if (p == null) {
                ProductScanField(vm, "Ürün okutun", "Gelen ürünün barkodu ya da listeden seçin", ::onProduct)
                MessageBar(vm.message?.first, vm.message?.second == true)
                Card(padding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Caption("Gönderimdekiler · ${sevk.lines.size - missing.size}/${sevk.lines.size} tamam", Modifier.weight(1f))
                        if (draft.isNotEmpty()) LinkText("Sıfırla", C.Err) { draft.clear() }
                    }
                    sevk.lines.forEach { l ->
                        val pr = db.productById(l.productId)
                        val have = got[l.productId] ?: 0.0
                        val done = l.open - have <= 1e-9
                        Divider()
                        Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f).clickable(enabled = !done) { pr?.let { onProduct(it) } }) {
                                Text(pr?.name ?: l.productId, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                                Hint(pr?.code ?: "")
                            }
                            Text(
                                "${fmt(have)}/${fmt(l.open)}", fontWeight = FontWeight.Bold, fontSize = 16.sp,
                                color = when { done -> C.Ok; have > 0 -> C.Warn; else -> C.Ink },
                            )
                        }
                    }
                }
                DraftLines(vm, "Okutulanlar", draft, { draft.removeAt(it) })
            } else {
                val rem = remaining(p.id)
                val options = remember(version, p.id, d) { db.shelfOptions(p.id, d).take(6) }
                Card {
                    Text(p.name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    MonoText(listOfNotNull(p.code, p.barcode).joinToString(" · "), size = 13, weight = FontWeight.Medium, color = C.Muted)
                    Hint("Gönderimde ${fmt(sevk.lines.first { it.productId == p.id }.open)}, şimdiye kadar alınan ${fmt(got[p.id] ?: 0.0)} ${p.unit.lowercase()}")
                }
                QtyRow(qty, { qty = it }, p.unit, rem)
                ScanField("Raf okutun", "Gelen malın konduğu raf; ya da aşağıdan seçin", true, vm.repo.prefs.cameraButton, onScan = ::onShelf)
                MessageBar(vm.message?.first, vm.message?.second == true)
                if (options.isNotEmpty()) {
                    Card(padding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 14.dp, top = 10.dp)) {
                        Caption("Ürünün rafları")
                        options.forEach { o ->
                            Column(Modifier.focusProperties { canFocus = false }.clickable { onShelf(o.shelf) }) {
                                Divider()
                                Row(Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    MonoText(o.shelf, size = 16, modifier = Modifier.weight(1f))
                                    Hint(when (o.kind) { 0 -> "rafta ${fmt(o.qty)}"; 1 -> "asıl raf"; else -> "başka depoda" })
                                }
                            }
                        }
                    }
                }
                SecondaryButton("Raf belirtmeden al", { addLine(p, "") })
                SecondaryButton("Vazgeç", { product = null })
            }
        }
    }

    if (confirm) {
        val eksik = missing.sumOf { remaining(it.productId) }
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(if (missing.isEmpty()) "Kabul tamamlansın mı?" else "Eksik var, yine de bitsin mi?") },
            text = {
                Text(
                    if (missing.isEmpty()) "Gönderimdeki her ürün alındı. Vega'ya gönderim kabul fişi yazılır."
                    else "${missing.size} kalemde toplam ${fmt(eksik)} eksik: " +
                        missing.take(5).joinToString(", ") { (db.productById(it.productId)?.code ?: it.productId) + " ×" + fmt(remaining(it.productId)) } +
                        (if (missing.size > 5) " …" else "") +
                        "\n\nVega'ya yalnız gelen miktar için kabul fişi yazılır. Eksik mal kayıtlı kalır (gönderen depo ve ürün), yönetici programında takip edilir; gönderim kapanır.",
                )
            },
            confirmButton = {
                TextButton({
                    confirm = false
                    vm.repo.receiveTransfer(sevk, draft.toList(), vm.userName)
                    vm.dropReceiveDraft(sevk.id)
                    vm.saved("Gönderim kabul edildi: ${sevk.no}" + if (missing.isNotEmpty()) " · eksik ${missing.size} kalem" else "")
                    vm.back()
                }, Modifier.focusProperties { canFocus = false }) { Text(if (missing.isEmpty()) "Kabul et" else "Eksikle bitir", fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton({ confirm = false }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") } },
        )
    }
}
