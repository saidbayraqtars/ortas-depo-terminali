package tr.arcteknik.depo.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import tr.arcteknik.depo.R

/** Renkler arayüz taslağıyla (tasarim/project) aynı. */
object C {
    val Ink = Color(0xFF14181F)
    val Bar = Color(0xFF1B2430)
    val BarSub = Color(0xFFB8C0CC)
    val Accent = Color(0xFFF2B705)
    val AccentBg = Color(0xFFFFFBEB)
    val AccentDark = Color(0xFF7A5A00)
    val Ground = Color(0xFFEEF0EC)
    val Surface = Color(0xFFFFFFFF)
    val Line = Color(0xFFD5D9D3)
    val LineSoft = Color(0xFFE2E5E0)
    val Field = Color(0xFFB9BFB7)
    val Muted = Color(0xFF545C66)
    val Text2 = Color(0xFF3A414A)
    val Ok = Color(0xFF1C7A4A)
    val OkBg = Color(0xFFE3F2EA)
    val OkText = Color(0xFF14583A)
    val Warn = Color(0xFFA84A00)
    val WarnBg = Color(0xFFFFF1E0)
    val WarnText = Color(0xFF7A3600)
    val Err = Color(0xFF9A1C12)
    val ErrBg = Color(0xFFFDECEA)
    val Info = Color(0xFF1F5FBF)
    val InfoBg = Color(0xFFE6EEF9)
    val InfoText = Color(0xFF163F7F)
    val OnlineBg = Color(0xFF22392E)
    val OnlineText = Color(0xFF7EE2A8)
    val OfflineBg = Color(0xFF4A2E12)
    val OfflineText = Color(0xFFFFB86B)
    val Disabled = Color(0xFFDCE0DA)
    val DisabledText = Color(0xFF5E6670)
}

val Sans = FontFamily(
    Font(R.font.plex_sans_regular, FontWeight.Normal),
    Font(R.font.plex_sans_medium, FontWeight.Medium),
    Font(R.font.plex_sans_semibold, FontWeight.SemiBold),
    Font(R.font.plex_sans_bold, FontWeight.Bold),
)

val Mono = FontFamily(
    Font(R.font.plex_mono_medium, FontWeight.Medium),
    Font(R.font.plex_mono_semibold, FontWeight.SemiBold),
)

@Composable
fun DepoTheme(content: @Composable () -> Unit) {
    val base = TextStyle(fontFamily = Sans, color = C.Ink, fontSize = 15.sp, lineHeight = 20.sp)
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = C.Bar,
            onPrimary = Color.White,
            secondary = C.Accent,
            onSecondary = C.Ink,
            background = C.Ground,
            onBackground = C.Ink,
            surface = C.Surface,
            onSurface = C.Ink,
            error = C.Err,
        ),
        typography = Typography(
            bodyLarge = base,
            bodyMedium = base,
            bodySmall = base.copy(fontSize = 13.sp),
            labelLarge = base.copy(fontWeight = FontWeight.SemiBold),
            titleMedium = base.copy(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
        ),
        content = content,
    )
}
