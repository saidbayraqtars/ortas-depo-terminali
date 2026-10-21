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
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import tr.arcteknik.depo.data.Product
import tr.arcteknik.depo.data.ReceiptLine
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.Divider
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.Ic
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.Num
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.QtyStepper
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.ScanField
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton

@Composable
fun ReceiptListScreen(vm: AppVm, online: Boolean, version: Int) {
    var open by remember { mutableStateOf(true) }
    val receipts = remember(version, open) { vm.repo.db.receipts(open) }
    val openCount = remember(version) { vm.repo.db.receipts(true).size }

    Screen("Rafa Kaldır", online = online, onBack = { vm.back() }) {
        ScanField(
            title = "Belge okutun",
            hint = "İrsaliye barkodu ya da numarası",
            active = true,
            cameraButton = vm.repo.prefs.cameraButton,
            onScan = { code ->
                val r = vm.repo.db.receipts(true).firstOrNull { it.docNo.equals(code, true) || it.id == code }
                if (r != null) vm.go(Route.PutAway(r.id)) else vm.error("Bekleyen belgelerde \"$code\" yok")
            },
        )
        MessageBar(vm.message?.first, vm.message?.second == true)
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.LineSoft).padding(4.dp)) {
            Segment("Bekleyen ($openCount)", open, Modifier.weight(1f)) { open = true }
            Segment("Tamamlanan", !open, Modifier.weight(1f)) { open = false }
        }
        Hint("Vega'da mal kabulü yapılmış belgeler")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(receipts, key = { it.id }) { r ->
                Card(onClick = { vm.go(Route.PutAway(r.id)) }) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        MonoText(r.docNo)
                        Hint(r.date)
                    }
                    Text(r.supplier, fontWeight = FontWeight.SemiBold)
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
        if (receipts.isEmpty()) Hint(if (open) "Rafa kaldırılmayı bekleyen belge yok." else "Tamamlanan belge yok.")
    }
}

@Composable
private fun Segment(text: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier.height(40.dp).clip(RoundedCornerShape(8.dp)).background(if (selected) C.Surface else C.LineSoft).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(text, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium, color = if (selected) C.Ink else C.Muted, fontSize = 14.sp) }
}

/** Ürün okut → raf okut → miktar onayla. */
@Composable
fun PutAwayScreen(vm: AppVm, online: Boolean, version: Int, receiptId: String) {
    val db = vm.repo.db
    val receipt = remember(version) { db.receipt(receiptId) }
    val lines = remember(version) { db.receiptLines(receiptId) }
    var lineId by remember { mutableStateOf<String?>(null) }
    var shelf by remember { mutableStateOf<String?>(null) }
    var qty by remember { mutableStateOf(0.0) }
    var conflict by remember { mutableStateOf<Pair<String, String>?>(null) }

    val line = lines.firstOrNull { it.id == lineId }
    val suggested = remember(version, line?.product?.id) { line?.let { db.locationsOf(it.product.id).firstOrNull()?.shelf } }

    fun pick(l: ReceiptLine) {
        if (l.remaining <= 0) {
            vm.error("${l.product.name} bu belgede tamamlandı")
            return
        }
        lineId = l.id; shelf = null; qty = l.remaining
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
        if (!db.shelfExists(s)) return vm.error("\"$s\" tanımlı bir raf değil")
        if (suggested != null && suggested != s) {
            vm.feedback.error()
            conflict = suggested to s
        } else {
            shelf = s
            vm.ok("Raf $s")
        }
    }

    Screen(
        receipt?.docNo ?: "Belge", sub = receipt?.let { "${it.supplier} · ${it.doneLines} / ${it.lineCount}" },
        online = online, onBack = { vm.back() }, monoTitle = true,
        footer = if (line != null && shelf != null) ({
            MessageBar(vm.message?.first, vm.message?.second == true)
            PrimaryButton("${fmt(qty)} ${line.product.unit.lowercase()} $shelf rafına kaldır", {
                vm.repo.putAway(line, shelf!!, qty, vm.userName)
                val left = db.receiptLines(receiptId).count { it.remaining > 0 }
                lineId = null; shelf = null
                vm.saved(if (left == 0) "Belge tamamlandı" else "Rafa kaldırıldı · $left kalem kaldı")
                if (left == 0) vm.back()
            }, enabled = qty > 0)
        }) else null,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Step("1 Ürün", line != null, line == null, Modifier.weight(1f))
            Step("2 Raf", shelf != null, line != null && shelf == null, Modifier.weight(1f))
            Step("3 Miktar", false, shelf != null, Modifier.weight(1f))
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
            if (shelf == null) {
                ScanField("Raf okutun", suggested?.let { "Önerilen raf: $it" } ?: "Ürün henüz hiçbir rafta yok", true, vm.repo.prefs.cameraButton, ::onShelf)
                MessageBar(vm.message?.first, vm.message?.second == true)
                SecondaryButton("Başka ürün seç", { lineId = null })
            } else {
                Card(bg = C.OkBg, border = C.Ok, borderWidth = 1.5.dp) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(Ic.Check, null, tint = C.Ok, modifier = Modifier.size(22.dp))
                        Column(Modifier.weight(1f)) {
                            MonoText(shelf!!, size = 20)
                            Text(if (shelf == suggested) "Önerilen raf · ürün zaten burada" else "Okutulan raf", fontSize = 12.sp, color = C.OkText)
                        }
                        Text("Değiştir", color = C.Info, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.clickable { shelf = null }.padding(8.dp))
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Miktar", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = C.Text2)
                        Hint("${line.product.unit} · en çok ${fmt(line.remaining)}")
                    }
                    QtyStepper(qty, { qty = it }, max = line.remaining)
                }
            }
        }

        val rest = lines.filter { it.remaining > 0 && it.id != lineId }
        if (rest.isNotEmpty()) {
            Card(padding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 14.dp, top = 10.dp)) {
                Caption("Sıradaki kalemler (${rest.size})")
                LazyColumn {
                    items(rest, key = { it.id }) { l ->
                        Column(Modifier.clickable { pick(l) }) {
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
        Dialog(onDismissRequest = { conflict = null }) {
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
                val here = line?.let { db.qtyAt(it.product.id, current) } ?: 0.0
                Text("${line?.product?.name} şu an $current rafında (${fmt(here)} ${line?.product?.unit?.lowercase()}). Okuttuğunuz raf farklı.", color = C.Text2)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ShelfBox("Mevcut raf", current, false, Modifier.weight(1f))
                    ShelfBox("Okutulan raf", scanned, true, Modifier.weight(1f))
                }
                PrimaryButton("$current rafına koy (önerilen)", { shelf = current; conflict = null })
                SecondaryButton("Yine de $scanned rafına koy", { shelf = scanned; conflict = null })
                Text(
                    "Vazgeç", Modifier.fillMaxWidth().clickable { conflict = null }.padding(12.dp),
                    textAlign = TextAlign.Center, fontWeight = FontWeight.SemiBold, color = C.Text2,
                )
            }
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
