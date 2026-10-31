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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tr.arcteknik.depo.data.Kapsam
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.data.Perm
import tr.arcteknik.depo.data.isArrangeId
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.Divider
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.LimitedList
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.Notice
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.QtyStepper
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.ProductScanField
import tr.arcteknik.depo.ui.ScanField
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton
import tr.arcteknik.depo.ui.Toggle
import tr.arcteknik.depo.ui.Tone

@Composable
fun CountListScreen(vm: AppVm, online: Boolean, version: Int) {
    val sessions = remember(version, vm.user) { vm.repo.db.countSessions().filter { vm.canDepot(it.depot) } }
    Screen("Sayım", online = online, onBack = { vm.back() }, scroll = false, footer = if (vm.can(Perm.COUNT_FREE) && vm.canDepot(vm.repo.db.depot)) ({
        SecondaryButton("Serbest sayım başlat", { vm.go(Route.Count(vm.repo.startFreeCount().id)) })
    }) else null) {
        Hint("Yönetici programında açılan sayımlar burada görünür.")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(sessions, key = { it.id }) { s ->
                val lines = remember(version) { vm.repo.db.countedShelves(s.id).size }
                val inScope = remember(version) { vm.repo.db.scopeShelves(s).size }
                Card(onClick = { vm.go(Route.Count(s.id)) }) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        MonoText(s.no)
                        Hint(if (s.blind) "Kör sayım" else "Açık sayım")
                    }
                    Text(s.title, fontWeight = FontWeight.SemiBold)
                    if (s.scope.isNotEmpty()) MonoText("Raflar: " + s.scope.joinToString(", "), size = 13, weight = FontWeight.Medium, color = C.Text2)
                    Hint(
                        when {
                            s.scope.isNotEmpty() -> "Bu cihazda $lines / $inScope raf sayıldı"
                            lines == 0 -> "Henüz raf sayılmadı"
                            else -> "$lines raf sayıldı"
                        },
                    )
                }
            }
        }
        if (sessions.isEmpty()) Hint("Açık sayım yok.")
    }
}

/**
 * Raf okut → ürünleri okut (her okutma +1) → sonraki raf. Raf Düzenle (rafta duran malı rafa tanımlama) aynı ekranı
 * kullanır, yalnız metinler farklıdır: "sayım" sözcüğü orada geçmez.
 */
@Composable
fun CountScreen(vm: AppVm, online: Boolean, version: Int, sessionId: String) {
    val db = vm.repo.db
    val arrange = isArrangeId(sessionId)
    // Raf Düzenle: okutulmayan ürün rafta kalsın mı (cihaz tercihi, varsayılan evet).
    var keep by remember { mutableStateOf(vm.repo.prefs.arrangeKeepOthers) }
    val session = remember(version) { db.countSession(sessionId) }
    var shelf by remember { mutableStateOf<String?>(null) }
    val lines = remember(version, shelf) { shelf?.let { db.countLines(sessionId, it) }.orEmpty() }
    // Rafta olması gereken (raf stoku ya da zimmet) ama bu sayımda henüz okutulmayan ürünler.
    val contents = remember(version, shelf, session?.depot) { shelf?.let { db.shelfContents(it, session?.depot ?: db.depot) }.orEmpty() }
    val waiting = remember(contents, lines) {
        val counted = lines.map { it.product.id }.toSet()
        contents.filter { it.product.id !in counted }
    }
    // Raf Düzenle: satırın altında rafta daha önce kaç adet olduğu yazar (okutulan, üstüne eklenir).
    val onShelf = remember(contents) { contents.filter { it.qty > 0 }.associate { it.product.id to it.qty } }
    val shelves = remember(version) { db.countedShelves(sessionId) }
    val scopeShelves = remember(version, session?.scope) { session?.let { db.scopeShelves(it) }.orEmpty() }
    val left = remember(scopeShelves, shelves) { scopeShelves.filter { it !in shelves.toSet() } }
    fun inScope(s: String) = session == null || Kapsam.icinde(s, session.scope)
    fun scopeError(s: String) = vm.error("$s bu sayımda değil; yalnız ${session!!.scope.joinToString(", ")} rafları sayılır")
    val scans = remember(version) { db.countLines(sessionId).sumOf { it.qty } }
    DisposableEffect(sessionId) { onDispose { vm.repo.discardEmptyLocal(sessionId) } }

    if (session == null) {
        Screen(if (arrange) "Raf Düzenle" else "Sayım", online = online, onBack = { vm.back() }) { Hint(if (arrange) "Düzenleme bulunamadı." else "Sayım bulunamadı.") }
        return
    }

    Screen(session.no, sub = if (arrange) "Raf düzenleme" else "${session.title} · " + if (session.blind) "kör sayım" else "açık sayım", online = online, onBack = { vm.back() }, monoTitle = true, scrollKey = shelf, footer = {
        MessageBar(vm.message?.first, vm.message?.second == true)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton("Sonraki raf", { shelf = null }, Modifier.weight(1f), enabled = shelf != null)
            PrimaryButton(if (arrange) "Bitir" else "Sayımı bitir", { vm.go(Route.CountDiff(sessionId)) }, Modifier.weight(1f), enabled = shelves.isNotEmpty())
        }
    }) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(if (session.scope.isEmpty()) (if (arrange) "Düzenlenen raf ${shelves.size}" else "Sayılan raf ${shelves.size}") else "${session.scope.joinToString(", ")} · ${scopeShelves.size - left.size} / ${scopeShelves.size} raf", fontSize = 13.sp, color = C.Text2)
            Text("${fmt(scans)} okutma", fontSize = 13.sp, color = C.Text2)
        }
        if (arrange) {
            Toggle(
                "Okutulmayan ürünler yerinde kalsın",
                if (keep) "Okutulan adet rafta olana eklenir; okutulmayan ürün yerinde kalır" else "Raf okutulana eşitlenir; okutulmayan ürün raftan çıkar",
                keep,
            ) { keep = it; vm.repo.prefs.arrangeKeepOthers = it }
        }

        if (shelf == null) {
            ScanField("Raf okutun", if (arrange) "Düzenleyeceğiniz rafın etiketi" else "Sayacağınız rafın etiketi", true, vm.repo.prefs.cameraButton, { code ->
                val s = code.uppercase()
                when {
                    !inScope(s) -> scopeError(s)
                    !db.shelfExists(s, session.depot) -> vm.unknownShelf(s, session.depot) { shelf = it }
                    else -> { shelf = s; vm.feedback.ok() }
                }
            })
            if (shelves.isNotEmpty()) Hint((if (arrange) "Düzenlenen raflar: " else "Sayılan raflar: ") + shelves.joinToString(", "))
            if (left.isNotEmpty()) Hint("Bu cihazda sayılmayan: " + left.take(40).joinToString(", ") + if (left.size > 40) " … (+${left.size - 40})" else "")
        } else {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.Bar).padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(if (arrange) "Şu an düzenlenen raf" else "Şu an sayılan raf", color = C.BarSub, fontSize = 12.sp)
                    MonoText(shelf!!, size = 24, color = C.Accent)
                }
                Text("Raf değiştir", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.focusProperties { canFocus = false }.clickable { shelf = null }.padding(8.dp))
            }
            ProductScanField(
                vm, "Ürün okutun", if (arrange && keep) "Her okutma rafta olana 1 adet ekler; toplam aşağıdan da düzeltilir" else "Her okutma 1 adet ekler; miktar aşağıdan da yazılır",
                onProduct = { p -> vm.repo.addCount(sessionId, shelf!!, p, 1.0); vm.feedback.ok() },
                onOther = { code ->
                    val s = code.uppercase()
                    db.shelfExists(s, session.depot).also {
                        if (it && !inScope(s)) scopeError(s) else if (it) { shelf = s; vm.ok("Raf $s") }
                    }
                },
            )
            if (lines.isEmpty() && shelf !in shelves) {
                // Boş raf da sayılır: rafta sistemde görünen ürün varsa gönderilince 0'a çekilir.
                SecondaryButton("Raf boş, sonraki raf", { vm.repo.markShelfEmpty(sessionId, shelf!!); vm.ok(if (arrange) "$shelf boş olarak işaretlendi" else "$shelf boş sayıldı"); shelf = null })
            }
            Card(padding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp)) {
                Caption(if (arrange) "Bu rafta" else "Bu rafta sayılan")
                if (lines.isEmpty()) Hint("Henüz ürün okutulmadı.", Modifier.padding(bottom = 10.dp))
                // Okutulan satırların hepsi görünür: ada göre sıralı, yeni okutulan sınırın dışında kalmasın.
                LimitedList(lines, { it.product.id }, limit = Int.MAX_VALUE) { l ->
                    Divider()
                    Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(l.product.name, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            MonoText(l.product.code, size = 12, weight = FontWeight.Medium, color = C.Muted)
                            if (arrange) onShelf[l.product.id]?.let { Text("Rafta vardı ${fmt(it)}", fontSize = 12.sp, color = C.Muted) }
                        }
                        QtyStepper(l.qty, { vm.repo.setCount(sessionId, shelf!!, l.product, it) }, small = true)
                    }
                }
                if (waiting.isNotEmpty()) {
                    Divider()
                    Caption(
                        if (arrange) "Sistemde bu rafta görünüyor, okutulmadı (${waiting.size}) · " + if (keep) "yerinde kalır" else "gönderince raftan çıkar"
                        else "Bu rafta beklenen, okutulmadı (${waiting.size})",
                        Modifier.padding(top = 10.dp),
                    )
                    LimitedList(waiting, { "w" + it.product.id }) { w ->
                        Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(w.product.name, color = C.Text2, maxLines = 1)
                                MonoText(w.product.code + if (w.qty <= 0) " · zimmetli" else "", size = 12, weight = FontWeight.Medium, color = C.Muted)
                            }
                            // Kör sayımda sistem miktarı gösterilmez; yalnız ürünün beklendiği.
                            if (!session.blind && w.qty > 0) MonoText(fmt(w.qty), size = 14, color = C.Muted)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun CountDiffScreen(vm: AppVm, online: Boolean, version: Int, sessionId: String) {
    val db = vm.repo.db
    // Raf Düzenle aynı sonuç ekranını kullanır; metinler "sayım" demeden "düzenleme" der.
    val arrange = isArrangeId(sessionId)
    val session = remember(version) { db.countSession(sessionId) }
    var keep by remember { mutableStateOf(vm.repo.prefs.arrangeKeepOthers) }
    val diffs = remember(version, keep) { vm.repo.countDiffs(sessionId) }
    val changed = diffs.filter { it.diff != 0.0 }
    // Boş sayılan raflar: farkı yoksa listede görünmez ama gönderilir (yöneticide sayıldı olarak işaretlenir).
    val shelves = remember(version) { db.countedShelves(sessionId) }
    val emptyShelves = shelves.filter { s -> diffs.none { it.shelf == s } }
    // Raf Düzenle onayı: rafa yazılacak (yeni ya da değişen miktar) ve raftan çıkacak (rafta görünüp okutulmayan) ürün sayısı.
    val written = diffs.count { it.counted > 0 && it.diff != 0.0 }
    val removed = diffs.count { it.counted <= 0 && it.system > 0 }
    var confirm by remember { mutableStateOf(false) }

    Screen(if (arrange) "Düzenleme özeti" else "Sayım sonucu", sub = session?.let { "${it.no}" + if (arrange) "" else " · ${it.title}" }, online = online, onBack = { vm.back() }, footer = {
        MessageBar(vm.message?.first, vm.message?.second == true)
        if (changed.isNotEmpty()) SecondaryButton(if (arrange) "Düzenlemeye dön" else "Sayıma dön, farklı kalemleri tekrar say", { vm.back() })
        PrimaryButton(if (arrange) "Düzenlemeyi kaydet" else "Sayımı gönder", { confirm = true }, enabled = session != null && shelves.isNotEmpty())
    }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Stat("Kalem", diffs.size, Modifier.weight(1f))
            Stat(if (arrange) "Aynı" else "Eşleşen", diffs.size - changed.size, Modifier.weight(1f))
            Stat(if (arrange) "Değişen" else "Farklı", changed.size, Modifier.weight(1f), warn = changed.isNotEmpty())
        }
        Card(padding = PaddingValues(start = 12.dp, end = 12.dp, top = 10.dp)) {
            Row(Modifier.fillMaxWidth()) {
                Caption("Ürün · raf", Modifier.weight(1f))
                Caption(if (arrange) "Önce" else "Sistem", Modifier.width(52.dp))
                Caption(if (arrange) "Sonra" else "Sayılan", Modifier.width(60.dp))
                Caption("Fark", Modifier.width(44.dp))
            }
            // Farklı kalemler başta sıralıdır; çok uzun sayımda kalanı "Daha fazla göster" ile açılır.
            LimitedList(diffs, { it.shelf + it.product.id }, limit = 80) { d ->
                Divider()
                Row(Modifier.padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(d.product.name, fontWeight = FontWeight.SemiBold, maxLines = 1)
                        MonoText("${d.product.code} · ${d.shelf}", size = 12, weight = FontWeight.Medium, color = C.Muted)
                    }
                    MonoText(fmt(d.system), modifier = Modifier.width(52.dp), weight = FontWeight.Medium)
                    MonoText(fmt(d.counted), modifier = Modifier.width(60.dp), weight = FontWeight.Medium)
                    MonoText(
                        if (d.diff == 0.0) "0" else (if (d.diff > 0) "+" else "−") + fmt(Math.abs(d.diff)),
                        modifier = Modifier.width(44.dp),
                        color = when {
                            d.diff > 0 -> C.Info
                            d.diff < 0 -> C.Warn
                            else -> C.Muted
                        },
                    )
                }
            }
        }
        if (emptyShelves.isNotEmpty()) Hint((if (arrange) "Boş bırakılan raf (" else "Boş sayılan raf (") + "${emptyShelves.size}): " + emptyShelves.take(30).joinToString(", ") + if (emptyShelves.size > 30) " …" else "")
        if (arrange) {
            Toggle(
                "Okutulmayan ürünler yerinde kalsın",
                if (keep) "Okutulan adet rafta olana eklenir; okutulmayan ürün yerinde kalır" else "Raf okutulana eşitlenir; okutulmayan ürün raftan çıkar",
                keep,
            ) { keep = it; vm.repo.prefs.arrangeKeepOthers = it }
            Notice(
                (if (keep) "Okutulan adetler rafta olanın üstüne eklendi; okutulmayan ürünler raftan çıkmaz." else "Okutulmayan ürünler raftan çıkar.") + " Yalnız raf bilgisi güncellenir; Vega stoku değişmez, onay beklenmez.",
                Tone.Info,
            )
        }
        else Notice("Gönderilen sayım yönetici programında onaylanınca farklar Vega'ya sayım fişi olarak işlenir.", Tone.Info)
    }

    if (confirm && session != null) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(if (arrange) "${shelves.size} raf düzenlensin mi?" else "Sayım gönderilsin mi?") },
            text = {
                Text(
                    if (arrange && keep) "$written ürün rafa yazılacak" + (if (removed > 0) ", $removed ürün raftan çıkacak (0 yazılan ya da boş bildirilen raf)" else "") + ". Okutulmayan ürünler raftan çıkmaz. Kaydettikten sonra bu düzenlemede değişiklik yapılamaz."
                    else if (arrange) "$written ürün rafa yazılacak, $removed ürün raftan çıkacak. Kaydettikten sonra bu düzenlemede değişiklik yapılamaz."
                    else "${shelves.size} raf, ${diffs.size} kalem, ${changed.size} farklı. Gönderdikten sonra bu sayımda değişiklik yapılamaz.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    vm.repo.submitCount(session, vm.userName)
                    vm.saved(if (arrange) "Raf düzenleme kuyruğa alındı" else "Sayım gönderilmek üzere kuyruğa alındı")
                    vm.stack.removeAll { it is Route.Count || it is Route.CountDiff }
                }) { Text(if (arrange) "Kaydet" else "Gönder") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Vazgeç") } },
        )
    }
}

@Composable
private fun Stat(label: String, value: Int, modifier: Modifier, warn: Boolean = false) {
    Card(modifier, bg = if (warn) C.WarnBg else C.Surface, border = if (warn) C.Warn else C.Line, padding = PaddingValues(horizontal = 12.dp, vertical = 10.dp)) {
        Column {
            Text(label, fontSize = 12.sp, color = if (warn) C.WarnText else C.Muted)
            MonoText("$value", size = 22, weight = FontWeight.SemiBold, color = if (warn) C.WarnText else C.Ink)
        }
    }
}
