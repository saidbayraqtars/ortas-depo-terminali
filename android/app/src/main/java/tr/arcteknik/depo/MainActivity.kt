package tr.arcteknik.depo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import tr.arcteknik.depo.scan.ScanBus
import tr.arcteknik.depo.ui.AppVm
import tr.arcteknik.depo.ui.DepoApp
import tr.arcteknik.depo.ui.DepoTheme

class MainActivity : ComponentActivity() {
    private val vm: AppVm by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { DepoTheme { DepoApp(vm) } }
    }

    // Okuyucu yayınları yalnız uygulama öndeyken dinlenir.
    override fun onResume() {
        super.onResume()
        ScanBus.register(this)
    }

    override fun onPause() {
        ScanBus.unregister(this)
        super.onPause()
    }
}
