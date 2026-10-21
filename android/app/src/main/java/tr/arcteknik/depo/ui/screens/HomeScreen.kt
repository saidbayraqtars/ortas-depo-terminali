package tr.arcteknik.depo.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import tr.arcteknik.depo.BuildConfig
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.openUrl
import tr.arcteknik.depo.ui.Badge
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.Hint
import tr.arcteknik.depo.ui.Ic
import tr.arcteknik.depo.ui.MessageBar
import tr.arcteknik.depo.ui.NetPill
import tr.arcteknik.depo.ui.Route
import tr.arcteknik.depo.ui.ProductScanField
import java.text.SimpleDateFormat
import java.util.Locale

@Composable
fun HomeScreen(vm: AppVm, online: Boolean, version: Int) {
    val db = vm.repo.db
    val openReceipts = remember(version) { db.receipts(true).size }
    val openCounts = remember(version) { db.countSessions().size }
    val pending = remember(version) { db.pendingOpCount() }
    val lastSync = vm.repo.prefs.lastSync

    Column(Modifier.fillMaxSize().background(C.Ground)) {
        Row(
            Modifier.fillMaxWidth().height(64.dp).background(C.Bar).padding(start = 12.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(C.Accent), contentAlignment = Alignment.Center) {
                Text(vm.user?.name?.take(1)?.uppercase() ?: "?", color = C.Bar, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            }
            Column(Modifier.weight(1f)) {
                Text(vm.user?.name ?: "", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                Text(vm.repo.prefs.warehouse, color = C.BarSub, fontSize = 12.sp)
            }
            NetPill(online)
            IconButton(onClick = { vm.logout() }, modifier = Modifier.size(48.dp)) {
                Icon(Ic.Logout, contentDescription = "Çıkış yap", tint = Color.White, modifier = Modifier.size(22.dp))
            }
        }

        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ProductScanField(
                vm,
                title = "Barkod okutun",
                hint = "Ürün ya da raf, ne okutursanız açılır",
                onProduct = { vm.go(Route.ProductQuery(it.code)) },
                onOther = { code -> db.shelfExists(code).also { if (it) vm.go(Route.ShelfQuery(code.uppercase())) } },
            )
            MessageBar(vm.message?.first, vm.message?.second == true)
            vm.repo.prefs.updateUrl(BuildConfig.VERSION_CODE)?.let { link ->
                val context = LocalContext.current
                Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.InfoBg).border(1.dp, C.Info, RoundedCornerShape(10.dp))
                    .clickable { openUrl(context, link) }.padding(14.dp)) {
                    Text("Yeni sürüm ${vm.repo.prefs.updateName} hazır · indirmek için dokunun", color = C.InfoText, fontWeight = FontWeight.SemiBold)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Tile("Rafa Kaldır", "Kabul edilen mal", Ic.Inbox, openReceipts, Modifier.weight(1f)) { vm.go(Route.Receipts) }
                Tile("Raf Transferi", "Raftan rafa taşı", Ic.Transfer, 0, Modifier.weight(1f)) { vm.go(Route.Transfer()) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Tile("Ürün Sorgu", "Hangi rafta, kaç adet", Ic.Search, 0, Modifier.weight(1f)) { vm.go(Route.ProductQuery()) }
                Tile("Raf Sorgu", "Rafta neler var", Ic.Pin, 0, Modifier.weight(1f)) { vm.go(Route.ShelfQuery()) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Tile("Sayım", "Raf ya da tam sayım", Ic.Clipboard, openCounts, Modifier.weight(1f)) { vm.go(Route.Counts) }
                Tile("Kuyruk", "Bekleyen işlemler", Ic.CloudUp, pending, Modifier.weight(1f)) { vm.go(Route.Queue) }
            }
        }

        Row(
            Modifier.fillMaxWidth().height(44.dp).background(C.Surface).border(1.dp, C.Line).padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Hint(if (lastSync > 0) "Son eşitleme " + SimpleDateFormat("dd.MM · HH:mm", Locale("tr")).format(lastSync) else "Eşitleme yapılmadı")
            Hint(if (pending == 0) "Kuyruk boş" else "$pending işlem bekliyor")
        }
    }
}

@Composable
private fun Tile(title: String, sub: String, icon: ImageVector, badge: Int, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Box(modifier.heightIn(min = 104.dp).clip(shape).background(C.Surface).border(1.dp, C.Line, shape).clickable(onClick = onClick).padding(14.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(C.Bar), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = C.Accent, modifier = Modifier.size(22.dp))
            }
            Column {
                Text(title, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1)
                Text(sub, color = C.Muted, fontSize = 12.sp, maxLines = 1)
            }
        }
        if (badge > 0) Badge(badge, Modifier.align(Alignment.TopEnd))
    }
}
