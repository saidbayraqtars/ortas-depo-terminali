package tr.arcteknik.depo.scan

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import tr.arcteknik.depo.diag.Diag
import tr.arcteknik.depo.ui.C
import tr.arcteknik.depo.ui.SecondaryButton
import java.util.concurrent.Executors

/** Telefonlar için: kamerayla barkod okur, ilk okumada [onResult] çağrılır. */
@Composable
fun CameraScanner(onResult: (String) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) launcher.launch(Manifest.permission.CAMERA) }

    Column(Modifier.fillMaxSize().background(Color.Black).padding(16.dp)) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            if (granted) {
                CameraPreview(onResult)
                Box(Modifier.fillMaxWidth(0.8f).height(160.dp).border(3.dp, C.Accent, RoundedCornerShape(12.dp)))
            } else {
                Text("Kamera izni gerekli", color = Color.White)
            }
        }
        SecondaryButton("Kapat", onClose, Modifier.fillMaxWidth().padding(top = 12.dp), dark = true)
    }
}

// proxy.image deneysel işaretli; CameraX + ML Kit'in belgelenmiş kullanımı.
@androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
@Composable
private fun CameraPreview(onResult: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    // Google Play hizmetleri olmayan ya da ML Kit'i açamayan terminallerde (Movfast Ranger2, iData K1) getClient()
    // NullPointerException atıp uygulamayı çökertiyordu (1.9.0 sahada); kamera yoksa okuyucu tuşuyla devam edilir.
    val scanner = remember { runCatching { BarcodeScanning.getClient() }.onFailure { Diag.crumb("kamera okuyucu açılamadı: ${it.javaClass.simpleName}") }.getOrNull() }
    var done by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose {
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
            runCatching { scanner?.close() }
            executor.shutdown()
        }
    }

    if (scanner == null) {
        Text("Kamerayla okuma bu cihazda kullanılamıyor.\nTerminalin okuyucu tuşunu kullanın.", color = Color.White)
        return
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            val view = PreviewView(ctx)
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                runCatching {
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(executor) { proxy ->
                    val media = proxy.image
                    if (media == null || done) {
                        proxy.close()
                        return@setAnalyzer
                    }
                    scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                        .addOnSuccessListener { codes ->
                            val v = codes.firstOrNull { !it.rawValue.isNullOrBlank() }?.rawValue
                            if (v != null && !done) {
                                done = true
                                ContextCompat.getMainExecutor(ctx).execute { onResult(v) }
                            }
                        }
                        .addOnCompleteListener { proxy.close() }
                }
                provider.unbindAll()
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }.onFailure { Diag.crumb("kamera açılamadı: ${it.javaClass.simpleName} ${it.message.orEmpty().take(80)}") }
            }, ContextCompat.getMainExecutor(ctx))
            view
        },
    )
}
