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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import tr.arcteknik.depo.data.Op
import tr.arcteknik.depo.data.OpStatus
import tr.arcteknik.depo.data.Perm
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.Divider
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.Ic
import tr.arcteknik.depo.ui.LimitedList
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.MonoText
import tr.arcteknik.depo.ui.Notice
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton
import tr.arcteknik.depo.ui.Tone
import java.text.SimpleDateFormat
import java.util.Locale

@Composable
fun QueueScreen(vm: AppVm, online: Boolean, version: Int) {
    val ops = remember(version) { vm.repo.db.ops() }
    val busy by vm.sync.busy.collectAsState()
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<Op?>(null) }
    val time = remember { SimpleDateFormat("HH:mm", Locale("tr")) }
    val lastSync = vm.repo.prefs.lastSync

    Screen("Gönderim Kuyruğu", online = online, onBack = { vm.back() }, footer = {
        MessageBar(vm.message?.first, vm.message?.second == true)
        SecondaryButton(if (busy) "Gönderiliyor…" else "Şimdi dene", {
            // Reddedilmiş (hatalı) işlemleri yeniden denemek yetki ister; bekleyenler her zaman gönderilir.
            if (vm.can(Perm.QUEUE_MANAGE)) vm.repo.db.resetOpErrors()
            scope.launch {
                val err = vm.sync.run()
                if (err == null) vm.ok("Eşitleme tamam") else vm.error("Gönderilemedi: $err")
            }
        }, icon = Ic.Refresh, enabled = !busy)
    }) {
        if (!online) {
            Notice("İşlemler cihazda saklanıyor. Bağlantı gelince kendiliğinden gönderilir.", Tone.Warn, title = "Bağlantı yok, çalışmaya devam edin", icon = Ic.WifiOff)
        }
        if (ops.isEmpty()) {
            Notice("Gönderilmeyi bekleyen işlem yok.", Tone.Ok)
        } else {
            Card(padding = PaddingValues(start = 14.dp, end = 14.dp, top = 8.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Caption("Bekleyen ${ops.size} işlem")
                    Caption("En eski ${time.format(ops.first().createdAt)}")
                }
                LimitedList(ops, { it.id }) { op ->
                    val title = op.summary.substringBefore('|')
                    val sub = op.summary.substringAfter('|', "")
                    val err = op.status == OpStatus.ERROR
                    Column(Modifier.clickable { selected = op }) {
                        Divider()
                        Row(Modifier.padding(vertical = 10.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                if (err) Text(op.error ?: "Sunucu reddetti", color = C.Err, fontSize = 12.sp)
                                else MonoText("$sub · ${time.format(op.createdAt)}", size = 12, weight = FontWeight.Medium, color = C.Muted)
                            }
                            Tag(if (err) "Hata" else "Bekliyor", err)
                        }
                    }
                }
            }
        }
        val f = SimpleDateFormat("dd.MM · HH:mm", Locale("tr"))
        Hint(
            (if (lastSync > 0) "Son başarılı eşitleme: ${f.format(lastSync)}. " else "") +
                "Ürün ve raf listesi cihazda tutulur, sorgular internetsiz de çalışır.",
        )
    }

    selected?.let { op ->
        AlertDialog(
            onDismissRequest = { selected = null },
            title = { Text(op.summary.substringBefore('|')) },
            text = {
                Text(
                    (if (op.status == OpStatus.ERROR) "Sunucu bu işlemi kabul etmedi: ${op.error}\n\n" else "") +
                        "Silerseniz işlem sunucuya hiç gitmez; cihazdaki raf miktarı bir sonraki eşitlemede sunucudaki hale döner.",
                )
            },
            confirmButton = {
                if (vm.can(Perm.QUEUE_MANAGE)) TextButton(onClick = {
                    vm.repo.db.deleteOp(op.id); vm.repo.changed(); selected = null
                    scope.launch { vm.sync.run() }
                }) { Text("İşlemi sil") }
            },
            dismissButton = { TextButton(onClick = { selected = null }) { Text("Kapat") } },
        )
    }
}

@Composable
private fun Tag(text: String, error: Boolean) {
    Box(
        Modifier.height(24.dp).clip(RoundedCornerShape(12.dp)).background(if (error) C.ErrBg else C.Ground).padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, fontSize = 11.sp, fontWeight = FontWeight.Bold, color = if (error) C.Err else C.Text2) }
}
