package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tr.arcteknik.depo.BuildConfig
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.Ic
import tr.arcteknik.depo.ui.LabeledField
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.Notice
import tr.arcteknik.depo.ui.PrimaryButton
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.Tone

@Composable
fun LoginScreen(vm: AppVm, version: Int) {
    var username by remember { mutableStateOf(vm.repo.prefs.lastUser) }
    var pin by remember { mutableStateOf("") }
    val busy by vm.sync.busy.collectAsState()
    val empty = remember(version) { vm.repo.db.isEmpty() }
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current

    fun submit() {
        val u = vm.repo.login(username, pin)
        if (u == null) {
            pin = ""
            vm.error(if (empty) "Cihazda kullanıcı listesi yok. Önce eşitleme gerekli." else "Kullanıcı adı ya da şifre hatalı")
        } else {
            // Klavye açık kalırsa ana menüdeki okutma alanının yarısını kapatıyor.
            focus.clearFocus()
            keyboard?.hide()
            vm.login(u)
        }
    }

    Column(Modifier.fillMaxSize().background(C.Bar)) {
        Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 8.dp, top = 8.dp), horizontalArrangement = Arrangement.End) {
            IconButton(onClick = { vm.go(Route.Settings) }, modifier = Modifier.size(48.dp)) {
                Icon(Ic.Settings, contentDescription = "Ayarlar", tint = C.BarSub, modifier = Modifier.size(24.dp))
            }
        }
        Column(Modifier.padding(start = 24.dp, end = 24.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Box(Modifier.size(56.dp).clip(RoundedCornerShape(14.dp)).background(C.Accent), contentAlignment = Alignment.Center) {
                Icon(Ic.Barcode, null, tint = C.Bar, modifier = Modifier.size(32.dp))
            }
            Column {
                Text("ORTAŞ", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                Text("Depo Terminali", color = C.BarSub, fontSize = 15.sp)
            }
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).background(C.Ground)
                .verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (empty) {
                Notice(
                    if (busy) "Veriler alınıyor…" else "Cihazda veri yok. Ayarlardan sunucu adresini girin ya da demo modunu açın.",
                    Tone.Info,
                )
            }
            LabeledField("Kullanıcı", username, { username = it.trim() })
            LabeledField("Şifre", pin, { pin = it }, password = true, onDone = ::submit)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Depo", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = C.Text2)
                Text(remember(version) { vm.repo.depotName() }, fontSize = 16.sp)
            }
            PrimaryButton("Giriş yap", ::submit, enabled = username.isNotBlank() && pin.isNotBlank())
            MessageBar(vm.message?.first, vm.message?.second == true)
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Hint("Cihaz: ${vm.repo.prefs.deviceName}")
                Hint("Sürüm ${BuildConfig.VERSION_NAME}" + if (vm.repo.prefs.demo) " · demo" else "")
            }
            Hint("İnternet yoksa da giriş yapılır; kullanıcı listesi cihazda saklanır.")
        }
    }
}
