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
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.Divider
import tr.arcteknik.depo.ui.Hint
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
import tr.arcteknik.depo.ui.Tone

@Composable
fun CountListScreen(vm: AppVm, online: Boolean, version: Int) {
    val sessions = remember(version) { vm.repo.db.countSessions() }
    Screen("Sayım", online = online, onBack = { vm.back() }, footer = {
        SecondaryButton("Serbest sayım başlat", { vm.go(Route.Count(vm.repo.startFreeCount().id)) })
    }) {
        Hint("Yönetici programında açılan sayımlar burada görünür.")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(sessions, key = { it.id }) { s ->
                val lines = remember(version) { vm.repo.db.countedShelves(s.id).size }
                Card(onClick = { vm.go(Route.Count(s.id)) }) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        MonoText(s.no)
                        Hint(if (s.blind) "Kör sayım" else "Açık sayım")
                    }
                    Text(s.title, fontWeight = FontWeight.SemiBold)
                    Hint(if (lines == 0) "Henüz raf sayılmadı" else "$lines raf sayıldı")
                }
            }
        }
        if (sessions.isEmpty()) Hint("Açık sayım yok.")
    }
}

/** Raf okut → ürünleri okut (her okutma +1) → sonraki raf. */
@Composable
fun CountScreen(vm: AppVm, online: Boolean, version: Int, sessionId: String) {
    val db = vm.repo.db
    val session = remember(version) { db.countSession(sessionId) }
    var shelf by remember { mutableStateOf<String?>(null) }
    val lines = remember(version, shelf) { shelf?.let { db.countLines(sessionId, it) }.orEmpty() }
    // Rafta olması gereken (raf stoku ya da zimmet) ama bu sayımda henüz okutulmayan ürünler.
    val waiting = remember(version, shelf, session?.depot) {
        val s = shelf ?: return@remember emptyList()
        val counted = lines.map { it.product.id }.toSet()
        db.shelfContents(s, session?.depot ?: db.depot).filter { it.product.id !in counted }
    }
    val shelves = remember(version) { db.countedShelves(sessionId) }
    val scans = remember(version) { db.countLines(sessionId).sumOf { it.qty } }
    DisposableEffect(sessionId) { onDispose { vm.repo.discardEmptyLocal(sessionId) } }

    if (session == null) {
        Screen("Sayım", online = online, onBack = { vm.back() }) { Hint("Sayım bulunamadı.") }
        return
    }

    Screen(session.no, sub = "${session.title} · " + if (session.blind) "kör sayım" else "açık sayım", online = online, onBack = { vm.back() }, monoTitle = true, footer = {
        MessageBar(vm.message?.first, vm.message?.second == true)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton("Sonraki raf", { shelf = null }, Modifier.weight(1f), enabled = shelf != null)
            PrimaryButton("Sayımı bitir", { vm.go(Route.CountDiff(sessionId)) }, Modifier.weight(1f), enabled = shelves.isNotEmpty())
        }
    }) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Sayılan raf ${shelves.size}", fontSize = 13.sp, color = C.Text2)
            Text("${fmt(scans)} okutma", fontSize = 13.sp, color = C.Text2)
        }

        if (shelf == null) {
            ScanField("Raf okutun", "Sayacağınız rafın etiketi", true, vm.repo.prefs.cameraButton, { code ->
                val s = code.uppercase()
                if (!db.shelfExists(s)) vm.error("\"$s\" tanımlı bir raf değil") else { shelf = s; vm.feedback.ok() }
            })
            if (shelves.isNotEmpty()) Hint("Sayılan raflar: " + shelves.joinToString(", "))
        } else {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.Bar).padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Şu an sayılan raf", color = C.BarSub, fontSize = 12.sp)
                    MonoText(shelf!!, size = 24, color = C.Accent)
                }
                Text("Raf değiştir", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.focusProperties { canFocus = false }.clickable { shelf = null }.padding(8.dp))
            }
            ProductScanField(
                vm, "Ürün okutun", "Her okutma 1 adet ekler; miktar aşağıdan da yazılır",
                onProduct = { p -> vm.repo.addCount(sessionId, shelf!!, p, 1.0); vm.feedback.ok() },
                onOther = { code -> db.shelfExists(code.uppercase()).also { if (it) { shelf = code.uppercase(); vm.ok("Raf ${code.uppercase()}") } } },
            )
            Card(padding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp)) {
                Caption("Bu rafta sayılan")
                if (lines.isEmpty()) Hint("Henüz ürün okutulmadı.", Modifier.padding(bottom = 10.dp))
                LazyColumn {
                    items(lines, key = { it.product.id }) { l ->
                        Divider()
                        Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(l.product.name, fontWeight = FontWeight.SemiBold, maxLines = 1)
                                MonoText(l.product.code, size = 12, weight = FontWeight.Medium, color = C.Muted)
                            }
                            QtyStepper(l.qty, { vm.repo.setCount(sessionId, shelf!!, l.product, it) }, small = true)
                        }
                    }
                    if (waiting.isNotEmpty()) {
                        item(key = "bekleyen") {
                            Divider()
                            Caption("Bu rafta beklenen, okutulmadı (${waiting.size})", Modifier.padding(top = 10.dp))
                        }
                        items(waiting, key = { "w" + it.product.id }) { w ->
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
}

@Composable
fun CountDiffScreen(vm: AppVm, online: Boolean, version: Int, sessionId: String) {
    val db = vm.repo.db
    val session = remember(version) { db.countSession(sessionId) }
    val diffs = remember(version) { vm.repo.countDiffs(sessionId) }
    val changed = diffs.filter { it.diff != 0.0 }
    var confirm by remember { mutableStateOf(false) }

    Screen("Sayım sonucu", sub = session?.let { "${it.no} · ${it.title}" }, online = online, onBack = { vm.back() }, footer = {
        MessageBar(vm.message?.first, vm.message?.second == true)
        if (changed.isNotEmpty()) SecondaryButton("Sayıma dön, farklı kalemleri tekrar say", { vm.back() })
        PrimaryButton("Sayımı gönder", { confirm = true }, enabled = session != null && diffs.isNotEmpty())
    }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Stat("Kalem", diffs.size, Modifier.weight(1f))
            Stat("Eşleşen", diffs.size - changed.size, Modifier.weight(1f))
            Stat("Farklı", changed.size, Modifier.weight(1f), warn = changed.isNotEmpty())
        }
        Card(padding = PaddingValues(start = 12.dp, end = 12.dp, top = 10.dp)) {
            Row(Modifier.fillMaxWidth()) {
                Caption("Ürün · raf", Modifier.weight(1f))
                Caption("Sistem", Modifier.width(52.dp))
                Caption("Sayılan", Modifier.width(60.dp))
                Caption("Fark", Modifier.width(44.dp))
            }
            LazyColumn {
                items(diffs, key = { it.shelf + it.product.id }) { d ->
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
        }
        Notice("Gönderilen sayım yönetici programında onaylanınca farklar Vega'ya sayım fişi olarak işlenir.", Tone.Info)
    }

    if (confirm && session != null) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Sayım gönderilsin mi?") },
            text = { Text("${diffs.size} kalem, ${changed.size} farklı. Gönderdikten sonra bu sayımda değişiklik yapılamaz.") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    vm.repo.submitCount(session, vm.userName)
                    vm.saved("Sayım gönderilmek üzere kuyruğa alındı")
                    vm.stack.removeAll { it is Route.Count || it is Route.CountDiff }
                }) { Text("Gönder") }
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
