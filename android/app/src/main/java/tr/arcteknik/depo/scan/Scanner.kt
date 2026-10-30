package tr.arcteknik.depo.scan

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.KeyEvent
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import tr.arcteknik.depo.diag.Diag
import tr.arcteknik.depo.sync.UserActivity

/**
 * El terminallerinden gelen okumalar iki yoldan gelir:
 *  1. Klavye modu: okuyucu metni odaktaki alana yazar ve Enter basar (ScanField bunu yakalar).
 *  2. Yayın (broadcast) modu: okuyucu her okumayı bir Intent olarak yollar; aşağıdaki alıcı yakalar.
 * Hangi marka hangi eylemi kullanıyor: docs/TERMINAL.md.
 */
object ScanBus {
    private val _scans = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val scans: SharedFlow<String> = _scans

    fun emit(code: String) {
        val c = code.trim()
        if (c.isEmpty()) return
        UserActivity.touch()
        Diag.crumb("okutma (yayın): $c")
        emitRaw(c)
    }

    /** İzi çağıran yazmış olur ([emit], [ScanKeys]). */
    fun emitRaw(code: String) {
        if (!_scans.tryEmit(code)) Diag.crumb("okutma kuyruğu dolu, atlandı")
    }

    /** Bilinen terminal markalarının yayın eylemleri. */
    val ACTIONS = listOf(
        "tr.arcteknik.depo.SCAN",                        // Zebra DataWedge (profilde bu eylem tanımlanır)
        "android.intent.ACTION_DECODE_DATA",             // Urovo
        "com.honeywell.decode.intent.action.EDIT_DATA",  // Honeywell (profilde tanımlanır)
        "nlscan.action.SCANNER_RESULT",                  // Newland
        "com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED",   // Sunmi
        "android.intent.action.SCANRESULT",              // iData
        "com.scanner.broadcast",                         // Chainway
        "com.android.server.scannerservice.broadcast",   // Point Mobile, bazı Çin markaları
    )

    private val EXTRAS = listOf(
        "com.symbol.datawedge.data_string", "barcode_string", "data", "SCAN_BARCODE1",
        "value", "scannerdata", "barocode", "barcode", "decode_rslt",
    )

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val extras = intent.extras ?: return
            val value = EXTRAS.firstNotNullOfOrNull { k ->
                when (val v = extras.get(k)) {
                    is String -> v
                    is ByteArray -> String(v, Charsets.UTF_8)
                    else -> null
                }
            }
            if (value != null) emit(value)
        }
    }

    fun register(context: Context) {
        val filter = IntentFilter().apply { ACTIONS.forEach { addAction(it) } }
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    fun unregister(context: Context) {
        runCatching { context.unregisterReceiver(receiver) }
    }
}

/**
 * Klavye modundaki okuyucunun tuşları odaktaki okutma alanına yazılır. Alan olayı almazsa okutma kaybolurdu: odak başka
 * yerdeyken, ya da okuyucu barkodu tek bir "toplu" tuş olayı (ACTION_MULTIPLE) olarak yolladığında; Compose bunu yazı saymaz,
 * ekran klavyesi açıkken IME alana yazar, kapalıyken kimse işlemez. [tr.arcteknik.depo.MainActivity.dispatchKeyEvent]
 * hiçbir yerin işlemediği tuşları buraya verir: okuyucu hızında gelen bir dizi (karakterler arası [GAP_MS]'den kısa) ve
 * ardından Enter okutma sayılıp [ScanBus]'a gider. Elle yazma yavaş olduğundan bu yola girmez.
 */
object ScanKeys {
    private const val GAP_MS = 80L
    private const val ENTER_GAP_MS = 300L
    private const val MIN_LEN = 3
    private const val MAX_TRACE = 40
    private val buf = StringBuilder()
    private var last = 0L
    private var traced = 0

    fun onUnhandled(e: KeyEvent) {
        val now = e.eventTime.takeIf { it > 0 } ?: SystemClock.uptimeMillis()
        val chars = if (e.action == KeyEvent.ACTION_MULTIPLE) e.characters else null
        val enter = e.keyCode == KeyEvent.KEYCODE_ENTER || e.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
        val printable = e.action == KeyEvent.ACTION_DOWN && e.unicodeChar >= 32 && !e.isCtrlPressed && !e.isAltPressed
        // Sürekli tuşa basılan/elle yazılan olaylar izi doldurmasın: yalnız ilk birkaçı kaydedilir.
        if (traced < MAX_TRACE && (chars != null || printable || (enter && e.action == KeyEvent.ACTION_DOWN))) {
            traced++
            val action = when (e.action) { KeyEvent.ACTION_DOWN -> "DOWN"; KeyEvent.ACTION_UP -> "UP"; else -> "MULTIPLE" }
            Diag.crumb("tuş işlenmedi: $action ${KeyEvent.keyCodeToString(e.keyCode)} aygıt ${e.deviceId}" + (chars?.let { " metin ${it.length} karakter" } ?: ""))
        }
        when {
            chars != null -> {
                if (now - last > GAP_MS) buf.setLength(0)
                last = now
                val nl = chars.indexOfFirst { it == '\n' || it == '\r' }
                buf.append(if (nl >= 0) chars.substring(0, nl) else chars)
                if (nl >= 0) flush()
            }
            printable -> {
                if (now - last > GAP_MS) buf.setLength(0)
                buf.append(e.unicodeChar.toChar())
                last = now
            }
            enter && e.action == KeyEvent.ACTION_DOWN -> if (now - last <= ENTER_GAP_MS) flush() else buf.setLength(0)
        }
    }

    // ---- Ekran klavyesinden (IME) önce görülen tuşlar -------------------------------------------------------------
    // Odaktaki okutma alanı her tuşu IME'den ÖNCE görür. Okuyucunun karakterlerini IME alana yazmazsa (iData K1'de klavye
    // kapalıyken ikinci okutma kaybolabiliyordu) ya da Enter'ı yutarsa, okutma yine de buradan kurtarılır. Normalde IME alana
    // yazar, alan dolu olduğundan buradaki kopya kullanılmaz ve her okutmada silinir.
    private val shadow = StringBuilder()
    private var shadowLast = 0L

    /** Okutma alanının IME'den önce gördüğü tuş; hiçbir şeyi tüketmez. */
    fun shadow(e: KeyEvent) {
        val now = e.eventTime.takeIf { it > 0 } ?: SystemClock.uptimeMillis()
        val chars = if (e.action == KeyEvent.ACTION_MULTIPLE) e.characters else null
        val printable = e.action == KeyEvent.ACTION_DOWN && e.unicodeChar >= 32 && !e.isCtrlPressed && !e.isAltPressed
        if (chars == null && !printable) return
        if (now - shadowLast > GAP_MS) shadow.setLength(0)
        shadowLast = now
        if (chars != null) shadow.append(chars.filter { it != '\n' && it != '\r' }) else shadow.append(e.unicodeChar.toChar())
    }

    private var enterTraced = 0

    /** Tanı: Enter'ın IME'den önce görüldüğü okutmalar (en çok $MAX_TRACE). Okuma uygulamaya hiç ulaşmadıysa (tarayıcı motoru yinelemeyi engelledi) iz de olmaz. */
    fun noteEnter(title: String, keyboard: String) {
        if (enterTraced >= MAX_TRACE) return
        enterTraced++
        Diag.crumb("tuş: Enter IME'den önce ($title) · ${shadow.trim().length} karakter · klavye $keyboard")
    }

    /** Enter beklemeden gönderilecek en kısa okuma uzunluğu: elle yazma bu hızda bu kadar karakter üretemez. */
    private const val QUIET_MIN_LEN = 6

    /** Okuyucu hızında yazılmış, en az [QUIET_MIN_LEN] karakterlik son dizi (Enter gelmediyse); yoksa null. */
    fun burst(): String? = shadow.toString().trim().takeIf { it.length >= QUIET_MIN_LEN }

    /** Enter geldiğinde IME'den önce yakalanmış, okuyucu hızında yazılmış okuma var mı (okumadan çekmeden). */
    fun hasShadow(): Boolean = shadow.trim().length >= MIN_LEN && SystemClock.uptimeMillis() - shadowLast <= ENTER_GAP_MS

    /** Enter anında yakalanmış taze okuma (tamponu boşaltmaz); yoksa null. */
    fun peekShadow(): String? = if (hasShadow()) shadow.toString().trim() else null

    /** [code] hâlâ tamponda mı (bu arada alan bir okutmayı kabul edip tamponu boşaltmadıysa). */
    fun shadowIs(code: String): Boolean = shadow.toString().trim() == code

    /** Yakalanmış okumayı verir ve her iki tamponu da boşaltır. Yoksa ya da eskiyse null. */
    fun takeShadow(): String? {
        val code = if (hasShadow()) shadow.toString().trim() else null
        clearShadow()
        return code
    }

    /** Alan bir okutmayı kabul etti: yakalanan kopya bir daha kullanılmasın. */
    fun clearShadow() {
        shadow.setLength(0)
        buf.setLength(0)
    }

    /**
     * Odaktaki okutma alanı Enter'ı kendisi tükettiğinde ([onUnhandled] hiç görmez) alana yazılmamış, yakalanmış okumayı verir.
     * Yoksa ya da eskiyse null.
     */
    fun takePending(): String? {
        val code = buf.toString().trim()
        val fresh = SystemClock.uptimeMillis() - last <= ENTER_GAP_MS
        buf.setLength(0)
        if (!fresh || code.length < MIN_LEN) return null
        Diag.crumb("okutma (tuş yakalandı, alan Enter): $code")
        return code
    }

    private fun flush() {
        val code = buf.toString().trim()
        buf.setLength(0)
        if (code.length < MIN_LEN) return
        UserActivity.touch()
        Diag.crumb("okutma (tuş yakalandı): $code")
        ScanBus.emitRaw(code)
    }
}

/**
 * Okuma sonrası ses ve titreşim: başarıda kısa bip, hatada uzun bip ve titreşim.
 * Ana iş parçacığında çalınmaz: `ToneGenerator.startTone` yerelde ses kanalının açılmasını 3 sn'ye kadar
 * bekleyebiliyor; terminalin kendi okuyucu bip'iyle çakışınca art arda okutmalarda ekran donup Android
 * "yanıt vermiyor" diyordu (Movfast, 2026-10-26). Sesler sıraya girer; birikirse eskiler atlanır.
 */
class Feedback(context: Context) {
    private val vibrator = context.getSystemService(Vibrator::class.java)
    private val thread = android.os.HandlerThread("ses").apply { start() }
    private val handler = android.os.Handler(thread.looper)
    private var tone: ToneGenerator? = null

    init {
        handler.post { tone = runCatching { ToneGenerator(AudioManager.STREAM_NOTIFICATION, 90) }.getOrNull() }
    }

    private fun play(f: () -> Unit) {
        handler.removeCallbacksAndMessages(null)
        handler.post {
            val t0 = System.currentTimeMillis()
            runCatching(f)
            val ms = System.currentTimeMillis() - t0
            if (ms > 500) Diag.crumb("ses ${ms} ms sürdü")
        }
    }

    fun ok() = play {
        tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 80)
    }

    fun error() = play {
        tone?.startTone(ToneGenerator.TONE_SUP_ERROR, 300)
        if (Build.VERSION.SDK_INT >= 26) vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 120, 80, 120), -1))
    }
}
