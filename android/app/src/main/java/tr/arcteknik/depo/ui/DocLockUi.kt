package tr.arcteknik.depo.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/*
 * Belge kilidi arayüzü. Mal kabul / rafa kaldırma belgesi ve gelen transfer belgesi ekrana gelince terminal belgeyi kilitler
 * (AppVm.enterDoc), çıkınca bırakır. Kilit arayüz korumasıdır: başka terminal belgeyi tutuyorsa bu terminalde belge açılmaz,
 * sunucu ise işlemleri kilide bakmadan kabul eder (çakışmayı miktar sınırları çözer).
 */

/** Belgeye girerken kilit alır, ekrandan çıkınca bırakır. Belge ekranının en başında çağrılır. */
@Composable
fun DocLockEffect(vm: AppVm, docId: String, kind: String, docNo: String) {
    DisposableEffect(docId) {
        vm.enterDoc(docId, kind, docNo)
        onDispose { vm.leaveDoc(docId) }
    }
}

/** Başka terminalin tuttuğu belge: ekran açılmaz, kim kullandığı gösterilir. */
@Composable
fun DocTakenScreen(vm: AppVm, online: Boolean, title: String) {
    Screen(title, online = online, onBack = { vm.back() }, monoTitle = true) {
        Notice(vm.docLock.message.ifBlank { "Başka bir terminal kullanıyor" }, Tone.Warn, title = "Belge kullanımda", icon = Ic.Lock)
        Hint("Kullanan kişi belgeden çıkınca ya da 3 dakika işlem yapılmazsa belge açılır. Gerekirse yönetici programından kilit açılabilir.")
        SecondaryButton("Geri", { vm.back() })
    }
}

/** Kilitsiz açılan belgede (sunucuya ulaşılamadı) küçük uyarı. */
@Composable
fun DocUnlockedNotice(vm: AppVm) {
    if (vm.docLock.state == LockState.UNLOCKED && vm.docLock.message.isNotBlank()) {
        Notice(vm.docLock.message, Tone.Warn, icon = Ic.Lock)
    }
}

/** Liste ekranı açıkken başka terminallerin tuttuğu belgeleri 10 sn'de bir yeniler. */
@Composable
fun LocksPoller(vm: AppVm) {
    LaunchedEffect(Unit) {
        while (true) {
            vm.refreshLocks()
            delay(10_000)
        }
    }
}

/** Liste kartında "🔒 Ahmet (TRM-03) kullanıyor" satırı; belge kilitli değilse hiçbir şey çizmez. */
@Composable
fun LockTag(vm: AppVm, docId: String) {
    val l = vm.locks[docId] ?: return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Ic.Lock, null, tint = C.Warn, modifier = Modifier.size(14.dp))
        Text("${l.user.ifBlank { "Başka kullanıcı" }} (${l.device}) kullanıyor", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = C.Warn)
    }
}
