package tr.arcteknik.depo.scan

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

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
        if (c.isNotEmpty()) _scans.tryEmit(c)
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

/** Okuma sonrası ses ve titreşim: başarıda kısa bip, hatada uzun bip ve titreşim. */
class Feedback(context: Context) {
    private val tone = runCatching { ToneGenerator(AudioManager.STREAM_NOTIFICATION, 90) }.getOrNull()
    private val vibrator = context.getSystemService(Vibrator::class.java)

    fun ok() {
        tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 80)
    }

    fun error() {
        tone?.startTone(ToneGenerator.TONE_SUP_ERROR, 300)
        if (Build.VERSION.SDK_INT >= 26) vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 120, 80, 120), -1))
    }
}
