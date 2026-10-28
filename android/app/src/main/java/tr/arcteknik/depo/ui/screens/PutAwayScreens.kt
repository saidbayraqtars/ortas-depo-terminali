package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import tr.arcteknik.depo.data.Fuzzy
import tr.arcteknik.depo.data.Product
import tr.arcteknik.depo.data.ReceiptLine
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.DocLockEffect
import tr.arcteknik.depo.ui.DocTakenScreen
import tr.arcteknik.depo.ui.DocUnlockedNotice
import tr.arcteknik.depo.ui.Divider
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.Ic
import tr.arcteknik.depo.ui.LockState
import tr.arcteknik.depo.ui.LockTag
import tr.arcteknik.depo.ui.LocksPoller
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.Notice
import tr.arcteknik.depo.ui.Num
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.QtyStepper
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.ScanField
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton
import tr.arcteknik.depo.ui.Tone

@Composable
fun ReceiptListScreen(vm: AppVm, online: Boolean, version: Int) {
    val db = vm.repo.db
    var open by remember { mutableStateOf(true) }
    // Yazılan (henüz gönderilmemiş) metin ve okutulup tam eşleşmeyen metin listeyi süzer.
    var typed by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    val multiDepot = remember(version) { db.depots().size > 1 }
    // Belgeler çok birikince yalnız çalışılan deponunkiler gösterilir (varsayılan).
    var onlyHere by remember { mutableStateOf(true) }
    val all = remember(version, open) { db.receipts(open) }
    val q = typed.ifBlank { query }
    val receipts = remember(all, q, onlyHere) {
        all.filter { (!multiDepot || !onlyHere || it.depot == db.depot) && receiptMatches(it, q) }
    }
    val openCount = remember(version) { db.receipts(true).count { !multiDepot || !onlyHere || it.depot == db.depot } }

    // Başka terminallerin açtığı belgeler kilit simgesiyle görünür (belge kilidi).
    LocksPoller(vm)
    Screen("Rafa Kaldır", online = online, onBack = { vm.back() }) {
        // Ürün okutulursa belge seçmeden rafa kaldırılır (miktar açık belgelerden, artanı belgesiz); belge numarası
        // okutulursa belge açılır; tam eşleşme yoksa liste okutulan metne göre süzülür.
        ProductScanField(
            vm,
            title = "Ürün ya da belge okutun",
            hint = "Belge no ya da firma adı yazın; ürün okutunca belgesiz de kalkar",
            onProduct = { vm.go(Route.PutAwayProduct(it.id)) },
            onOther = { raw ->
                val code = eInvoiceNo(raw) ?: raw
                val open0 = db.receipts(true)
                val r = open0.firstOrNull { it.docNo.equals(code, true) || it.id == code }
                when {
                    r != null -> { query = ""; vm.go(Route.PutAway(r.id)); true }
                    open0.any { receiptMatches(it, code) } -> {
                        query = code; open = true
                        if (open0.none { it.depot == db.depot && receiptMatches(it, code) }) onlyHere = false
                        vm.feedback.ok()
                        true
                    }
                    else -> false
                }
            },
            onTextChange = { typed = it },
        )
        MessageBar(vm.message?.first, vm.message?.second == true)
        if (query.isNotBlank() && typed.isBlank()) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.InfoBg).clickable { query = "" }.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("\"$query\" için ${receipts.size} belge", Modifier.weight(1f), color = C.InfoText, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text("Temizle", color = C.Info, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
            }
        }
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.LineSoft).padding(4.dp)) {
            Segment("Bekleyen ($openCount)", open, Modifier.weight(1f)) { open = true }
            Segment("Tamamlanan", !open, Modifier.weight(1f)) { open = false }
        }
        if (multiDepot) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Hint(if (onlyHere) "${db.depotName(db.depot)} deposunun belgeleri" else "Bütün depoların belgeleri; mal belgenin deposunda rafa kalkar", Modifier.weight(1f))
                Text(
                    if (onlyHere) "Bütün depolar" else "Yalnız bu depo",
                    Modifier.focusProperties { canFocus = false }.clickable { onlyHere = !onlyHere }.padding(8.dp),
                    color = C.Info, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                )
            }
        } else Hint("Vega'da mal kabulü yapılmış belgeler")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(receipts, key = { it.id }) { r ->
                Card(onClick = { vm.go(Route.PutAway(r.id)) }) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        MonoText(r.docNo)
                        Hint(r.date)
                    }
                    // Belge başka depoya girdiyse göze çarpsın: rafa kaldırma o depoda olur.
                    if (multiDepot) Text(r.depotName, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = if (r.depot == vm.repo.db.depot) C.Muted else C.Info)
                    Text(r.supplier, fontWeight = FontWeight.SemiBold)
                    LockTag(vm, r.id)
                    val ratio = if (r.lineCount == 0) 0f else r.doneLines.toFloat() / r.lineCount
                    Box(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)).background(C.LineSoft)) {
                        Box(Modifier.fillMaxWidth(ratio).height(8.dp).background(C.Ok))
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${r.doneLines} / ${r.lineCount} kalem rafta", fontSize = 13.sp, color = C.Text2)
                        if (r.lineCount > r.doneLines) Text("${r.lineCount - r.doneLines} bekliyor", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = C.Warn)
                    }
                }
            }
        }
        if (receipts.isEmpty()) Hint(
            when {
                q.isNotBlank() -> "\"$q\" ile eşleşen belge yok" + if (multiDepot && onlyHere) "; bütün depolara bakın." else "."
                open -> "Rafa kaldırılmayı bekleyen belge yok."
                else -> "Tamamlanan belge yok."
            },
        )
    }
}

/**
 * Belge arama: her kelime belge numarasında, tedarikçide ya da depo adında geçmeli. Belge numarasında harf ve rakam
 * ayrı da eşleşir, baştaki sıfırlar atlanır: "npe2014", "NPE 2014" ve "2014" → NPE2026000002014.
 */
internal fun receiptMatches(r: tr.arcteknik.depo.data.Receipt, q: String): Boolean {
    val n = Fuzzy.norm(q)
    if (n.isBlank()) return true
    val doc = Fuzzy.norm(r.docNo).replace(" ", "")
    val hay = "$doc ${Fuzzy.norm(r.supplier)} ${Fuzzy.norm(r.depotName)}"
    val docLetters = doc.takeWhile { it.isLetter() }
    val docDigits = doc.drop(docLetters.length).filter { it.isDigit() }.trimStart('0')
    return n.split(' ').all { t ->
        if (hay.contains(t)) return@all true
        val letters = t.takeWhile { it.isLetter() }
        val digits = t.drop(letters.length)
        digits.isNotEmpty() && digits.all { it.isDigit() } && docLetters.startsWith(letters) && docDigits.contains(digits.trimStart('0'))
    }
}

/** e-Fatura/e-Arşiv karekodu (GİB JSON'u) okutulduysa içindeki fatura numarası. */
internal fun eInvoiceNo(code: String): String? {
    val s = code.trim()
    if (!s.startsWith("{")) return null
    return runCatching {
        val o = org.json.JSONObject(s)
        listOf("no", "faturaNo", "belgeNo").map { o.optString(it).trim() }.firstOrNull { it.isNotEmpty() }
    }.getOrNull()
}

@Composable
private fun Segment(text: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier.height(40.dp).clip(RoundedCornerShape(8.dp)).background(if (selected) C.Surface else C.LineSoft).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(text, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium, color = if (selected) C.Ink else C.Muted, fontSize = 14.sp) }
}

/** Belgeden rafa kaldırma: ürün okut → miktar → raf okut. */
@Composable
fun PutAwayScreen(vm: AppVm, online: Boolean, version: Int, receiptId: String) {
    val db = vm.repo.db
    val receipt = remember(version) { db.receipt(receiptId) }
    val lines = remember(version) { db.receiptLines(receiptId) }
    var lineId by remember { mutableStateOf<String?>(null) }
    var qty by remember { mutableStateOf(0.0) }
    var qtyDone by remember { mutableStateOf(false) }
    var shelf by remember { mutableStateOf<String?>(null) }
    var conflict by remember { mutableStateOf<Pair<String, String>?>(null) }
    var typed by remember { mutableStateOf("") }

    // Belge kilidi: belgeye girerken alınır, çıkınca bırakılır; başkası kullanıyorsa belge açılmaz.
    DocLockEffect(vm, receiptId, "KABUL", receipt?.docNo ?: receiptId)
    LaunchedEffect(vm.docLock.state) {
        // Her rafa kaldırma anında kaydedildiği için bekleyen iş yok; yalnız çıkılır.
        if (vm.docLock.state == LockState.LOST) { vm.error(vm.docLock.message); vm.back() }
    }
    if (vm.docLock.state == LockState.TAKEN) {
        DocTakenScreen(vm, online, receipt?.docNo ?: "Belge")
        return
    }

    val line = lines.firstOrNull { it.id == lineId }
    // Belge depo bazlı: raflar ve öneri belgenin deposundan. Rafta yoksa ürünün asıl rafı (Excel'den) önerilir.
    val rd = receipt?.depot ?: db.depot
    val suggested = remember(version, line?.product?.id) { line?.let { suggestedShelf(vm, it.product.id, rd) } }

    fun pick(l: ReceiptLine) {
        if (l.remaining <= 0) {
            vm.error("${l.product.name} bu belgede tamamlandı")
            return
        }
        lineId = l.id; qty = l.remaining; qtyDone = false; shelf = null
        vm.ok(l.product.name)
    }

    fun onProduct(p: Product) {
        val l = lines.filter { it.product.id == p.id }.maxByOrNull { it.remaining }
            ?: return vm.error("${p.name} bu belgede yok")
        pick(l)
    }

    fun onShelf(code: String) {
        val s = code.uppercase()
        if (db.findProduct(code) != null) return vm.error("Raf barkodu okutun; bu bir ürün barkodu")
        if (!db.shelfExists(s, rd)) return vm.unknownShelf(s, rd) { onShelf(it) }
        if (suggested != null && suggested != s) {
            vm.feedback.error()
            conflict = suggested to s
        } else {
            shelf = s
            vm.ok("Raf $s")
        }
    }

    Screen(
        receipt?.docNo ?: "Belge", sub = receipt?.let { listOf(it.depotName.takeIf { n -> n.isNotBlank() && db.depots().size > 1 }, it.supplier, "${it.doneLines} / ${it.lineCount}").filterNotNull().joinToString(" · ") },
        online = online, onBack = { vm.back() }, monoTitle = true,
        footer = when {
            line != null && !qtyDone -> ({
                MessageBar(vm.message?.first, vm.message?.second == true)
                PrimaryButton("Miktarı onayla", { qtyDone = true }, enabled = qty > 0 && qty <= line.remaining + 1e-9)
            })
            line != null && shelf != null -> ({
                MessageBar(vm.message?.first, vm.message?.second == true)
                PrimaryButton("${fmt(qty)} ${line.product.unit.lowercase()} $shelf rafına kaldır", {
                    vm.repo.putAway(line, shelf!!, qty, vm.userName)
                    val left = db.receiptLines(receiptId).count { it.remaining > 0 }
                    lineId = null; shelf = null; qtyDone = false
                    vm.saved(if (left == 0) "Belge tamamlandı" else "Rafa kaldırıldı · $left kalem kaldı")
                    if (left == 0) vm.back()
                }, enabled = qty > 0)
            })
            else -> null
        },
    ) {
        DocUnlockedNotice(vm)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Step("1 Ürün", line != null, line == null, Modifier.weight(1f))
            Step("2 Miktar", qtyDone, line != null && !qtyDone, Modifier.weight(1f))
            Step("3 Raf", shelf != null, qtyDone && shelf == null, Modifier.weight(1f))
        }

        if (line == null) {
            ProductScanField(vm, "Ürün okutun", "Belgedeki ürünün barkodu ya da listeden seçin", ::onProduct)
            MessageBar(vm.message?.first, vm.message?.second == true)
        } else {
            Card {
                Column {
                    Text(line.product.name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    MonoText(listOfNotNull(line.product.code, line.product.barcode).joinToString(" · "), size = 13, weight = FontWeight.Medium, color = C.Muted)
                }
                Row {
                    Num("Kabul", fmt(line.accepted), modifier = Modifier.weight(1f))
                    Num("Rafta", fmt(line.shelved), modifier = Modifier.weight(1f))
                    Num("Kalan", fmt(line.remaining), color = C.Warn, modifier = Modifier.weight(1f))
                }
            }
            if (!qtyDone) {
                QtyRow(qty, { qty = it }, line.product.unit, line.remaining)
                SecondaryButton("Başka ürün seç", { lineId = null })
            } else {
                QtyDoneRow(qty, line.product.unit) { qtyDone = false; shelf = null }
                if (shelf == null) {
                    ScanField("Raf okutun", suggested?.let { "Önerilen raf: $it" } ?: "Ürün henüz hiçbir rafta yok", true, vm.repo.prefs.cameraButton, ::onShelf, onTextChange = { typed = it })
                    MessageBar(vm.message?.first, vm.message?.second == true)
                    ShelfChoices(vm, line.product.id, rd, typed, ::onShelf)
                } else {
                    ChosenShelf(shelf!!, shelf == suggested, db.qtyAt(line.product.id, shelf!!, rd) > 0) { shelf = null }
                }
            }
        }

        val rest = lines.filter { it.remaining > 0 && it.id != lineId }
        if (rest.isNotEmpty() && !qtyDone) {
            Card(padding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 14.dp, top = 10.dp)) {
                Caption("Sıradaki kalemler (${rest.size})")
                LazyColumn {
                    items(rest, key = { it.id }) { l ->
                        Column(Modifier.focusProperties { canFocus = false }.clickable { pick(l) }) {
                            Divider()
                            Row(Modifier.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(l.product.name, Modifier.weight(1f), fontSize = 14.sp)
                                MonoText("${fmt(l.shelved)} / ${fmt(l.accepted)}", size = 14, weight = FontWeight.Medium, color = C.Muted)
                            }
                        }
                    }
                }
            }
        }
    }

    conflict?.let { (current, scanned) ->
        ShelfConflictDialog(vm, line?.product, current, scanned, rd, { shelf = it; conflict = null }, { conflict = null })
    }
}

/**
 * Belge seçmeden rafa kaldırma (çalışılan depoda): ürün okutuldu → miktar → raf. Miktar açık belgelerden (en eski önce)
 * düşülür; belgede olmayan kısım belgesiz kalkar. En çok: belgede bekleyen + belgesiz (Vega stoku − raflar − belge).
 */
@Composable
fun ProductPutAwayScreen(vm: AppVm, online: Boolean, version: Int, productId: String) {
    val db = vm.repo.db
    val d = db.depot
    val product = remember(version) { db.productById(productId, d) }
    val pending = remember(version) { db.pendingPutAway(productId, d) }
    val free = remember(version) { db.unshelved(productId, d) }
    val onShelves = remember(version) { db.shelvedTotal(productId, d) }
    val elsewhere = remember(version) { db.pendingElsewhere(productId, d) }
    val available = pending + free
    var qty by remember { mutableStateOf(available) }
    var qtyDone by remember { mutableStateOf(false) }
    var shelf by remember { mutableStateOf<String?>(null) }
    var conflict by remember { mutableStateOf<Pair<String, String>?>(null) }
    var typed by remember { mutableStateOf("") }
    val suggested = remember(version) { suggestedShelf(vm, productId, d) }

    fun onShelf(code: String) {
        val s = code.uppercase()
        if (db.findProduct(code) != null) return vm.error("Raf barkodu okutun; bu bir ürün barkodu")
        if (!db.shelfExists(s, d)) return vm.unknownShelf(s, d) { onShelf(it) }
        if (suggested != null && suggested != s) {
            vm.feedback.error()
            conflict = suggested to s
        } else {
            shelf = s
            vm.ok("Raf $s")
        }
    }

    Screen(
        "Rafa Kaldır", sub = db.depotName(d).ifBlank { null }, online = online, onBack = { vm.back() },
        footer = when {
            product == null || available <= 0 -> null
            !qtyDone -> ({
                MessageBar(vm.message?.first, vm.message?.second == true)
                PrimaryButton("Miktarı onayla", { qtyDone = true }, enabled = qty > 0 && qty <= available + 1e-9)
            })
            shelf != null -> ({
                MessageBar(vm.message?.first, vm.message?.second == true)
                PrimaryButton("${fmt(qty)} ${product.unit.lowercase()} $shelf rafına kaldır", {
                    val how = vm.repo.putAwayProduct(product, shelf!!, qty, vm.userName, d)
                    vm.saved("${product.name}: ${fmt(qty)} → $shelf ($how)")
                    vm.back()
                }, enabled = qty > 0)
            })
            else -> null
        },
    ) {
        if (product == null) {
            Notice("Ürün terminalde bulunamadı. Eşitlemeyi bekleyip yeniden okutun.", Tone.Err, icon = Ic.Warning)
            return@Screen
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Step("1 Ürün", true, false, Modifier.weight(1f))
            Step("2 Miktar", qtyDone, !qtyDone, Modifier.weight(1f))
            Step("3 Raf", shelf != null, qtyDone && shelf == null, Modifier.weight(1f))
        }
        Card {
            Column {
                Text(product.name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                MonoText(listOfNotNull(product.code, product.barcode).joinToString(" · "), size = 13, weight = FontWeight.Medium, color = C.Muted)
            }
            Row {
                Num("Belgede", fmt(pending), modifier = Modifier.weight(1f))
                Num("Belgesiz", fmt(free), color = if (free > 0) C.Warn else C.Ink, modifier = Modifier.weight(1f))
                Num("Rafta", fmt(onShelves), modifier = Modifier.weight(1f))
            }
        }
        if (available <= 0) {
            Notice(
                "Bu depoda rafa kaldırılacak stok yok: Vega stoku (${fmt(product.vegaStock)}) raflardakinden fazla değil ve açık belge yok. " +
                    "Vega'da yeni girdiyse birkaç dakika sonra yeniden deneyin; yönetici programında Ürünler › \"Neden terminalde yok?\" nedenini gösterir.",
                Tone.Warn, icon = Ic.Warning,
            )
            elsewhere.forEach { (name, q) -> Hint("$name deposunda açık belgede ${fmt(q)} var; o depoyu seçin ya da belgeden kaldırın.") }
            SecondaryButton("Geri", { vm.back() })
            return@Screen
        }
        if (!qtyDone) {
            QtyRow(qty, { qty = it }, product.unit, available)
            if (free > 0 && qty > pending + 1e-9) Hint("${fmt(qty - maxOf(pending, 0.0))} ${product.unit.lowercase()} belgesiz rafa kalkar (Vega'da stok var, mal kabul belgesi yok).")
            elsewhere.forEach { (name, q) -> Hint("$name deposunda da açık belgede ${fmt(q)} var.") }
        } else {
            QtyDoneRow(qty, product.unit) { qtyDone = false; shelf = null }
            if (shelf == null) {
                ScanField("Raf okutun", suggested?.let { "Önerilen raf: $it" } ?: "Ürün henüz hiçbir rafta yok", true, vm.repo.prefs.cameraButton, ::onShelf, onTextChange = { typed = it })
                MessageBar(vm.message?.first, vm.message?.second == true)
                ShelfChoices(vm, productId, d, typed, ::onShelf)
            } else {
                ChosenShelf(shelf!!, shelf == suggested, db.qtyAt(productId, shelf!!, d) > 0) { shelf = null }
            }
        }
    }

    conflict?.let { (current, scanned) ->
        ShelfConflictDialog(vm, product, current, scanned, d, { shelf = it; conflict = null }, { conflict = null })
    }
}

/**
 * Raf adımında okutmanın yanında dokunulabilir seçenekler: alana bir şey yazılmadıysa ürünün bilinen rafları,
 * yazıldıysa o metne uyan raflar. Dokunuş, rafı okutmakla aynı kontrollerden geçer.
 */
@Composable
private fun ShelfChoices(vm: AppVm, productId: String, d: Int, typed: String, onPick: (String) -> Unit) {
    val db = vm.repo.db
    var refresh by remember { mutableStateOf(0) }
    var removing by remember { mutableStateOf<String?>(null) }
    val known = remember(productId, d, refresh) { db.shelfOptions(productId, d) }
    val homes = remember(productId, d, refresh) { db.homeShelves(productId, d).toSet() }
    val found = remember(typed, d) { if (typed.isBlank()) emptyList() else db.searchShelves(typed, d) }
    Card(padding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 14.dp, top = 10.dp)) {
        Caption(if (typed.isBlank()) "Ürünün rafları" else "Uyan raflar")
        Column {
            if (typed.isBlank()) {
                if (known.isEmpty()) {
                    Hint("Bu ürünün kayıtlı rafı yok. Raf etiketini okutun ya da raf kodunu yazmaya başlayın; uyan raflar burada listelenir.", Modifier.padding(vertical = 10.dp))
                }
                known.take(8).forEach { o ->
                    val note = when (o.kind) {
                        0 -> "rafta ${fmt(o.qty)}"
                        1 -> "asıl raf"
                        else -> "${o.depotName.ifBlank { "başka depo" }}${if (o.qty > 0) " · ${fmt(o.qty)}" else ""}"
                    }
                    ShelfChoiceRow(o.shelf, note, onPick, if (o.shelf in homes) ({ removing = o.shelf }) else null)
                }
            } else {
                if (found.isEmpty()) Hint("\"$typed\" ile başlayan ya da içeren raf yok.", Modifier.padding(vertical = 10.dp))
                found.forEach { ShelfChoiceRow(it, "", onPick) }
            }
        }
    }
    removing?.let { h ->
        val p = db.productById(productId)
        if (p != null) {
            AlertDialog(
                onDismissRequest = { removing = null },
                title = { Text("Raf adresi silinsin mi?") },
                text = { Text("${p.name} ürününün $h raf adresi silinir. Raf ve raftaki miktar değişmez; yönetici programında ve Vega kartında da kalkar.") },
                confirmButton = {
                    TextButton({
                        vm.repo.removeHome(p, h, vm.userName, d)
                        removing = null
                        refresh++
                        vm.saved("${p.code}: $h adresi silindi")
                    }) { Text("Sil", color = C.Err, fontWeight = FontWeight.Bold) }
                },
                dismissButton = { TextButton({ removing = null }) { Text("Vazgeç") } },
            )
        }
    }
}

@Composable
private fun ShelfChoiceRow(shelf: String, note: String, onPick: (String) -> Unit, onRemove: (() -> Unit)? = null) {
    Column(Modifier.focusProperties { canFocus = false }.clickable { onPick(shelf) }) {
        Divider()
        Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            MonoText(shelf, size = 16, weight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (note.isNotBlank()) Hint(note)
            if (onRemove != null) {
                Text(
                    "Sil", color = C.Err, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                    modifier = Modifier.focusProperties { canFocus = false }.clickable { onRemove() }.padding(10.dp),
                )
            } else Box(Modifier.height(36.dp))
        }
    }
}

/** Ürünün durduğu raf, yoksa zimmetli (asıl) rafı. */
private fun suggestedShelf(vm: AppVm, productId: String, d: Int): String? =
    vm.repo.db.locationsOf(productId, d).firstOrNull()?.shelf ?: vm.repo.db.homeShelf(productId, d)

@Composable
fun QtyRow(qty: Double, onChange: (Double) -> Unit, unit: String, max: Double) {
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Miktar", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = C.Text2)
                Hint("$unit · en çok ${fmt(max)}")
            }
            QtyStepper(qty, onChange, max = max)
        }
    }
}

@Composable
fun QtyDoneRow(qty: Double, unit: String, onEdit: () -> Unit) {
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Miktar", fontSize = 12.sp, color = C.Muted)
                Text("${fmt(qty)} ${unit.lowercase()}", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            }
            Text("Değiştir", color = C.Info, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.focusProperties { canFocus = false }.clickable(onClick = onEdit).padding(8.dp))
        }
    }
}

@Composable
private fun ChosenShelf(shelf: String, isSuggested: Boolean, productHere: Boolean, onChange: () -> Unit) {
    Card(bg = C.OkBg, border = C.Ok, borderWidth = 1.5.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Ic.Check, null, tint = C.Ok, modifier = Modifier.size(22.dp))
            Column(Modifier.weight(1f)) {
                MonoText(shelf, size = 20)
                Text(if (isSuggested) (if (productHere) "Önerilen raf · ürün zaten burada" else "Önerilen raf · ürünün asıl rafı") else "Okutulan raf", fontSize = 12.sp, color = C.OkText)
            }
            Text("Değiştir", color = C.Info, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.focusProperties { canFocus = false }.clickable(onClick = onChange).padding(8.dp))
        }
    }
}

@Composable
private fun ShelfConflictDialog(vm: AppVm, product: Product?, current: String, scanned: String, d: Int, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.clip(RoundedCornerShape(20.dp)).background(C.Surface).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.size(48.dp).clip(RoundedCornerShape(12.dp)).background(C.WarnBg), contentAlignment = Alignment.Center) {
                    Icon(Ic.Warning, null, tint = C.Warn, modifier = Modifier.size(28.dp))
                }
                Text("Bu ürün başka rafta duruyor", fontSize = 18.sp, fontWeight = FontWeight.Bold)
            }
            val here = product?.let { vm.repo.db.qtyAt(it.id, current, d) } ?: 0.0
            Text(
                if (here > 0) "${product?.name} şu an $current rafında (${fmt(here)} ${product?.unit?.lowercase()}). Okuttuğunuz raf farklı."
                else "${product?.name} ürününün asıl rafı $current. Okuttuğunuz raf farklı.",
                color = C.Text2,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ShelfBox("Önerilen raf", current, false, Modifier.weight(1f))
                ShelfBox("Okutulan raf", scanned, true, Modifier.weight(1f))
            }
            PrimaryButton("$current rafına koy (önerilen)", { onPick(current) })
            SecondaryButton("Yine de $scanned rafına koy", { onPick(scanned) })
            Text(
                "Vazgeç", Modifier.fillMaxWidth().clickable(onClick = onDismiss).padding(12.dp),
                textAlign = TextAlign.Center, fontWeight = FontWeight.SemiBold, color = C.Text2,
            )
        }
    }
}

@Composable
private fun ShelfBox(label: String, code: String, warn: Boolean, modifier: Modifier) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier.clip(shape).background(if (warn) C.WarnBg else C.Ground).border(1.5.dp, if (warn) C.Warn else C.Ground, shape).padding(10.dp),
    ) {
        Text(label, fontSize = 12.sp, color = if (warn) C.WarnText else C.Muted)
        MonoText(code, size = 18)
    }
}

@Composable
fun Step(text: String, done: Boolean, current: Boolean, modifier: Modifier) {
    val bg = when {
        current -> C.Bar
        done -> C.OkBg
        else -> C.LineSoft
    }
    val fg = when {
        current -> C.Accent
        done -> C.OkText
        else -> C.Muted
    }
    Box(modifier.height(32.dp).clip(RoundedCornerShape(16.dp)).background(bg), contentAlignment = Alignment.Center) {
        Text(if (done) "$text ✓" else text, color = fg, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
    }
}
