package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.QtyStepper
import tr.arcteknik.depo.ui.ScanField
import tr.arcteknik.depo.ui.Screen

/** Kaynak raf → ürün → miktar → hedef raf. */
@Composable
fun TransferScreen(vm: AppVm, online: Boolean, version: Int, initialProduct: String?, initialFrom: String?) {
    val db = vm.repo.db
    var from by remember { mutableStateOf(initialFrom) }
    var productId by remember { mutableStateOf(initialProduct?.takeIf { p -> initialFrom != null && db.qtyAt(p, initialFrom) > 0 }) }
    var qty by remember { mutableStateOf(productId?.let { db.qtyAt(it, initialFrom!!) } ?: 0.0) }
    var qtyDone by remember { mutableStateOf(false) }
    var to by remember { mutableStateOf<String?>(null) }

    val product = remember(version, productId) { productId?.let { db.productById(it) } }
    val available = remember(version, productId, from) { if (productId != null && from != null) db.qtyAt(productId!!, from!!) else 0.0 }

    fun reset() {
        from = null; productId = null; qty = 0.0; qtyDone = false; to = null
    }

    val step = when {
        from == null -> 1
        product == null -> 2
        !qtyDone -> 3
        else -> 4
    }

    Screen("Raf Transferi", online = online, onBack = { vm.back() }, footer = {
        MessageBar(vm.message?.first, vm.message?.second == true)
        when (step) {
            3 -> PrimaryButton("Miktarı onayla", { qtyDone = true }, enabled = qty > 0 && qty <= available)
            else -> PrimaryButton("Transferi kaydet", {
                vm.repo.transfer(product!!, from!!, to!!, qty, vm.userName)
                vm.saved("${fmt(qty)} ${product.unit.lowercase()} $from → $to taşındı")
                reset()
            }, enabled = step == 4 && to != null)
        }
    }) {
        StepRow(1, "Kaynak raf", from, step) { reset() }
        StepRow(2, "Ürün" + (if (product != null) " · rafta ${fmt(available)} ${product.unit.lowercase()}" else ""), product?.name, step, mono = false, sub = product?.code) {
            productId = null; qtyDone = false; qty = 0.0; to = null
        }
        if (step >= 3) {
            if (step == 3) {
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Miktar", fontWeight = FontWeight.SemiBold)
                            Hint("En çok ${fmt(available)}")
                        }
                        QtyStepper(qty, { qty = it }, max = available)
                    }
                }
            } else {
                StepRow(3, "Miktar", "${fmt(qty)} ${product?.unit?.lowercase()}", step) { qtyDone = false; to = null }
            }
        }
        if (step == 4 && to != null) StepRow(4, "Hedef raf", to, 5) { to = null }

        when (step) {
            1 -> ScanField("Kaynak rafı okutun", "Ürünün şu an durduğu raf", true, vm.repo.prefs.cameraButton, { code ->
                val s = code.uppercase()
                if (!db.shelfExists(s)) vm.error("\"$s\" tanımlı bir raf değil") else { from = s; vm.feedback.ok() }
            })
            2 -> ScanField("Ürünü okutun", "$from rafındaki ürün", true, vm.repo.prefs.cameraButton, { code ->
                val p = db.findProduct(code)
                when {
                    p == null -> vm.error("\"$code\" ürün olarak bulunamadı")
                    db.qtyAt(p.id, from!!) <= 0 -> vm.error("${p.name} $from rafında görünmüyor")
                    else -> { productId = p.id; qty = db.qtyAt(p.id, from!!); vm.feedback.ok() }
                }
            })
            4 -> if (to == null) ScanField("Hedef rafı okutun", "Raf etiketindeki barkodu okutun ya da yazın", true, vm.repo.prefs.cameraButton, { code ->
                val s = code.uppercase()
                when {
                    !db.shelfExists(s) -> vm.error("\"$s\" tanımlı bir raf değil")
                    s == from -> vm.error("Hedef raf kaynakla aynı olamaz")
                    else -> { to = s; vm.feedback.ok() }
                }
            })
        }
        if (step < 4 || to == null) MessageBar(vm.message?.first, vm.message?.second == true)
    }
}

@Composable
private fun StepRow(n: Int, label: String, value: String?, current: Int, mono: Boolean = true, sub: String? = null, onEdit: () -> Unit) {
    if (value == null) return
    Card {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(32.dp).clip(CircleShape).background(C.OkBg), contentAlignment = Alignment.Center) {
                Text("✓", color = C.OkText, fontWeight = FontWeight.Bold)
            }
            Column(Modifier.weight(1f)) {
                Text(label, fontSize = 12.sp, color = C.Muted)
                if (mono) MonoText(value, size = 17) else Text(value, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                if (sub != null) MonoText(sub, size = 12, weight = FontWeight.Medium, color = C.Muted)
            }
            if (current > n) {
                Text("Değiştir", color = C.Info, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.clickable(onClick = onEdit).padding(8.dp))
            }
        }
    }
}
