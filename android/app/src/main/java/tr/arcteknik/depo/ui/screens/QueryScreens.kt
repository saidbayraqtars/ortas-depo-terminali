package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import tr.arcteknik.depo.data.Product
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.Divider
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.Ic
import tr.arcteknik.depo.ui.LabelDialog
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.ScanField
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton
import java.text.SimpleDateFormat
import java.util.Locale

private val CardPad = PaddingValues(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 2.dp)

@Composable
fun ProductQueryScreen(vm: AppVm, online: Boolean, version: Int, initial: String?) {
    val db = vm.repo.db
    var productId by remember { mutableStateOf(initial?.let { db.findProduct(it)?.id }) }
    val product = remember(version, productId) { productId?.let { db.productById(it) } }
    val locs = remember(version, productId) { productId?.let { db.locationsOf(it) }.orEmpty() }
    val moves = remember(version, productId) { productId?.let { db.movements(it) }.orEmpty() }

    var label by remember { mutableStateOf(false) }
    Screen("Ürün Sorgu", online = online, onBack = { vm.back() }, footer = product?.let { p ->
        {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Etiket bas", { label = true }, Modifier.weight(1f), icon = Ic.Barcode)
                SecondaryButton("Transfer", { vm.go(Route.Transfer(p.id, locs.firstOrNull()?.shelf)) }, Modifier.weight(1f), icon = Ic.Transfer)
            }
        }
    }) {
        if (label && product != null) {
            LabelDialog("Ürün etiketi", product.name, { n -> label = false; vm.printLabel("PRODUCT", product.id, n) }, { label = false })
        }
        ProductScanField(
            vm, "Ürün okutun", product?.let { "Son okunan: ${it.code}" } ?: "Barkod ya da ürün kodu",
            onProduct = { productId = it.id; vm.feedback.ok() },
            onOther = { code -> db.shelfExists(code).also { if (it) vm.replace(Route.ShelfQuery(code.uppercase())) } },
        )
        MessageBar(vm.message?.first, vm.message?.second == true)
        if (product == null) {
            Hint("Ürünün barkodunu okutun ya da isimle arayın. Hangi rafta kaç adet olduğu ve son hareketleri görünür.")
            return@Screen
        }
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ProductCard(product, locs.sumOf { it.qty }, remember(version, productId) { db.pendingPutAway(product.id) })
            Card(padding = CardPad) {
                Caption("Raf dağılımı")
                if (locs.isEmpty()) Hint("Bu ürün hiçbir rafta görünmüyor.", Modifier.padding(bottom = 10.dp))
                val max = locs.maxOfOrNull { it.qty } ?: 1.0
                locs.forEach { l ->
                    Divider()
                    Row(Modifier.fillMaxWidth().clickable { vm.go(Route.ShelfQuery(l.shelf)) }.padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                        MonoText(l.shelf, modifier = Modifier.width(92.dp))
                        Box(Modifier.weight(1f).padding(end = 10.dp)) {
                            Box(Modifier.fillMaxWidth((l.qty / max).toFloat().coerceIn(0.04f, 1f)).height(6.dp).clip(RoundedCornerShape(3.dp)).background(C.Bar))
                        }
                        MonoText(fmt(l.qty), modifier = Modifier.width(48.dp))
                    }
                }
            }
            if (moves.isNotEmpty()) {
                Card(padding = CardPad) {
                    Caption("Son hareketler (bu cihaz)")
                    val f = SimpleDateFormat("dd.MM HH:mm", Locale("tr"))
                    moves.forEach { m ->
                        Divider()
                        Row(Modifier.padding(vertical = 7.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            MonoText(f.format(m.ts), size = 13, weight = FontWeight.Medium, color = C.Muted)
                            Text(m.text, Modifier.weight(1f), fontSize = 13.sp)
                            MonoText((if (m.qty > 0) "+" else "") + fmt(m.qty), size = 13, color = if (m.qty >= 0) C.Ok else C.Warn)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ProductCard(p: Product, onShelves: Double, pending: Double) {
    Card {
        Column {
            Text(p.name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            MonoText(listOfNotNull(p.code, p.unit).joinToString(" · "), size = 13, weight = FontWeight.Medium, color = C.Muted)
        }
        // Vega stoku kabul edilip henüz rafa kaldırılmamış malı da içerir; o kısım fark sayılmaz.
        val diff = onShelves + pending - p.vegaStock
        val equal = Math.abs(diff) < 0.0001
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(if (equal) C.OkBg else C.WarnBg).padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Vega stoku ${fmt(p.vegaStock)} · raflarda ${fmt(onShelves)}", fontSize = 13.sp, color = if (equal) C.OkText else C.WarnText)
                Text(if (equal) "Eşit ✓" else "Fark ${if (diff > 0) "+" else ""}${fmt(diff)}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = if (equal) C.OkText else C.WarnText)
            }
            if (pending > 0) Text("Rafa kaldırılmayı bekleyen ${fmt(pending)}", fontSize = 12.sp, color = if (equal) C.OkText else C.WarnText)
        }
    }
}

@Composable
fun ShelfQueryScreen(vm: AppVm, online: Boolean, version: Int, initial: String?) {
    val db = vm.repo.db
    var shelf by remember { mutableStateOf(initial) }
    var shelfLabel by remember { mutableStateOf(false) }
    val items = remember(version, shelf) { shelf?.let { db.shelfContents(it) }.orEmpty() }

    Screen("Raf Sorgu", sub = shelf, online = online, onBack = { vm.back() }) {
        ScanField("Raf okutun", shelf?.let { "Son okunan: $it" } ?: "Raf etiketindeki barkod", true, vm.repo.prefs.cameraButton, { code ->
            val s = code.uppercase()
            when {
                db.shelfExists(s) -> { shelf = s; vm.feedback.ok() }
                db.findProduct(code) != null -> vm.replace(Route.ProductQuery(code))
                else -> vm.error("\"$s\" tanımlı bir raf değil")
            }
        })
        MessageBar(vm.message?.first, vm.message?.second == true)
        if (shelf == null) return@Screen
        Card(padding = CardPad) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Caption("$shelf rafında ${items.size} ürün")
                Caption("Miktar")
            }
            if (items.isEmpty()) Hint("Raf boş.", Modifier.padding(bottom = 10.dp))
            Column(Modifier.verticalScroll(rememberScrollState())) {
                items.forEach { l ->
                    Divider()
                    Row(
                        Modifier.fillMaxWidth().clickable { vm.go(Route.ProductQuery(l.product.code)) }.padding(vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(l.product.name, fontWeight = FontWeight.SemiBold)
                            MonoText(l.product.code, size = 12, weight = FontWeight.Medium, color = C.Muted)
                        }
                        MonoText(fmt(l.qty), size = 17, modifier = Modifier.width(56.dp))
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton("Raf etiketi bas", { shelfLabel = true }, Modifier.weight(1f), icon = Ic.Barcode)
            SecondaryButton("Transfer başlat", { vm.go(Route.Transfer(from = shelf)) }, Modifier.weight(1f), icon = Ic.Transfer)
        }
        if (shelfLabel) {
            LabelDialog("Raf etiketi", shelf!!, { n -> shelfLabel = false; vm.printLabel("SHELF", shelf!!, n) }, { shelfLabel = false })
        }
    }
}
