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
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.bump
import tr.arcteknik.depo.ui.cartQty
import tr.arcteknik.depo.ui.undo

/**
 * Raf transferi (sepet mantığı): kaynak raf okutulur, ürünler peş peşe okutulur (her okutma +1, adet sorulmaz), hedef raf
 * okutulunca onaydan sonra hepsi taşınır. Raftaki miktar aşılırsa okutma engellenmez: sesli ve görüntülü uyarı verilir,
 * onay penceresinde ayrıca uyarılır (kaynak raf sıfırda kesilir, hedefe okutulan adet girer).
 */
@Composable
fun TransferScreen(vm: AppVm, online: Boolean, version: Int, initialProduct: String?, initialFrom: String?) {
    val db = vm.repo.db
    var from by remember { mutableStateOf(initialFrom?.uppercase()) }
    val cart = remember {
        mutableStateListOf<CartLine>().also { c ->
            // Ürün sorgudan "Transfer" ile gelindiyse ürünün o raftaki tamamı sepete konur; azaltmak için − kullanılır.
            if (initialProduct != null && initialFrom != null) {
                val q = db.qtyAt(initialProduct, initialFrom)
                if (q > 0) c.add(CartLine(initialProduct, initialFrom.uppercase(), q))
            }
        }
    }
    var tick by remember { mutableStateOf(0) }
    var toShelf by remember { mutableStateOf<String?>(null) }
    var leaveAsk by remember { mutableStateOf(false) }

    fun onProduct(p: Product) {
        val f = from ?: return vm.error("Önce kaynak rafı okutun")
        val here = db.qtyAt(p.id, f)
        if (here <= 1e-9) return vm.error("${p.name} $f rafında görünmüyor")
        val n = cart.bump(p.id, f)
        tick++
        if (n - here > 1e-9) vm.error("${p.name}: $f rafında ${fmt(here)} var, ${fmt(n)} okutuldu")
        else vm.ok("${p.name} · ${fmt(n)}")
    }

    /** Raf barkodu: kaynak yoksa kaynak, sepet boşken kaynak değişir, sepet doluyken hedeftir (onaylanır). */
    fun onShelf(code: String): Boolean {
        val s = code.trim().uppercase()
        if (!db.shelfExists(s)) {
            if (from == null || cart.isEmpty()) return false
            // Sepet dolu: tanımsız raf hedef olarak eklenebilir.
            vm.unknownShelf(s) { toShelf = it }
            return true
        }
        when {
            from == null || cart.isEmpty() -> { from = s; vm.ok("Kaynak raf $s") }
            s == from -> vm.error("Hedef raf kaynakla aynı olamaz")
            else -> { vm.feedback.ok(); toShelf = s }
        }
        return true
    }

    BackHandler(enabled = cart.isNotEmpty()) { leaveAsk = true }
    Screen(
        "Raf Transferi", sub = from?.let { "Kaynak $it" }, online = online,
        onBack = { if (cart.isNotEmpty()) leaveAsk = true else vm.back() }, scroll = false,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ProductScanField(
                vm, if (from == null) "Raf okutun" else "Ürün okutun",
                when {
                    from == null -> "Önce kaynak raf"
                    cart.isEmpty() -> "Kaynak $from"
                    else -> "Sonra hedef raf okutun"
                },
                ::onProduct, onOther = ::onShelf, showSearchLink = false,
            )
            MessageBar(vm.message?.takeIf { it.second }?.first, true)
            val rows = cart.asReversed().map { c ->
                val p = db.productById(c.productId)
                val here = db.qtyAt(c.productId, c.shelf)
                BasketRow(
                    key = c.productId, name = p?.name ?: c.productId,
                    detail = listOfNotNull(p?.code, "rafta ${fmt(here)}").joinToString(" · "),
                    count = fmt(c.qty), countColor = if (c.qty - here > 1e-9) C.Err else C.Ink,
                    highlight = if (c === cart.last()) C.AccentBg else Color.Transparent,
                    onUndo = { cart.undo(c.productId, c.shelf) },
                )
            }
            BasketBox(
                rows, scrollKey = tick,
                emptyHint = if (from == null) "Önce ürünlerin durduğu rafı okutun; sonra ürünleri peş peşe, en sonda hedef rafı okutun." else "Ürünleri peş peşe okutun; okutulanlar burada listelenir. Sonra hedef rafı okutun.",
                modifier = Modifier.weight(1f),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Caption(if (from == null) "Kaynak raf yok" else "$from · ${fmt(cart.sumOf { it.qty })} adet", Modifier.weight(1f))
                    if (cart.isNotEmpty()) BasketLink("Sıfırla", C.Err) { cart.clear() }
                    else if (from != null) BasketLink("Rafı sıfırla") { from = null }
                }
            }
        }
    }

    if (leaveAsk) {
        AlertDialog(
            onDismissRequest = { leaveAsk = false },
            title = { Text("Okutulanlar atılsın mı?") },
            text = { Text("${cart.size} kalem okutuldu, henüz taşınmadı.") },
            confirmButton = { TextButton({ leaveAsk = false; cart.clear(); vm.back() }, Modifier.focusProperties { canFocus = false }) { Text("Atıp çık", color = C.Err, fontWeight = FontWeight.Bold) } },
            dismissButton = { TextButton({ leaveAsk = false }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") } },
        )
    }
    toShelf?.let { t ->
        val f = from
        if (f != null) {
            val over = cart.filter { it.qty - db.qtyAt(it.productId, f) > 1e-9 }
            AlertDialog(
                onDismissRequest = { toShelf = null },
                title = { Text("${cart.size} kalem taşınsın mı?") },
                text = {
                    Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            MonoText(f, size = 16)
                            Text("→")
                            MonoText(t, size = 16)
                        }
                        Text("Toplam ${fmt(cart.sumOf { it.qty })} adet.")
                        if (over.isNotEmpty()) {
                            Text("${over.size} kalemde kaynak raftaki miktardan fazla okutuldu:", fontWeight = FontWeight.SemiBold, color = C.Err, modifier = Modifier.padding(top = 6.dp))
                            over.forEach { c ->
                                val p = db.productById(c.productId)
                                Text("• ${p?.name ?: c.productId} · ${p?.code ?: ""} ${fmt(c.qty)}/${fmt(db.qtyAt(c.productId, f))}", fontSize = 14.sp, color = C.Err)
                            }
                            Text("Kaynak raf sıfırda kesilir; okutulan adedin tamamı hedef rafa girer.", fontSize = 13.sp, color = C.Muted)
                        }
                    }
                },
                confirmButton = {
                    TextButton({
                        val n = cart.size
                        val total = cart.sumOf { it.qty }
                        cart.toList().forEach { c -> db.productById(c.productId)?.let { vm.repo.transfer(it, f, t, c.qty, vm.userName) } }
                        vm.saved("$n kalem · ${fmt(total)} adet $f → $t taşındı")
                        cart.clear(); from = null; toShelf = null
                    }, Modifier.focusProperties { canFocus = false }) { Text("Taşı", fontWeight = FontWeight.Bold) }
                },
                dismissButton = { TextButton({ toShelf = null }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") } },
            )
        }
    }
}
