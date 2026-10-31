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
import tr.arcteknik.depo.data.Perm
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.DepotDialog
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
    // Kullanıcının çalışamayacağı depoların belge ve sayımları sayılmaz (yetki: yönetici programı Kullanıcılar).
    val openReceipts = remember(version, vm.user) { db.receipts(true).count { vm.canDepot(it.depot) } }
    val openCounts = remember(version, vm.user) { db.countSessions().count { vm.canDepot(it.depot) } }
    val pending = remember(version) { db.pendingOpCount() }
    val transfer = remember(version) { vm.repo.transferInfo() }
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
            val depots = remember(version, vm.user) { vm.depots() }
            var pickDepot by remember { mutableStateOf(false) }
            Column(Modifier.weight(1f).clickable(enabled = depots.size > 1) { pickDepot = true }) {
                Text(vm.user?.name ?: "", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                // Çalışılan depo: transfer, sayım ve sorgu bu depoda. Dokununca değişir.
                Text(remember(version) { vm.repo.depotName() } + if (depots.size > 1) "  ▾" else "", color = C.BarSub, fontSize = 12.sp)
            }
            if (pickDepot) {
                DepotDialog(depots, vm.repo.db.depot, { vm.repo.selectDepot(it); pickDepot = false; vm.ok("Çalışılan depo: ${vm.repo.depotName()}") }, { pickDepot = false })
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
            // Kullanıcının yetkisi olmayan işlemlerin kartı görünmez; boşalan yer yanındaki kartla dolar. Sorgu ve kuyruk herkese açık.
            val tiles = buildList<@Composable (Modifier) -> Unit> {
                if (vm.can(Perm.PUTAWAY)) add { m -> Tile("Rafa Kaldır", "Kabul edilen mal", Ic.Inbox, openReceipts, m) { vm.go(Route.Receipts) } }
                if (vm.can(Perm.PICK)) add { m -> Tile("Raftan Al", "Raftaki malı eksilt", Ic.Outbox, 0, m) { vm.go(Route.Pick) } }
                if (vm.can(Perm.TRANSFER)) add { m -> Tile("Raf Transferi", "Raftan rafa taşı", Ic.Transfer, 0, m) { vm.go(Route.Transfer()) } }
                // Rafta duran malı rafa tanımlar (sayımla aynı mantık, "sayım" adı geçmez; onay beklemez, Vega'ya yazılmaz).
                if (vm.can(Perm.SHELF_ARRANGE)) add { m -> Tile("Raf Düzenle", "Rafa mal tanımla", Ic.Layers, 0, m) {
                    if (vm.canDepot(db.depot)) vm.go(Route.Count(vm.repo.startArrange().id)) else vm.error("Bu depoda işlem yapma yetkiniz yok")
                } }
                if (vm.can(Perm.COUNT) || vm.can(Perm.COUNT_FREE)) add { m -> Tile("Sayım", "Raf ya da tam sayım", Ic.Clipboard, openCounts, m) { vm.go(Route.Counts) } }
                add { m -> Tile("Ürün Sorgu", "Hangi rafta, kaç adet", Ic.Search, 0, m) { vm.go(Route.ProductQuery()) } }
                add { m -> Tile("Raf Sorgu", "Rafta neler var", Ic.Pin, 0, m) { vm.go(Route.ShelfQuery()) } }
                if (transfer.on) {
                    val waiting = transfer.incoming.count { it.to == db.depot && vm.canDepot(it.to) }
                    if (vm.can(Perm.DEPOT_SEND)) add { m -> Tile("Depoya Gönder", "Başka depoya mal", Ic.Truck, 0, m) { vm.go(Route.SendDepot) } }
                    if (vm.can(Perm.DEPOT_RECEIVE)) add { m -> Tile("Gönderim Kabul", "Gelen mal", Ic.Inbox, waiting, m) { vm.go(Route.ReceiveList) } }
                }
                add { m -> Tile("Kuyruk", "Bekleyen işlemler", Ic.CloudUp, pending, m) { vm.go(Route.Queue) } }
            }
            tiles.chunked(2).forEach { pair ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    pair.forEach { tile -> tile(Modifier.weight(1f)) }
                    if (pair.size == 1) Box(Modifier.weight(1f))
                }
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
