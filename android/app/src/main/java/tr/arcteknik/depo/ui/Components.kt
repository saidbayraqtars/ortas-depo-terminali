package tr.arcteknik.depo.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay
import tr.arcteknik.depo.data.Repo
import tr.arcteknik.depo.scan.CameraScanner
import tr.arcteknik.depo.scan.ScanBus

// ---- Ekran iskeleti ------------------------------------------------------------------------

@Composable
fun Screen(
    title: String,
    sub: String? = null,
    online: Boolean,
    onBack: (() -> Unit)?,
    monoTitle: Boolean = false,
    footer: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().background(C.Ground)) {
        TopBar(title, sub, online, onBack, monoTitle)
        Column(
            Modifier.weight(1f).fillMaxWidth().padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            content = content,
        )
        if (footer != null) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(C.Line))
            Column(
                Modifier.fillMaxWidth().background(C.Surface).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                content = footer,
            )
        }
    }
}

@Composable
fun TopBar(title: String, sub: String?, online: Boolean, onBack: (() -> Unit)?, monoTitle: Boolean = false, trailing: @Composable RowScope.() -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().height(56.dp).background(C.Bar).padding(start = if (onBack != null) 4.dp else 16.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
                Icon(Ic.Back, contentDescription = "Geri", tint = Color.White, modifier = Modifier.size(22.dp))
            }
        }
        Column(Modifier.weight(1f)) {
            Text(
                title, color = Color.White, fontSize = if (sub == null) 17.sp else 16.sp, fontWeight = FontWeight.SemiBold,
                fontFamily = if (monoTitle) Mono else Sans, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            if (sub != null) Text(sub, color = C.BarSub, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        NetPill(online)
        trailing()
    }
}

@Composable
fun NetPill(online: Boolean) {
    val bg = if (online) C.OnlineBg else C.OfflineBg
    val fg = if (online) C.OnlineText else C.OfflineText
    Row(
        Modifier.clip(RoundedCornerShape(14.dp)).background(bg).height(28.dp).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(fg))
        Text(if (online) "Çevrimiçi" else "Çevrimdışı", color = fg, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ---- Kutular ve düğmeler -------------------------------------------------------------------

@Composable
fun Card(
    modifier: Modifier = Modifier,
    bg: Color = C.Surface,
    border: Color = C.Line,
    borderWidth: Dp = 1.dp,
    padding: PaddingValues = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    var m = modifier.fillMaxWidth().clip(shape).background(bg).border(borderWidth, border, shape)
    if (onClick != null) m = m.clickable(onClick = onClick)
    Column(m.padding(padding), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier.fillMaxWidth(), enabled: Boolean = true) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier.heightIn(min = 52.dp).clip(shape).background(if (enabled) C.Accent else C.Disabled)
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = if (enabled) C.Ink else C.DisabledText, fontWeight = FontWeight.Bold, fontSize = 16.sp, textAlign = TextAlign.Center)
    }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier.fillMaxWidth(), icon: ImageVector? = null, dark: Boolean = false, enabled: Boolean = true) {
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier.heightIn(min = 48.dp).clip(shape).background(if (dark) C.Bar else C.Surface)
            .border(BorderStroke(1.5.dp, if (dark) Color.White else C.Bar), shape)
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val fg = if (dark) Color.White else C.Ink
        if (icon != null) {
            Icon(icon, null, tint = fg, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, color = fg, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, textAlign = TextAlign.Center)
    }
}

@Composable
fun Caption(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(java.util.Locale("tr")), modifier, color = C.Muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.4.sp)
}

@Composable
fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, color = C.Muted, fontSize = 12.sp)
}

@Composable
fun Divider() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(C.LineSoft))
}

@Composable
fun Badge(n: Int, modifier: Modifier = Modifier) {
    Box(
        modifier.widthIn(min = 26.dp).height(26.dp).clip(RoundedCornerShape(13.dp)).background(C.Accent).padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) { Text("$n", fontSize = 13.sp, fontWeight = FontWeight.Bold) }
}

enum class Tone { Ok, Warn, Err, Info }

@Composable
fun Notice(text: String, tone: Tone, title: String? = null, icon: ImageVector? = null) {
    val (bg, fg, br) = when (tone) {
        Tone.Ok -> Triple(C.OkBg, C.OkText, C.Ok)
        Tone.Warn -> Triple(C.WarnBg, C.WarnText, C.Warn)
        Tone.Err -> Triple(C.ErrBg, C.Err, C.Err)
        Tone.Info -> Triple(C.InfoBg, C.InfoText, C.InfoBg)
    }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(bg).border(1.5.dp, br, RoundedCornerShape(10.dp)).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = br, modifier = Modifier.size(24.dp))
        Column {
            if (title != null) Text(title, color = fg, fontWeight = FontWeight.Bold)
            Text(text, color = fg, fontSize = 13.sp)
        }
    }
}

@Composable
fun MonoText(text: String, size: Int = 15, weight: FontWeight = FontWeight.SemiBold, color: Color = C.Ink, modifier: Modifier = Modifier) {
    Text(text, modifier, fontFamily = Mono, fontSize = size.sp, fontWeight = weight, color = color, maxLines = 1)
}

/** Sağda değer, solda etiket; ürün kartlarındaki "Kabul / Rafta / Kalan" gibi. */
@Composable
fun Num(label: String, value: String, color: Color = C.Ink, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, color = C.Muted, fontSize = 12.sp)
        Text(value, color = color, fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
}

// ---- Okutma alanı --------------------------------------------------------------------------

/**
 * Okutma alanı. Odakta durur; klavye modundaki okuyucu buraya yazar ve Enter ile gönderir.
 * [active] olan alan yayın modundaki okumaları da alır. Ekranda aynı anda tek alan aktif olmalı.
 */
@Composable
fun ScanField(
    title: String,
    hint: String,
    active: Boolean,
    cameraButton: Boolean,
    onScan: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var text by remember { mutableStateOf("") }
    var camera by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val handler by rememberUpdatedState(onScan)

    fun submit(v: String) {
        val c = v.trim()
        text = ""
        if (c.isNotEmpty()) handler(c)
    }

    if (active) {
        LaunchedEffect(Unit) {
            runCatching { focus.requestFocus() }
            // Önceki ekranın klavyesi odak değişince yeniden açılabiliyor; oturduktan sonra kapat.
            repeat(3) {
                delay(150)
                keyboard?.hide()
            }
        }
        LaunchedEffect(Unit) { ScanBus.scans.collect { handler(it) } }
    }

    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier.fillMaxWidth().heightIn(min = 60.dp).clip(shape)
            .background(if (active) C.AccentBg else C.Surface)
            .border(2.dp, if (active) C.Accent else C.Field, shape)
            .padding(start = 14.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Ic.Barcode, null, tint = C.Ink, modifier = Modifier.size(24.dp))
        Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
            if (text.isEmpty()) {
                Column {
                    Text(title, fontWeight = FontWeight.SemiBold)
                    Hint(hint)
                }
            }
            BasicTextField(
                value = text,
                onValueChange = { v ->
                    if (v.contains('\n') || v.contains('\r')) submit(v.substringBefore('\n').substringBefore('\r')) else text = v
                },
                singleLine = true,
                textStyle = TextStyle(fontFamily = Mono, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = C.Ink),
                cursorBrush = SolidColor(C.Ink),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done, keyboardType = KeyboardType.Ascii, showKeyboardOnFocus = false),
                keyboardActions = KeyboardActions(onDone = { submit(text) }),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).onPreviewKeyEvent { e ->
                    if ((e.key == Key.Enter || e.key == Key.NumPadEnter) && e.type == KeyEventType.KeyUp) {
                        submit(text); true
                    } else e.key == Key.Enter || e.key == Key.NumPadEnter
                },
            )
        }
        IconButton(onClick = { runCatching { focus.requestFocus() }; keyboard?.show() }, modifier = Modifier.size(44.dp)) {
            Icon(Ic.Keyboard, contentDescription = "Elle yaz", tint = C.Text2, modifier = Modifier.size(22.dp))
        }
        if (cameraButton) {
            IconButton(onClick = { camera = true }, modifier = Modifier.size(44.dp)) {
                Icon(Ic.Camera, contentDescription = "Kamerayla okut", tint = C.Text2, modifier = Modifier.size(22.dp))
            }
        }
    }

    if (camera) {
        Dialog(onDismissRequest = { camera = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            CameraScanner(onResult = { camera = false; handler(it) }, onClose = { camera = false })
        }
    }
}

// ---- Miktar --------------------------------------------------------------------------------

@Composable
fun QtyStepper(value: Double, onChange: (Double) -> Unit, max: Double? = null, small: Boolean = false) {
    val box = if (small) 44.dp else 52.dp
    var text by remember(value) { mutableStateOf(Repo.fmt(value)) }
    // Okutma alanı ekrandan kalkınca Android 8 odağı bu alana verip sayı klavyesini açıyordu.
    // Alan ancak dokununca odak alabilir; miktar çoğunlukla +/- ile girilir.
    var editing by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(editing) {
        if (editing) {
            runCatching { focus.requestFocus() }
            keyboard?.show()
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (small) 6.dp else 10.dp)) {
        StepButton(Ic.Minus, "Azalt", box) { onChange((value - 1).coerceAtLeast(0.0)) }
        Box {
        BasicTextField(
            value = text,
            onValueChange = { v ->
                val clean = v.replace(',', '.').filter { it.isDigit() || it == '.' }
                text = clean
                clean.toDoubleOrNull()?.let { onChange(if (max != null) it.coerceAtMost(max) else it) }
            },
            singleLine = true,
            textStyle = TextStyle(fontFamily = Mono, fontSize = if (small) 18.sp else 22.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, color = C.Ink),
            // Okutma alanı kaybolunca odak buraya kayıyor; klavye yalnız dokununca açılsın.
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done, showKeyboardOnFocus = false),
            modifier = Modifier.width(if (small) 48.dp else 72.dp).height(box).clip(RoundedCornerShape(10.dp))
                .background(if (small) C.Surface else C.AccentBg)
                .border(2.dp, if (small) C.Surface else C.Accent, RoundedCornerShape(10.dp))
                .focusProperties { canFocus = editing }
                .focusRequester(focus)
                .onFocusChanged { if (!it.isFocused && editing) editing = false }
                .padding(top = if (small) 10.dp else 12.dp),
        )
        if (!editing) {
            Box(Modifier.matchParentSize().clickable { editing = true })
        }
        }
        StepButton(Ic.Plus, "Artır", box) { onChange(if (max != null) (value + 1).coerceAtMost(max) else value + 1) }
    }
}

@Composable
private fun StepButton(icon: ImageVector, label: String, size: Dp, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        Modifier.size(size).clip(shape).background(C.Surface).border(1.5.dp, C.Bar, shape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription = label, tint = C.Ink, modifier = Modifier.size(22.dp)) }
}

/** Ekranın altında kısa süre görünen bilgi/hata satırı. */
@Composable
fun MessageBar(text: String?, error: Boolean) {
    if (text == null) return
    Box(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (error) C.ErrBg else C.OkBg)
            .border(1.5.dp, if (error) C.Err else C.Ok, RoundedCornerShape(10.dp)).padding(12.dp),
    ) { Text(text, color = if (error) C.Err else C.OkText, fontWeight = FontWeight.SemiBold, fontSize = 14.sp) }
}
