package tr.arcteknik.depo.ui

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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.withContext
import tr.arcteknik.depo.data.Product
import tr.arcteknik.depo.data.Repo.Companion.fmt
import tr.arcteknik.depo.diag.Diag
import tr.arcteknik.depo.scan.ScanBus

/**
 * Barkodu okunmayan ya da etiketi olmayan ürün için: adın bir kısmını yazınca benzer adlar listelenir
 * (yazım hatası, Türkçe harf farkı tolere edilir).
 */
@Composable
fun ProductSearchDialog(
    vm: AppVm,
    initial: String,
    note: String?,
    onPick: (Product) -> Unit,
    onDismiss: () -> Unit,
    /**
     * Pencere açıkken gelen okutma (yayın modundaki okuyucu). Altındaki okutma alanı pasif olduğundan okutmayı bu pencere alır:
     * true dönerse okutma işlendi (pencere kapanır), false dönerse okunan metin arama kutusuna yazılır.
     */
    onScan: ((String) -> Boolean)? = null,
) {
    var q by remember { mutableStateOf(TextFieldValue(initial, TextRange(initial.length))) }
    var results by remember { mutableStateOf<List<Product>?>(null) }
    var searching by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val scanHandler by rememberUpdatedState(onScan)

    LaunchedEffect(Unit) {
        Diag.crumb("isimle ara açıldı" + if (initial.isNotEmpty()) ": $initial" else "")
        runCatching { focus.requestFocus() }
        delay(150)
        keyboard?.show()
    }
    // Okutma alanı pencere açıkken pasif: yayın modundaki okuyucunun okuması burada karşılanmazsa sessizce kaybolur ve ekran "takılı" kalır.
    LaunchedEffect(Unit) {
        ScanBus.scans.collect { code ->
            if (scanHandler?.invoke(code) != true) {
                vm.feedback.error()
                q = TextFieldValue(code, TextRange(code.length))
            }
        }
    }
    LaunchedEffect(q.text) {
        if (q.text.isBlank()) {
            results = null
            searching = false
            return@LaunchedEffect
        }
        delay(250)
        // Yavaş terminalde (Sunmi L2K, 130 bin ürün) arama 3 sn sürüyor; sonuç gelene kadar bir şey olmadığı sanılmasın.
        searching = true
        results = withContext(Dispatchers.Default) { val ctx = coroutineContext; vm.repo.db.searchProducts(q.text, cancelled = { !ctx.isActive }) }
        searching = false
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(C.Ground).imePadding()) {
            Row(
                Modifier.fillMaxWidth().height(56.dp).background(C.Bar).padding(start = 4.dp, end = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Geri oku öbür ekranlardaki gibi solda; odak almaz (okuyucunun Enter'ı ona basmasın, bkz. TopBar).
                IconButton(onClick = onDismiss, modifier = Modifier.size(48.dp).focusProperties { canFocus = false }) {
                    Icon(Ic.Back, contentDescription = "Geri", tint = Color.White, modifier = Modifier.size(22.dp))
                }
                Text("İsimle ara", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.weight(1f))
            }
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (note != null) Notice(note, Tone.Warn)
                Row(
                    Modifier.fillMaxWidth().height(54.dp).clip(RoundedCornerShape(10.dp)).background(C.Surface)
                        .border(2.dp, C.Accent, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Icon(Ic.Search, null, tint = C.Muted, modifier = Modifier.size(22.dp))
                    Box(Modifier.weight(1f)) {
                        if (q.text.isEmpty()) Text("Ürün adı ya da kodu (örnek: yağ filtre)", color = C.Muted)
                        BasicTextField(
                            value = q,
                            onValueChange = { q = it },
                            singleLine = true,
                            textStyle = TextStyle(fontFamily = Sans, fontSize = 17.sp, color = C.Ink),
                            cursorBrush = SolidColor(C.Ink),
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Search),
                            // Klavye modundaki okuyucu kodu yazıp Enter basar: tam barkod/kod eşleşirse ürün seçilir.
                            keyboardActions = KeyboardActions(onSearch = {
                                vm.repo.db.findProduct(ScanBus.clean(q.text))?.let { keyboard?.hide(); onPick(it) }
                            }),
                            modifier = Modifier.fillMaxWidth().focusRequester(focus),
                        )
                    }
                }
                val r = results
                when {
                    searching -> Hint("Aranıyor…")
                    r == null -> Hint("Adın bir kısmını yazın. Birkaç kelime yazılabilir; harf hatası olsa da yakın adlar çıkar.")
                    r.isEmpty() -> Hint("Benzer ad bulunamadı. Daha kısa ya da farklı bir kelime deneyin.")
                    else -> Hint("${r.size} sonuç" + if (r.size >= 40) " (ilk 40)" else "")
                }
            }
            LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(results.orEmpty(), key = { it.id }) { p ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.Surface).border(1.dp, C.Line, RoundedCornerShape(10.dp))
                            .clickable { keyboard?.hide(); onPick(p) }.padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(p.name, fontWeight = FontWeight.SemiBold, maxLines = 2)
                            MonoText(p.code, size = 12, weight = FontWeight.Medium, color = C.Muted)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            MonoText(fmt(p.vegaStock), size = 15)
                            Text(p.unit.lowercase(), fontSize = 11.sp, color = C.Muted)
                        }
                    }
                }
            }
        }
    }
}

/**
 * Ürün okutma alanı + "İsimle ara". Okunan kod ürün değilse önce [onOther] denenir (örneğin raf);
 * o da değilse kod isim gibi aranır ve benzer ürünler listelenir.
 */
@Composable
fun ProductScanField(
    vm: AppVm,
    title: String,
    hint: String,
    onProduct: (Product) -> Unit,
    onOther: ((String) -> Boolean)? = null,
    /** Alana yazılıp henüz gönderilmemiş metin (Rafa Kaldır listesi yazarken süzülür). */
    onTextChange: ((String) -> Unit)? = null,
    /** Alttaki "İsimle ara" bağlantısı; küçük ekranda yer açmak için kapatılabilir (klavye düğmesiyle yazılan ad yine aranır). */
    showSearchLink: Boolean = true,
) {
    var search by remember { mutableStateOf<Pair<String, String?>?>(null) }
    // Okunan kod ürünse [onProduct], "diğer" (raf, belge) ise [onOther] işler; ikisi de değilse false.
    fun route(code: String): Boolean {
        val p = vm.repo.db.findProduct(code)
        return when {
            p != null -> { onProduct(p); true }
            else -> onOther?.invoke(code) == true
        }
    }
    ScanField(title, hint, search == null, vm.repo.prefs.cameraButton, onTextChange = onTextChange, onScan = { code ->
        when {
            route(code) -> Unit
            // Sırf rakamsa okutulan barkoddur; isimde aramanın anlamı yok.
            code.all { it.isDigit() } -> vm.error("\"$code\" barkodu tanımlı değil. İsimle arayabilirsiniz.")
            else -> { vm.feedback.error(); search = code to "\"$code\" kod ya da barkod olarak bulunamadı. Benzer adlar:" }
        }
    })
    if (showSearchLink) {
        Text(
            "İsimle ara",
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { search = "" to null }.padding(vertical = 8.dp),
            color = C.Info, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
    search?.let { (initial, note) ->
        ProductSearchDialog(
            vm, initial, note,
            onPick = { search = null; onProduct(it) },
            onDismiss = { search = null },
            // Pencere açıkken okutulan ürün/raf/belge yine işlenir; tanınmayan kod arama kutusuna yazılır.
            onScan = { code -> route(code).also { if (it) search = null } },
        )
    }
}

/** Tarayıcıda açar (yeni APK indirme). Tarayıcı yoksa sessizce geçer. */
fun openUrl(context: android.content.Context, url: String) {
    runCatching {
        context.startActivity(
            android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
/** Etiket adedi sorulur; "Bas" ile sunucudaki etiket yazıcısına gider. */
@Composable
fun LabelDialog(title: String, sub: String, onPrint: (Int) -> Unit, onDismiss: () -> Unit) {
    var copies by remember { mutableStateOf(1.0) }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(sub, color = C.Muted, fontSize = 14.sp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Adet", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    QtyStepper(copies, { copies = it.coerceIn(1.0, 100.0) }, max = 100.0, small = true)
                }
                Hint("Etiket, yönetici programının kurulu olduğu bilgisayardaki etiket yazıcısından çıkar.")
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = { onPrint(copies.toInt().coerceAtLeast(1)) }) { Text("Bas") } },
        dismissButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Vazgeç") } },
    )
}
/** Çalışılan depoyu seçme. Mal kabul belgeleri her depodan görünür; transfer, sayım ve sorgu seçili depoda. */
@Composable
fun DepotDialog(
    depots: List<tr.arcteknik.depo.data.Depot>,
    current: Int,
    onPick: (Int) -> Unit,
    onDismiss: () -> Unit,
    title: String = "Çalışılan depo",
    note: String? = "Raf transferi, sayım ve sorgu seçilen depoda yapılır. Rafa kaldırma her zaman belgenin deposunda.",
) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            // Hedef depo listesi 15 depoyu bulabilir (Ortaş); sığmazsa kayar.
            Column(Modifier.verticalScroll(androidx.compose.foundation.rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (note != null) Hint(note)
                depots.forEach { d ->
                    val on = d.id == current
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (on) C.AccentBg else C.Surface)
                            .border(if (on) 2.dp else 1.dp, if (on) C.Accent else C.Line, RoundedCornerShape(10.dp))
                            .clickable { onPick(d.id) }.padding(horizontal = 14.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(d.name, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium, modifier = Modifier.weight(1f))
                        if (on) Icon(Ic.Check, null, tint = C.Ink, modifier = Modifier.size(20.dp))
                    }
                }
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Kapat") } },
    )
}