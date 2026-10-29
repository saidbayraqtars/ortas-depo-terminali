package tr.arcteknik.depo.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * Okutma "sepet" mantığının ortak parçaları (Rafa Kaldır, Raftan Al, Raf Transferi): ürün okutulunca adet sorulmaz, ürün
 * listeye girer; aynı ürün tekrar okutulunca adet 1 artar, arada başka ürün okutulabilir. Beklenen miktar aşılırsa okutma
 * engellenmez (sesli ve görüntülü uyarı verilir, işlem sonunda ayrıca uyarılır).
 */

/** Sepetteki bir satır: [productId] ürününün [shelf] rafındaki adedi. */
data class CartLine(val productId: String, val shelf: String, val qty: Double)

/** ([productId], [shelf]) satırını 1 artırır ve listenin sonuna (en yeni) taşır; yeni adedi döner. */
fun MutableList<CartLine>.bump(productId: String, shelf: String): Double {
    val n = cartQty(productId, shelf) + 1
    removeAll { it.productId == productId && it.shelf == shelf }
    add(CartLine(productId, shelf, n))
    return n
}

/** Satırın adedini 1 azaltır (0 olunca satır silinir). */
fun MutableList<CartLine>.undo(productId: String, shelf: String) {
    val i = indexOfFirst { it.productId == productId && it.shelf == shelf }
    if (i < 0) return
    val q = this[i].qty - 1
    if (q <= 1e-9) removeAt(i) else this[i] = this[i].copy(qty = q)
}

/** [productId]'nin sepetteki adedi; [shelf] verilirse yalnız o rafınki. */
fun List<CartLine>.cartQty(productId: String, shelf: String? = null): Double =
    filter { it.productId == productId && (shelf == null || it.shelf == shelf) }.sumOf { it.qty }

/** Listede gösterilecek satır. [count] adet metni, [highlight] son okutulan satırın zemini. */
class BasketRow(
    val key: String,
    val name: String,
    val detail: String,
    val count: String,
    val countColor: Color,
    val highlight: Color = Color.Transparent,
    val onUndo: (() -> Unit)? = null,
    val onTap: (() -> Unit)? = null,
)

/** Sepet başlığındaki küçük bağlantı ("Sıfırla" gibi). */
@Composable
fun BasketLink(text: String, color: Color = C.Info, onClick: () -> Unit) {
    Text(
        text, color = color, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
        modifier = Modifier.focusProperties { canFocus = false }.clickable(onClick = onClick).padding(10.dp),
    )
}

/** Satırdaki son okutmayı geri alır (adet girmek yerine tek adım geri). */
@Composable
fun UndoButton(onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        Modifier.size(40.dp).clip(shape).border(1.5.dp, C.Bar, shape).focusProperties { canFocus = false }.clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(Ic.Minus, contentDescription = "Bir adet geri al", tint = C.Ink, modifier = Modifier.size(20.dp)) }
}

/**
 * Üstte sabit [header], altında kendi kaydırmasında satırlar. Anahtarlı liste başa eklenen satırda eski konumunu
 * korur; [scrollKey] değişince (her okutma, sekme değişimi) en başa dönülür ki son okutulan görünsün. Ekran `scroll = false`
 * olmalı; [modifier] `weight(1f)` içermelidir.
 */
@Composable
fun BasketBox(
    rows: List<BasketRow>,
    scrollKey: Any,
    emptyHint: String,
    modifier: Modifier = Modifier,
    tail: (@Composable () -> Unit)? = null,
    header: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    Column(modifier.fillMaxWidth().clip(shape).background(C.Surface).border(1.dp, C.Line, shape)) {
        Column(Modifier.padding(start = 14.dp, end = 8.dp, top = 8.dp), content = header)
        if (rows.isEmpty()) Hint(emptyHint, Modifier.padding(start = 14.dp, end = 14.dp, bottom = 10.dp, top = 4.dp))
        val listState = rememberLazyListState()
        LaunchedEffect(scrollKey) { listState.scrollToItem(0) }
        LazyColumn(Modifier.weight(1f).padding(start = 14.dp, end = 8.dp), state = listState) {
            items(rows, key = { it.key }) { r ->
                Divider()
                Row(
                    Modifier.fillMaxWidth().background(r.highlight).let { m -> if (r.onTap != null) m.clickable(onClick = r.onTap) else m }.padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(r.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                        if (r.detail.isNotBlank()) Text(r.detail, fontSize = 12.sp, color = C.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    MonoText(r.count, size = 18, color = r.countColor)
                    if (r.onUndo != null) UndoButton(r.onUndo)
                }
            }
            if (tail != null) item { tail() }
        }
    }
}
