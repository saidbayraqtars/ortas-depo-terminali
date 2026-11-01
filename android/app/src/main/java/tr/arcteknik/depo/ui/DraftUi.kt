package tr.arcteknik.depo.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import tr.arcteknik.depo.data.DraftInfo
import tr.arcteknik.depo.data.Repo.Companion.fmt
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/*
 * Belgeyi yarım bırakma. Rafa Kaldır (belge içi), Gönderim Kabul ve Depoya Gönder'de okutulanlar her değişiklikte cihazdaki
 * `doc_draft` tablosuna yazılır; belgeden çıkınca, uygulama kapanınca, terminal yeniden başlayınca ya da başka kullanıcı girince
 * kaybolmaz, belgeye dönülünce kaldığı yerden devam edilir. Taslak Vega'ya ve sunucuya hiçbir şey yazmaz: okutulanlar ancak
 * "Rafa kaldır" / "Kısmi kaydet" / "Kabulü bitir" / "Gönder" ile işlenir. Belge listeleri yarım bırakılanları "yarım" etiketiyle gösterir.
 */

/** Belgeyi yarım bırakmaya hazır olduğunu söyleyen ortak metin (çıkış penceresi ve ipuçları). */
const val HALF_HINT = "Okutulanlar bu terminalde saklanır, belgeye dönünce devam edersiniz. Vega'ya yazılmaz."

/** Taslağın son değişiklik zamanı: bugünse "17:40", değilse "31.10 17:40". */
fun draftWhen(at: Long): String {
    val now = Calendar.getInstance()
    val then = Calendar.getInstance().apply { timeInMillis = at }
    val today = now.get(Calendar.YEAR) == then.get(Calendar.YEAR) && now.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR)
    return SimpleDateFormat(if (today) "HH:mm" else "dd.MM HH:mm", Locale("tr")).format(Date(at))
}

/** Liste kartındaki "yarım" satırı: "Yarım · 12 adet okutuldu · Ahmet · 31.10 17:40". */
fun draftLine(i: DraftInfo): String =
    "Yarım · ${fmt(i.qty)} adet okutuldu" + (i.user.takeIf { it.isNotBlank() }?.let { " · $it" } ?: "") + " · ${draftWhen(i.at)}"

/** Belgeye yarım bırakılmış okutmayla girilince tek satırlık not (küçük ekranda yer tutmasın): "Yarım kalan iş geri yüklendi · 17:40". */
fun draftRestored(i: DraftInfo): String =
    "Yarım kalan iş geri yüklendi · ${draftWhen(i.at)}"

/**
 * Belge ekranının okutulanlarını izler ve her değişiklikte [save] ile cihaza yazar; ekrandan çıkarken de bir kez yazar
 * (aynı karede olan son değişiklik kaybolmasın). [watch] kaydedilecek durumu okuyan bir ifadedir (örn. `{ draft.toList() }`),
 * değişince [save] çağrılır; [save] yazılacak şey kalmadıysa taslağı silmelidir.
 */
@Composable
fun DraftSaver(watch: () -> Any?, save: () -> Unit) {
    val current = rememberUpdatedState(save)
    LaunchedEffect(Unit) { snapshotFlow(watch).collect { current.value() } }
    DisposableEffect(Unit) { onDispose { current.value() } }
}

/**
 * Belgeden okutulanlarla çıkarken sorulur. Birincil seçenek [onHalf] belgeyi yarım bırakır (okutulanlar saklanır, hiçbir şey
 * işlenmez); [onCommit] okutulanları işler, [onDiscard] atar, [onStay] belgede kalır. Düğmeler odak almaz: el terminalinin
 * okuyucusu Enter gönderir, sonraki okutma kendiliğinden bir seçeneğe basmasın.
 */
@Composable
fun LeaveDocDialog(
    title: String,
    text: String,
    onHalf: () -> Unit,
    commitLabel: String,
    onCommit: () -> Unit,
    discardLabel: String,
    onDiscard: () -> Unit,
    onStay: () -> Unit,
) {
    val noFocus = Modifier.fillMaxWidth().focusProperties { canFocus = false }
    Dialog(onDismissRequest = onStay) {
        // Küçük ekranda (480x800) pencere ekranı doldurur; taşan kısım kaydırılır, alt seçenekler kırpılmaz.
        Column(
            Modifier.clip(RoundedCornerShape(20.dp)).background(C.Surface).verticalScroll(rememberScrollState()).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Text(text, color = C.Text2, fontSize = 14.sp)
            PrimaryButton("Yarım bırak", onHalf, noFocus)
            Hint(HALF_HINT)
            SecondaryButton(commitLabel, onCommit, noFocus)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    discardLabel, Modifier.weight(1f).focusProperties { canFocus = false }.clickable(onClick = onDiscard).padding(12.dp),
                    textAlign = TextAlign.Center, fontWeight = FontWeight.SemiBold, color = C.Err,
                )
                Text(
                    "Belgede kal", Modifier.weight(1f).focusProperties { canFocus = false }.clickable(onClick = onStay).padding(12.dp),
                    textAlign = TextAlign.Center, fontWeight = FontWeight.SemiBold, color = C.Text2,
                )
            }
        }
    }
}
