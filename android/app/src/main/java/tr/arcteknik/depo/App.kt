package tr.arcteknik.depo

import android.app.Application
import tr.arcteknik.depo.data.Db
import tr.arcteknik.depo.data.Prefs
import tr.arcteknik.depo.data.Repo
import tr.arcteknik.depo.diag.Diag
import tr.arcteknik.depo.scan.Feedback
import tr.arcteknik.depo.sync.Sync

class App : Application() {
    lateinit var repo: Repo
    lateinit var sync: Sync
    lateinit var feedback: Feedback

    override fun onCreate() {
        super.onCreate()
        val prefs = Prefs(this)
        Diag.init(this, prefs)
        repo = Repo(Db(this), prefs)
        sync = Sync(this, repo)
        feedback = Feedback(this)
        sync.start()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        Diag.crumb("bellek uyarısı $level")
    }
}
