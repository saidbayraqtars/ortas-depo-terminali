package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.graphics.Color
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
import tr.arcteknik.depo.ui.QtyStepper
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton
import tr.arcteknik.depo.ui.Tone

/*
 * Depolar arası transfer. Raf adımı yok: gönderirken de kabul ederken de ürün okutulur, her okutma 1 adet ekler,
 * miktar satırdaki +/− ile düzeltilir.
 *  - Depoya Gönder: çıkış deposu sorulur, varış deposu seçilir, ürünler okutulur. Gönder deyince sunucu Vega'ya depo
 *    gönderim fişi (128) yazar.
 *  - Gönderim Kabul: alan depoya gelen gönderimler listelenir, gelen ürünler okutulur. Kabulü bitirince sunucu gönderim
 *    kabul fişi (129) yazar; alınan mal Rafa Kaldır'da belge olarak bekler, oradan rafa yerleştirilir. Gelmeyen miktar
 *    kayıtlı kalır (eksik), gönderim kapanır.
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

    val from = if (draft.from == 0) db.depot else draft.from
    val to = draft.to
    val fromName = db.depotName(from).ifBlank { from.toString() }
    val toName = info.depots.firstOrNull { it.id == to }?.name ?: ""
    val lines = draft.lines

    fun onProduct(p: Product) {
        val n = lines.qtyOf(p.id) + 1
        lines.setQty(p.id, n)
        vm.ok("${p.name} · ${fmt(n)} ${p.unit.lowercase()}")
    }

    Screen(
        "Depoya Gönder", sub = "$fromName → ${toName.ifBlank { "?" }}", online = online, onBack = { vm.back() },
        footer = if (lines.isNotEmpty()) ({
            PrimaryButton("Gönder · ${lines.size} kalem", { confirm = true })
        }) else null,
    ) {
        Card(padding = PaddingValues(horizontal = 14.dp, vertical = 2.dp)) {
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
        if (to == 0) {
            Hint("Mal gönderilecek depoyu seçin. Sonra ürünleri okutun.")
            return@Screen
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ProductScanField(vm, "Ürün okutun", "Her okutma 1 adet ekler; barkod ya da isimle arama", ::onProduct)
            MessageBar(vm.message?.first, vm.message?.second == true)
            if (lines.isNotEmpty()) {
                Card(padding = PaddingValues(start = 14.dp, end = 8.dp, top = 10.dp, bottom = 4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Caption("Gönderilecekler", Modifier.weight(1f))
                        LinkText("Sıfırla", C.Err) { lines.clear() }
                    }
                    lines.toList().forEach { l ->
                        val p = db.productById(l.productId)
                        Divider()
                        Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(p?.name ?: l.productId, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                                Hint(p?.code ?: "")
                            }
                            QtyStepper(l.qty, { lines.setQty(l.productId, it) }, small = true)
                        }
                    }
                }
            }
        }
    }

    if (pickFrom) {
        DepotDialog(
            db.depots().filter { it.id != to && it.id != info.yolda }, from,
            { draft.from = it; draft.fromConfirmed = true; pickFrom = false; if (draft.to == 0) pickTo = true },
            { if (draft.fromConfirmed) pickFrom = false else vm.back() },
            title = "Hangi depodan çıkıyor?",
            note = "Mal bu depodan çıkar. Raf belirtilmez; Vega'da bu depodan düşer.",
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
    var confirm by remember { mutableStateOf(false) }

    fun have(pid: String) = draft.qtyOf(pid)
    fun remaining(pid: String): Double = (sevk.lines.firstOrNull { it.productId == pid }?.open ?: 0.0) - have(pid)

    fun onProduct(p: Product) {
        if (sevk.lines.none { it.productId == p.id }) return vm.error("${p.name} bu gönderimde yok")
        if (remaining(p.id) <= 1e-9) return vm.error("${p.name}: gönderilen miktar zaten okutuldu")
        val n = have(p.id) + 1
        draft.setQty(p.id, n)
        vm.ok("${p.name} · ${fmt(n)}/${fmt(sevk.lines.first { it.productId == p.id }.open)}")
    }

    val missing = sevk.lines.filter { remaining(it.productId) > 1e-9 }
    Screen(
        "Gönderim Kabul", sub = "${sevk.no} · ${sevk.fromName} → ${sevk.toName}", online = online, onBack = { vm.back() },
        footer = ({
            PrimaryButton("Kabulü bitir", { confirm = true }, enabled = draft.isNotEmpty())
        }),
    ) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ProductScanField(vm, "Ürün okutun", "Gelen ürünü okutun; her okutma 1 adet sayar", ::onProduct)
            MessageBar(vm.message?.first, vm.message?.second == true)
            Card(padding = PaddingValues(start = 14.dp, end = 8.dp, top = 10.dp, bottom = 4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Caption("Gönderimdekiler · ${sevk.lines.size - missing.size}/${sevk.lines.size} tamam", Modifier.weight(1f))
                    if (draft.isNotEmpty()) LinkText("Sıfırla", C.Err) { draft.clear() }
                }
                sevk.lines.forEach { l ->
                    val pr = db.productById(l.productId)
                    val got = have(l.productId)
                    val done = l.open - got <= 1e-9
                    Divider()
                    Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(pr?.name ?: l.productId, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Hint(pr?.code ?: "")
                                Text("/ ${fmt(l.open)}", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = if (done) C.Ok else C.Muted)
                            }
                        }
                        QtyStepper(got, { draft.setQty(l.productId, it.coerceAtMost(l.open)) }, max = l.open, small = true)
                    }
                }
            }
            Hint("Alınan mal Rafa Kaldır'da belge olarak bekler; oradan rafa yerleştirilir.")
        }
    }

    if (confirm) {
        val eksik = missing.sumOf { remaining(it.productId) }
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(if (missing.isEmpty()) "Kabul tamamlansın mı?" else "Eksik var, yine de bitsin mi?") },
            text = {
                Text(
                    if (missing.isEmpty()) "Gönderimdeki her ürün alındı. Vega'ya gönderim kabul fişi yazılır; mal Rafa Kaldır'da bekler."
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
