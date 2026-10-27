package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.ScanField
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton

/**
 * Raftan alma (çalışılan depoda): ürün okut → miktar → raf okut ya da listeden seç. Raf stoku azalır; Vega'daki
 * çıkış (fatura, sevk) ayrıca Vega'da yapılır. Seçilen rafta yeterli miktar olmalı.
 */
@Composable
fun PickScreen(vm: AppVm, online: Boolean, version: Int) {
    val db = vm.repo.db
    var productId by remember { mutableStateOf<String?>(null) }
    var qty by remember { mutableStateOf(1.0) }
    var qtyDone by remember { mutableStateOf(false) }
    var shelf by remember { mutableStateOf<String?>(null) }

    val product = remember(version, productId) { productId?.let { db.productById(it) } }
    val locations = remember(version, productId) { productId?.let { db.locationsOf(it) } ?: emptyList() }
    val total = locations.sumOf { it.qty }

    fun reset() {
        productId = null; qty = 1.0; qtyDone = false; shelf = null
    }

    fun onShelf(code: String) {
        val s = code.uppercase()
        val p = product ?: return
        if (db.findProduct(code) != null) return vm.error("Raf barkodu okutun; bu bir ürün barkodu")
        val here = db.qtyAt(p.id, s)
        when {
            !db.shelfExists(s) -> vm.error("\"$s\" tanımlı bir raf değil")
            here <= 0 -> vm.error("${p.name} $s rafında görünmüyor")
            here + 1e-9 < qty -> vm.error("$s rafında yalnız ${fmt(here)} ${p.unit.lowercase()} var")
            else -> { shelf = s; vm.ok("Raf $s") }
        }
    }

    Screen(
        "Raftan Al", sub = db.depotName(db.depot).ifBlank { null }, online = online, onBack = { vm.back() },
        footer = when {
            product != null && !qtyDone -> ({
                MessageBar(vm.message?.first, vm.message?.second == true)
                PrimaryButton("Miktarı onayla", { qtyDone = true }, enabled = qty > 0 && qty <= total + 1e-9)
            })
            product != null && shelf != null -> ({
                MessageBar(vm.message?.first, vm.message?.second == true)
                PrimaryButton("${fmt(qty)} ${product.unit.lowercase()} $shelf rafından al", {
                    vm.repo.pick(product, shelf!!, qty, vm.userName)
                    vm.saved("${product.name}: ${fmt(qty)} ${product.unit.lowercase()} $shelf rafından alındı")
                    reset()
                }, enabled = qty > 0)
            })
            else -> null
        },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Step("1 Ürün", product != null, product == null, Modifier.weight(1f))
            Step("2 Miktar", qtyDone, product != null && !qtyDone, Modifier.weight(1f))
            Step("3 Raf", shelf != null, qtyDone && shelf == null, Modifier.weight(1f))
        }
        if (product == null) {
            ProductScanField(vm, "Ürün okutun", "Raftan alınacak ürünün barkodu ya da listeden seçin", { p ->
                if (db.shelvedTotal(p.id) <= 0) vm.error("${p.name} bu depoda hiçbir rafta görünmüyor")
                else { productId = p.id; qty = 1.0; vm.ok(p.name) }
            })
            MessageBar(vm.message?.first, vm.message?.second == true)
            return@Screen
        }
        Card {
            Column {
                Text(product.name, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                MonoText(listOfNotNull(product.code, product.barcode).joinToString(" · "), size = 13, weight = FontWeight.Medium, color = C.Muted)
            }
            Hint("Raflarda toplam ${fmt(total)} ${product.unit.lowercase()}, ${locations.size} raf")
        }
        if (!qtyDone) {
            QtyRow(qty, { qty = it }, product.unit, total)
            SecondaryButton("Başka ürün seç", { reset() })
        } else {
            QtyDoneRow(qty, product.unit) { qtyDone = false; shelf = null }
            if (shelf == null) {
                ScanField("Raf okutun", "Ya da aşağıdan seçin", true, vm.repo.prefs.cameraButton, ::onShelf)
                MessageBar(vm.message?.first, vm.message?.second == true)
                Card(padding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 14.dp, top = 10.dp)) {
                    Caption("Bulunduğu raflar")
                    locations.forEach { l ->
                        val enough = l.qty + 1e-9 >= qty
                        Column(Modifier.focusProperties { canFocus = false }.clickable(enabled = enough) { onShelf(l.shelf) }) {
                            Divider()
                            Row(Modifier.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                MonoText(l.shelf, size = 16, color = if (enough) C.Ink else C.Muted, modifier = Modifier.weight(1f))
                                Text("${fmt(l.qty)} ${product.unit.lowercase()}", fontWeight = FontWeight.SemiBold, color = if (enough) C.Ink else C.Muted)
                            }
                        }
                    }
                }
            } else {
                Card(bg = C.OkBg, border = C.Ok, borderWidth = 1.5.dp) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(Ic.Check, null, tint = C.Ok, modifier = Modifier.size(22.dp))
                        Column(Modifier.weight(1f)) {
                            MonoText(shelf!!, size = 20)
                            Text("Rafta ${fmt(db.qtyAt(product.id, shelf!!))}, alındıktan sonra ${fmt(db.qtyAt(product.id, shelf!!) - qty)}", fontSize = 12.sp, color = C.OkText)
                        }
                        Text("Değiştir", color = C.Info, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.focusProperties { canFocus = false }.clickable { shelf = null }.padding(8.dp))
                    }
                }
            }
        }
    }
}
