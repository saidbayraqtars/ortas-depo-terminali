package tr.arcteknik.depo.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
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
import tr.arcteknik.depo.data.Product
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.BasketBox
import tr.arcteknik.depo.ui.BasketLink
import tr.arcteknik.depo.ui.BasketRow
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.CartLine
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.bump
import tr.arcteknik.depo.ui.cartQty
import tr.arcteknik.depo.ui.undo

/**
 * Raftan alma (sepet mantığı, çalışılan depoda): ürünler peş peşe okutulur (her okutma +1, adet sorulmaz), "Raftan al"
 * hepsini işler. Raf okutulursa ürünler o raftan alınır (raf başka raf okutulana ya da temizlenene kadar sürer); okutulmazsa
 * her ürün için raf kendiliğinden seçilir (önce sepette olan raf, sonra asıl raf / en çok stoklu). Raf stoku azalır;
 * Vega'daki çıkış (fatura, sevk) ayrıca Vega'da yapılır. Raftaki miktar aşılırsa okutma engellenmez: sesli ve görüntülü
 * uyarı verilir, işlem sonunda ayrıca uyarılır (raf sıfırda kesilir).
 */
@Composable
fun PickScreen(vm: AppVm, online: Boolean, version: Int) {
    val db = vm.repo.db
    var shelf by remember { mutableStateOf<String?>(null) }
    val cart = remember { mutableStateListOf<CartLine>() }
    var tick by remember { mutableStateOf(0) }
    var confirm by remember { mutableStateOf(false) }
    var leaveAsk by remember { mutableStateOf(false) }

    fun onProduct(p: Product) {
        val stocks = sendStocks(db, p.id, db.depot)
        if (stocks.isEmpty()) return vm.error("${p.name} bu depoda hiçbir rafta görünmüyor")
        val current = shelf
        val target = if (current != null) {
            if (db.qtyAt(p.id, current) <= 1e-9) return vm.error("${p.name} $current rafında görünmüyor")
            current
        } else {
            // Raf okutulmadı: sepette olup boş stoğu kalan raf, sonra stok sırasındaki boş stoklu raf, o da yoksa ilk raf.
            stocks.firstOrNull { cart.cartQty(p.id, it.shelf) > 1e-9 && it.qty - cart.cartQty(p.id, it.shelf) > 1e-9 }?.shelf
                ?: stocks.firstOrNull { it.qty - cart.cartQty(p.id, it.shelf) > 1e-9 }?.shelf
                ?: stocks.first().shelf
        }
        val here = db.qtyAt(p.id, target)
        val n = cart.bump(p.id, target)
        tick++
        if (n - here > 1e-9) vm.error("${p.name}: $target rafında ${fmt(here)} var, ${fmt(n)} okutuldu")
        else vm.ok("${p.name} · $target · ${fmt(n)}")
    }

    /** Raf barkodu okunan raf olur; tanımsız raf kodu uyarı verir, başka kod ürün hatasına düşer. */
    fun onShelf(code: String): Boolean {
        val s = code.trim().uppercase()
        if (db.shelfExists(s)) {
            shelf = s
            vm.ok("Raf $s")
            return true
        }
        return false
    }

    fun commit() {
        val n = cart.size
        val total = cart.sumOf { it.qty }
        cart.toList().forEach { c -> db.productById(c.productId)?.let { vm.repo.pick(it, c.shelf, c.qty, vm.userName) } }
        cart.clear()
        vm.saved("Raftan alındı · $n kalem · ${fmt(total)} adet")
    }

    val over = cart.filter { it.qty - db.qtyAt(it.productId, it.shelf) > 1e-9 }
    BackHandler(enabled = cart.isNotEmpty()) { leaveAsk = true }
    Screen(
        "Raftan Al", sub = db.depotName(db.depot).ifBlank { null }, online = online,
        onBack = { if (cart.isNotEmpty()) leaveAsk = true else vm.back() }, scroll = false,
        footer = if (cart.isNotEmpty()) ({
            PrimaryButton("Raftan al · ${cart.size} kalem · ${fmt(cart.sumOf { it.qty })} adet", {
                if (over.isEmpty()) commit() else confirm = true
            })
        }) else null,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ProductScanField(
                vm, "Ürün okutun",
                if (shelf == null) "Raf: otomatik" else "Raf: $shelf",
                ::onProduct, onOther = ::onShelf, showSearchLink = false,
            )
            MessageBar(vm.message?.takeIf { it.second }?.first, true)
            val rows = cart.asReversed().map { c ->
                val p = db.productById(c.productId)
                val here = db.qtyAt(c.productId, c.shelf)
                BasketRow(
                    key = c.productId + "|" + c.shelf, name = p?.name ?: c.productId,
                    detail = listOfNotNull(p?.code, c.shelf, "rafta ${fmt(here)}").joinToString(" · "),
                    count = fmt(c.qty), countColor = if (c.qty - here > 1e-9) C.Err else C.Ink,
                    highlight = if (c === cart.last()) C.AccentBg else Color.Transparent,
                    onUndo = { cart.undo(c.productId, c.shelf) },
                )
            }
            BasketBox(
                rows, scrollKey = tick,
                emptyHint = "Ürünleri peş peşe okutun; okutulanlar burada listelenir. Belli bir raftan alıyorsanız önce rafı okutun.",
                modifier = Modifier.weight(1f),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Caption(
                        if (shelf == null) "Raf otomatik" else "Raf $shelf",
                        Modifier.weight(1f),
                    )
                    if (shelf != null) BasketLink("Otomatik") { shelf = null }
                    if (cart.isNotEmpty()) BasketLink("Sıfırla", C.Err) { cart.clear() }
                }
            }
        }
    }

    if (leaveAsk) {
        AlertDialog(
            onDismissRequest = { leaveAsk = false },
            title = { Text("Okutulanlar raftan alınsın mı?") },
            text = { Text("${cart.size} kalem okutuldu, henüz raftan alınmadı.") },
            confirmButton = {
                TextButton({ leaveAsk = false; commit(); vm.back() }, Modifier.focusProperties { canFocus = false }) { Text("Raftan al", fontWeight = FontWeight.Bold) }
            },
            dismissButton = {
                Row {
                    TextButton({ leaveAsk = false }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") }
                    TextButton({ leaveAsk = false; cart.clear(); vm.back() }, Modifier.focusProperties { canFocus = false }) { Text("Atıp çık", color = C.Err) }
                }
            },
        )
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Raftaki miktardan fazla var, yine de alınsın mı?") },
            text = {
                Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${over.size} satırda raftaki miktardan fazla okutuldu:", fontWeight = FontWeight.SemiBold, color = C.Err)
                    over.forEach { c ->
                        val p = db.productById(c.productId)
                        Text("• ${p?.name ?: c.productId} · ${p?.code ?: ""} ${c.shelf} ${fmt(c.qty)}/${fmt(db.qtyAt(c.productId, c.shelf))}", fontSize = 14.sp, color = C.Err)
                    }
                    Text("Raf sıfırda kesilir; raf kaydı mal fiziken az ya da fazlaysa sayımla düzeltilir.", fontSize = 13.sp, color = C.Muted, modifier = Modifier.padding(top = 4.dp))
                }
            },
            confirmButton = {
                TextButton({ confirm = false; commit() }, Modifier.focusProperties { canFocus = false }) { Text("Yine de al", fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton({ confirm = false }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") } },
        )
    }
}
