package tr.arcteknik.depo.ui.screens

import androidx.activity.compose.BackHandler
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
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

/*
 * Depolar arası transfer. Yalnız ayarlardaki iki depo (örneğin Merkez ↔ Toybelen) arasında yapılır.
 *  - Depoya Gönder: çıkış deposu iki seçenekten sorulur, varış diğer depodur. Akış: ürün okut → adet → raf. Ürün çıkış
 *    deposunda raf stoku olan bir ürünse raf seçmek zorunludur (adet raflara bölünebilir, hiçbir rafta stoğun üstüne
 *    çıkılamaz); raf stoku olmayan ürün "rafsız" gider. Raf stokundan fazlası da rafsız geçer: rafa kaldırılmayı bekleyen
 *    mal olabilir. Gönder deyince varış onaylanır ve sunucu Vega'ya depo gönderim fişi (128) yazar.
 *  - Gönderim Kabul: gelen ürünler okutulur, her okutma 1 adet sayar. Okutulanlar "kaydet" ile kısmi kabul olarak gider,
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

    // Transfer iki depo arasındadır (sunucu ayarı): çıkış bu ikiliden biri, varış diğeri.
    val pair = info.depots
    val from = pair.firstOrNull { it.id == draft.from }?.id ?: pair.firstOrNull { it.id == db.depot }?.id ?: pair.firstOrNull()?.id ?: 0
    val toDepot = pair.firstOrNull { it.id != from }
    val fromName = pair.firstOrNull { it.id == from }?.name ?: db.depotName(from).ifBlank { from.toString() }
    val toName = toDepot?.name ?: ""
    val lines = draft.lines

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

    Screen(
        "Depoya Gönder", sub = "$fromName → $toName", online = online, onBack = { vm.back() },
        footer = if (lines.isNotEmpty()) ({
            PrimaryButton("Gönder · ${lines.map { it.productId }.distinct().size} kalem", { confirm = true })
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
                Text(toName, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Hint("karşıdaki depo")
            }
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ProductScanField(vm, "Ürün okutun", "Barkod okutun ya da isimle arayın; sonra adet ve raf", onProduct = { editing = it })
            MessageBar(vm.message?.first, vm.message?.second == true)
            if (lines.isNotEmpty()) {
                Card(padding = PaddingValues(start = 14.dp, end = 8.dp, top = 10.dp, bottom = 4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Caption("Gönderilecekler", Modifier.weight(1f))
                        LinkText("Sıfırla", C.Err) { lines.clear() }
                    }
                    lines.groupBy { it.productId }.forEach { (pid, ls) ->
                        val p = db.productById(pid, from)
                        Divider()
                        Row(Modifier.clickable { p?.let { editing = it } }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(p?.name ?: pid, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                                Hint(p?.code ?: "")
                                Hint(ls.joinToString(" · ") { (if (it.shelf.isBlank()) "rafsız" else it.shelf) + " ×" + fmt(it.qty) })
                            }
                            MonoText(fmt(ls.sumOf { it.qty }), size = 18)
                            LinkText("Sil", C.Err) { draft.replace(pid, emptyList()) }
                        }
                    }
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
            note = "Mal bu depodan çıkar; varış karşıdaki depodur. Raftaki stok varsa raf da sorulur.",
        )
    }
    if (confirm) {
        val total = lines.sumOf { it.qty }
        val rafsiz = lines.filter { it.shelf.isBlank() }.sumOf { it.qty }
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("$toName deposuna gönderilsin mi?") },
            text = {
                Text(
                    "Çıkış: $fromName\nVarış: $toName\n${lines.map { it.productId }.distinct().size} kalem, toplam ${fmt(total)}" +
                        (if (rafsiz > 1e-9) "\n${fmt(rafsiz)} adet rafsız gidiyor." else "") +
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
    val stocks = remember(product.id, from) {
        val home = db.homeShelves(product.id, from)
        db.locationsOf(product.id, from).filter { it.qty > 1e-9 }.sortedWith(compareByDescending<tr.arcteknik.depo.data.Location> { it.shelf in home }.thenByDescending { it.qty })
    }
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
        "Depoya Gönder", sub = "$fromName → $toName", online = online, onBack = onCancel,
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

    // Belge kilidi: girerken alınır; yönetici açarsa ya da başka terminal alırsa okutulanlar kısmi kabul olarak kaydedilip çıkılır.
    DocLockEffect(vm, "SEVK-$sevkId", "TRANSFER", sevk?.no ?: sevkId)
    LaunchedEffect(vm.docLock.state) {
        if (vm.docLock.state == LockState.LOST) {
            val s = info.incoming.firstOrNull { it.id == sevkId }
            if (s != null && draft.isNotEmpty()) {
                vm.repo.receiveTransfer(s, draft.toList(), vm.userName, partial = true)
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
        Screen("Gönderim Kabul", online = online, onBack = { vm.back() }) {
            Notice("Bu gönderim artık açık görünmüyor (kabul edilmiş ya da iptal edilmiş olabilir).", Tone.Warn, icon = Ic.Warning)
            SecondaryButton("Geri", { vm.back() })
        }
        return
    }

    fun have(pid: String) = draft.qtyOf(pid)
    fun remaining(pid: String): Double = (sevk.lines.firstOrNull { it.productId == pid }?.open ?: 0.0) - have(pid)

    fun onProduct(p: Product) {
        if (sevk.lines.none { it.productId == p.id }) return vm.error("${p.name} bu gönderimde yok")
        if (remaining(p.id) <= 1e-9) return vm.error("${p.name}: gönderilen miktar zaten okutuldu")
        val n = have(p.id) + 1
        draft.setQty(p.id, n)
        vm.ok("${p.name} · ${fmt(n)}/${fmt(sevk.lines.first { it.productId == p.id }.open)}")
    }

    /** Okutulanlar kısmi kabul olarak gider; gönderim açık kalır, eksik kaydı açılmaz. */
    fun savePartial(thenLeave: Boolean) {
        vm.repo.receiveTransfer(sevk, draft.toList(), vm.userName, partial = true)
        vm.dropReceiveDraft(sevk.id)
        vm.saved("Okutulanlar kısmi kabul olarak kaydedildi")
        if (thenLeave) vm.back()
    }

    val missing = sevk.lines.filter { remaining(it.productId) > 1e-9 }
    // Daha önce kısmi alınmışsa yeni okutma olmasa da kabul bitirilebilir (kalan eksik olur).
    val hadPartial = sevk.lines.any { it.open < it.sent - 1e-9 }
    BackHandler(enabled = draft.isNotEmpty()) { leaveAsk = true }
    Screen(
        "Gönderim Kabul", sub = "${sevk.no} · ${sevk.fromName} → ${sevk.toName}", online = online,
        onBack = { if (draft.isNotEmpty()) leaveAsk = true else vm.back() },
        footer = ({
            if (draft.isNotEmpty()) SecondaryButton("Okutulanları kaydet (kısmi) · ${fmt(draft.sumOf { it.qty })}", { savePartial(false) })
            PrimaryButton("Kabulü bitir", { confirm = true }, enabled = draft.isNotEmpty() || hadPartial)
        }),
    ) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            DocUnlockedNotice(vm)
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
            if (hadPartial) Hint("Bu gönderimden bir kısmı daha önce alındı; yukarıdakiler kalan miktardır.")
            Hint("Alınan mal Rafa Kaldır'da belge olarak bekler; oradan rafa yerleştirilir.")
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
