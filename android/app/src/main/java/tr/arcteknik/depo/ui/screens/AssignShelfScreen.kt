package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tr.arcteknik.depo.data.Product
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.Divider
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.Screen

/**
 * Raf Ata (çalışılan depoda): önce raf okutulur, sonra ürünler peş peşe okutulur; her ürüne o raf hemen adres olarak atanır
 * (sepet ya da onay adımı yok). Ürünün bu depoda başka adresi varsa sorulur: "Yerine koy" eskileri kaldırır, "Yanına ekle"
 * ikisini de tutar. Raftaki miktara dokunulmaz, Vega'ya hareket yazılmaz; yalnız adres (ayara bağlı Vega KOD10) değişir.
 * Başka raf okutulunca sonraki ürünler o rafa atanır.
 */
@Composable
fun AssignShelfScreen(vm: AppVm, online: Boolean) {
    val db = vm.repo.db
    var shelf by remember { mutableStateOf<String?>(null) }
    val done = remember { mutableStateListOf<String>() }
    // Ürünün başka adresi var: kullanıcıya sorulur.
    var ask by remember { mutableStateOf<Pair<Product, List<String>>?>(null) }

    fun assign(p: Product, s: String, replace: Boolean) {
        val old = vm.repo.setHome(p, s, replace, vm.userName)
        done.add(0, "${p.code} → $s" + if (old.isNotEmpty()) " · yerine ${old.joinToString()}" else "")
        vm.saved("${p.code} → $s" + if (old.isNotEmpty()) " (yerine ${old.joinToString()})" else "")
    }

    fun onProduct(p: Product) {
        val s = shelf ?: return vm.error("Önce rafı okutun")
        val homes = db.homeShelves(p.id)
        val others = homes.filter { it != s }
        when {
            s in homes && others.isEmpty() -> vm.ok("${p.code} zaten $s rafında")
            others.isEmpty() -> assign(p, s, false)
            else -> ask = p to others
        }
    }

    fun onShelf(code: String): Boolean {
        val s = code.trim().uppercase()
        if (!db.shelfExists(s)) return false
        shelf = s
        vm.ok("Raf $s")
        return true
    }

    Screen("Raf Düzenle", sub = db.depotName(db.depot).ifBlank { null }, online = online, onBack = { vm.back() }, scroll = false, tabs = { ArrangeTabs(vm, 1) }) {
        ProductScanField(
            vm, "Ürün okutun", if (shelf == null) "Önce raf okutun" else "Raf: $shelf",
            ::onProduct, onOther = ::onShelf, showSearchLink = false,
        )
        MessageBar(vm.message?.first, vm.message?.second == true)
        Card {
            Caption(if (shelf == null) "Raf seçilmedi" else "Okutulan raf")
            if (shelf != null) MonoText(shelf!!, size = 22)
            Hint(if (shelf == null) "Rafın etiketini okutun; sonra okuttuğunuz her ürünün adresi o raf olur." else "Ürünleri okutun. Başka rafa geçmek için o rafın etiketini okutun.")
        }
        if (done.isNotEmpty()) {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Caption("Atananlar (${done.size})")
                done.forEach {
                    Divider()
                    MonoText(it, size = 14, modifier = Modifier.padding(vertical = 7.dp))
                }
            }
        }
    }

    ask?.let { (p, others) ->
        val s = shelf
        if (s != null) AlertDialog(
            onDismissRequest = { ask = null },
            title = { Text("Adres çıktı, yerine konsun mu?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(p.name, fontWeight = FontWeight.SemiBold)
                    Text("Şu an adresi: ${others.joinToString()}", fontSize = 14.sp)
                    Text("Yeni adres: $s", fontSize = 14.sp)
                }
            },
            confirmButton = {
                TextButton({ ask = null; assign(p, s, true) }, Modifier.focusProperties { canFocus = false }) { Text("Yerine koy", fontWeight = FontWeight.Bold) }
            },
            dismissButton = {
                Row {
                    TextButton({ ask = null }, Modifier.focusProperties { canFocus = false }) { Text("Vazgeç") }
                    TextButton({ ask = null; assign(p, s, false) }, Modifier.focusProperties { canFocus = false }) { Text("Yanına ekle") }
                }
            },
        )
    }
}

/** Raf Düzenle'nin iki sekmesi: Toplu (raf raf düzenleme) ve Tek tek (Raf Ata). Sekme değişince ekran yerine geçer, geri tuşu ana ekrana döner. */
@Composable
fun ArrangeTabs(vm: AppVm, selected: Int) {
    Row(Modifier.fillMaxWidth().background(C.Bar)) {
        listOf("Toplu", "Tek tek").forEachIndexed { i, name ->
            val on = i == selected
            Column(
                Modifier.weight(1f).focusProperties { canFocus = false }.clickable(enabled = !on) {
                    if (i == 0) vm.replace(Route.Count(vm.repo.startArrange().id)) else vm.replace(Route.AssignShelf)
                },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(name, Modifier.padding(vertical = 12.dp), color = if (on) Color.White else C.BarSub, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium, fontSize = 15.sp)
                Box(Modifier.fillMaxWidth().height(3.dp).background(if (on) C.Accent else Color.Transparent))
            }
        }
    }
}
