package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import androidx.compose.ui.platform.LocalContext
import tr.arcteknik.depo.BuildConfig
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.Notice
import tr.arcteknik.depo.ui.ScanField
import tr.arcteknik.depo.ui.Tone
import tr.arcteknik.depo.ui.openUrl
import tr.arcteknik.depo.ui.Card
import tr.arcteknik.depo.ui.Caption
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.Ic
import tr.arcteknik.depo.ui.LabeledField
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.Screen
import tr.arcteknik.depo.ui.SecondaryButton
import tr.arcteknik.depo.ui.Toggle

@Composable
fun SettingsScreen(vm: AppVm, online: Boolean) {
    val p = vm.repo.prefs
    var demo by remember { mutableStateOf(p.demo) }
    var url by remember { mutableStateOf(p.serverUrl) }
    var key by remember { mutableStateOf(p.deviceKey) }
    var device by remember { mutableStateOf(p.deviceName) }
    var camera by remember { mutableStateOf(p.cameraButton) }
    var confirmReset by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    fun save(): Boolean {
        if (!demo && !url.startsWith("http")) {
            vm.error("Sunucu adresi http:// ile başlamalı")
            return false
        }
        val modeChanged = p.demo != demo || p.serverUrl != url.trimEnd('/')
        p.demo = demo; p.serverUrl = url; p.deviceKey = key; p.deviceName = device.ifBlank { "TRM-01" }
        p.cameraButton = camera
        // Kaynak değişince eski kaynağın verisi kalmasın; gönderilmemiş işlem varsa silinmez.
        if (modeChanged && vm.repo.db.pendingOpCount() == 0) vm.repo.db.clearAll()
        vm.repo.changed()
        return true
    }

    Screen("Ayarlar", online = online, onBack = { vm.back() }, footer = {
        MessageBar(vm.message?.first, vm.message?.second == true)
        PrimaryButton("Kaydet ve eşitle", {
            if (save()) scope.launch {
                val err = vm.sync.run()
                if (err == null) vm.ok("Eşitleme tamam") else vm.error("Eşitlenemedi: $err")
            }
        })
    }) {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Card {
                Caption("QR ile kur")
                // Yönetici programı › Cihazlar › Kurulum QR: "ORTASDEPO|http://ip:port|ANAHTAR|TRM-01"
                ScanField("Kurulum QR kodunu okutun", "Yönetici programı › Cihazlar › Kurulum QR", true, true, { code ->
                    val parts = code.trim().split("|")
                    if (parts.size >= 3 && parts[0] == "ORTASDEPO" && parts[1].startsWith("http")) {
                        demo = false; url = parts[1].trimEnd('/'); key = parts[2]
                        if (parts.size >= 4 && parts[3].isNotBlank()) device = parts[3]
                        if (save()) scope.launch {
                            val err = vm.sync.run()
                            if (err == null) vm.ok("Kuruldu ve eşitlendi") else vm.error("Kaydedildi ama eşitlenemedi: $err")
                        }
                    } else {
                        vm.error("Bu bir kurulum QR kodu değil")
                    }
                })
            }
            Card {
                Toggle("Demo modu", "Sunucu olmadan örnek veriyle çalışır", demo) { demo = it }
            }
            if (!demo) {
                Card {
                    Caption("Sunucu")
                    LabeledField("Sunucu adresi", url, { url = it.trim() }, keyboard = KeyboardType.Uri, hint = "Örnek: http://192.168.1.20:5480 (yönetici programında yazar)")
                    LabeledField("Cihaz anahtarı", key, { key = it.trim() }, hint = "Yönetici programı › Cihazlar ekranından alınır")
                }
            }
            Card {
                Caption("Cihaz")
                LabeledField("Cihaz adı", device, { device = it })
                // Depo burada yazılmaz: ana menünün üst çubuğundan seçilir (çok depo, 1.1.0).
                Hint("Çalışılan depo: ${vm.repo.depotName()} · ana menüdeki depo düğmesinden değiştirilir")
                Toggle("Kamera düğmesi", "Telefonlarda kamerayla okutmak için", camera) { camera = it }
            }
            val lastSync = p.lastSync
            Hint(
                (if (lastSync > 0) "Son eşitleme: " + java.text.SimpleDateFormat("dd.MM.yyyy HH:mm", java.util.Locale("tr")).format(lastSync) else "Henüz eşitleme yapılmadı") +
                    (p.lastSyncError.takeIf { it.isNotBlank() }?.let { "\nSon hata: $it" } ?: ""),
            )
            p.updateUrl(BuildConfig.VERSION_CODE)?.let { link ->
                Notice("Sunucuda yeni uygulama sürümü var: ${p.updateName} (bu cihaz ${BuildConfig.VERSION_NAME}).", Tone.Info)
                PrimaryButton("Yeni sürümü indir", { openUrl(context, link) })
            }
            SecondaryButton("Cihaz verisini sıfırla", { confirmReset = true }, icon = Ic.Refresh)
        }
    }

    if (confirmReset) {
        val pending = vm.repo.db.pendingOpCount()
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("Cihaz verisi silinsin mi?") },
            text = {
                Text(
                    if (pending > 0) "Gönderilmemiş $pending işlem var. Sıfırlarsanız bu işlemler kaybolur ve geri getirilemez."
                    else "Ürün, raf ve belge listesi silinip sunucudan yeniden alınır.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmReset = false
                    vm.repo.db.clearAll()
                    vm.repo.changed()
                    scope.launch { vm.sync.run() }
                    vm.logout()
                }) { Text(if (pending > 0) "İşlemlerle birlikte sil" else "Sıfırla") }
            },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Vazgeç") } },
        )
    }
}
