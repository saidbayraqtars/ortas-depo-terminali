package tr.arcteknik.depo.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

/**
 * Depo işlemleri. Her işlem yerel tabloyu hemen günceller ve sunucuya gidecek kaydı aynı
 * veritabanı işleminde kuyruğa yazar; bağlantı olsa da olmasa da terminal beklemeden devam eder.
 */
class Repo(val db: Db, val prefs: Prefs) {

    init {
        db.depot = prefs.depot
    }

    /** Çalışılan depoyu değiştirir (transfer, sayım, sorgu bu depoda). */
    fun selectDepot(id: Int) {
        prefs.depotChosen = true
        prefs.depot = id
        db.depot = id
        changed()
    }

    /** Çalışılan deponun adı (ana menü ve giriş ekranında). */
    fun depotName(): String = db.depotName(db.depot).ifBlank { prefs.warehouse }

    /** Ana veri gelince: depo hiç seçilmediyse ya da artık yoksa sunucunun varsayılanı. */
    fun ensureDepot(defaultDepot: Int) {
        val ids = db.depots().map { it.id }
        if (!prefs.depotChosen || (ids.isNotEmpty() && prefs.depot !in ids)) {
            prefs.depot = defaultDepot
            db.depot = defaultDepot
        }
    }

    private val _version = MutableStateFlow(0)
    /** Ekranlar bunu izler; veri değişince artar. */
    val version: StateFlow<Int> = _version

    fun changed() {
        _version.value++
    }

    // ---- Giriş ---------------------------------------------------------------------------

    fun login(username: String, pin: String): User? {
        val u = db.user(username) ?: return null
        return if (hashPin(u.salt, pin) == u.pinHash) u.also { prefs.lastUser = it.username } else null
    }

    // ---- Rafa kaldırma -------------------------------------------------------------------

    fun putAway(line: ReceiptLine, shelf: String, qty: Double, user: String) {
        val s = shelf.uppercase()
        val receipt = db.receipt(line.receiptId)
        // Belge depo bazlı: mal belgenin deposunda rafa kalkar.
        val d = receipt?.depot ?: db.depot
        val w = db.writableDatabase
        w.beginTransaction()
        try {
            db.ensureShelf(w, d, s)
            db.addQty(w, d, line.product.id, s, qty)
            w.execSQL("UPDATE receipt_line SET shelved=shelved+? WHERE id=?", arrayOf<Any>(qty, line.id))
            db.addMovement(w, line.product.id, "Rafa kaldırma → $s", qty)
            db.insertOp(w, op(
                OpType.PUTAWAY,
                JSONObject()
                    .put("receiptId", line.receiptId)
                    .put("lineId", line.id)
                    .put("productId", line.product.id)
                    .put("shelf", s)
                    .put("qty", qty)
                    .put("depot", d)
                    .put("user", user),
                "Rafa kaldırma · ${fmt(qty)} ${line.product.unit.lowercase()}|${line.product.code} → $s" +
                    (receipt?.let { " · ${it.docNo}" } ?: ""),
            ))
            w.setTransactionSuccessful()
        } finally {
            w.endTransaction()
        }
        changed()
    }

    // ---- Raf ----------------------------------------------------------------------------

    /** Tanımsız raf etiketi terminalden raf olarak eklenir; yönetici programında da açılır. */
    fun addShelf(code: String, depot: Int, user: String) {
        val s = code.trim().uppercase()
        val w = db.writableDatabase
        w.beginTransaction()
        try {
            db.ensureShelf(w, depot, s)
            db.insertOp(w, op(
                OpType.SHELF_ADD,
                JSONObject().put("code", s).put("depot", depot).put("user", user),
                "Raf eklendi|$s" + (db.depotName(depot).ifBlank { null }?.let { " · $it" } ?: ""),
            ))
            w.setTransactionSuccessful()
        } finally {
            w.endTransaction()
        }
        changed()
    }

    // ---- Transfer ------------------------------------------------------------------------

    fun transfer(product: Product, from: String, to: String, qty: Double, user: String) {
        val f = from.uppercase()
        val t = to.uppercase()
        val w = db.writableDatabase
        w.beginTransaction()
        try {
            val d = db.depot
            db.ensureShelf(w, d, t)
            db.addQty(w, d, product.id, f, -qty)
            db.addQty(w, d, product.id, t, qty)
            db.addMovement(w, product.id, "Transfer $f → $t", qty)
            db.insertOp(w, op(
                OpType.TRANSFER,
                JSONObject().put("productId", product.id).put("from", f).put("to", t).put("qty", qty).put("depot", d).put("user", user),
                "Raf transferi · ${fmt(qty)} ${product.unit.lowercase()}|${product.code} $f → $t",
            ))
            w.setTransactionSuccessful()
        } finally {
            w.endTransaction()
        }
        changed()
    }

    // ---- Sayım ---------------------------------------------------------------------------

    /** Yönetici oturum açmadıysa terminalde serbest sayım başlatılır. */
    fun startFreeCount(): CountSession {
        val id = "LOCAL-" + UUID.randomUUID().toString().take(8)
        val no = "SAY-T" + (System.currentTimeMillis() / 1000 % 100000)
        db.writableDatabase.execSQL(
            "INSERT INTO count_session(id, no, title, blind, status, depot) VALUES(?,?,?,?,?,?)",
            arrayOf<Any>(id, no, "Serbest sayım", 0, "OPEN", db.depot),
        )
        changed()
        return db.countSession(id)!!
    }

    /** Hiçbir şey sayılmadan bırakılan serbest sayım listede birikmesin. */
    fun discardEmptyLocal(sessionId: String) {
        if (!sessionId.startsWith("LOCAL-")) return
        val w = db.writableDatabase
        val n = db.countedShelves(sessionId).size
        val st = db.scalar("SELECT status FROM count_session WHERE id=?", sessionId)
        if (n == 0 && st == "OPEN") {
            w.execSQL("DELETE FROM count_session WHERE id=?", arrayOf<Any>(sessionId))
            changed()
        }
    }

    /** Rafta hiçbir şey yok: raf sayılmış olur, sistemde rafta görünen ürünler gönderilince 0'a çekilir. */
    fun markShelfEmpty(sessionId: String, shelf: String) {
        db.writableDatabase.execSQL("INSERT OR IGNORE INTO count_shelf(session_id, shelf) VALUES(?,?)", arrayOf<Any>(sessionId, shelf.uppercase()))
        changed()
    }

    fun addCount(sessionId: String, shelf: String, product: Product, delta: Double) {
        val s = shelf.uppercase()
        val cur = db.scalar("SELECT qty FROM count_line WHERE session_id=? AND shelf=? AND product_id=?", sessionId, s, product.id)?.toDoubleOrNull()
        val next = ((cur ?: 0.0) + delta).coerceAtLeast(0.0)
        val w = db.writableDatabase
        if (cur == null) {
            w.execSQL("INSERT INTO count_line(session_id, shelf, product_id, qty) VALUES(?,?,?,?)", arrayOf<Any>(sessionId, s, product.id, next))
        } else {
            w.execSQL("UPDATE count_line SET qty=? WHERE session_id=? AND shelf=? AND product_id=?", arrayOf<Any>(next, sessionId, s, product.id))
        }
        changed()
    }

    fun setCount(sessionId: String, shelf: String, product: Product, qty: Double) {
        addCount(sessionId, shelf, product, qty - (db.scalar("SELECT qty FROM count_line WHERE session_id=? AND shelf=? AND product_id=?", sessionId, shelf.uppercase(), product.id)?.toDoubleOrNull() ?: 0.0))
    }

    /**
     * Sayılan raflarda sistemdeki ve sayılan miktarı karşılaştırır. Rafta sistemde olup hiç
     * okutulmayan ürün de 0 sayılmış kabul edilir.
     */
    fun countDiffs(sessionId: String): List<CountDiff> {
        val dep = db.countSession(sessionId)?.depot ?: db.depot
        val out = mutableListOf<CountDiff>()
        for (shelf in db.countedShelves(sessionId)) {
            val counted = db.countLines(sessionId, shelf).associateBy { it.product.id }
            // Zimmetli ama rafta hiç olmayan (0) ve okutulmayan ürün fark değildir; listeye girmez.
            val system = db.shelfContents(shelf, dep).filter { it.qty > 0 }.associateBy { it.product.id }
            for (pid in counted.keys + system.keys) {
                val product = counted[pid]?.product ?: system[pid]!!.product
                out += CountDiff(shelf, product, system[pid]?.qty ?: 0.0, counted[pid]?.qty ?: 0.0)
            }
        }
        return out.sortedWith(compareBy({ it.diff == 0.0 }, { it.shelf }, { it.product.name }))
    }

    /**
     * Sayımı sunucuya gönderilmek üzere kuyruğa koyar. Vega'ya işleme yönetici programında onayla olur;
     * terminaldeki raf miktarları sayılan değere çekilir.
     */
    fun submitCount(session: CountSession, user: String) {
        val diffs = countDiffs(session.id)
        val lines = JSONArray()
        diffs.forEach {
            lines.put(JSONObject().put("shelf", it.shelf).put("productId", it.product.id).put("system", it.system).put("counted", it.counted))
        }
        val w = db.writableDatabase
        w.beginTransaction()
        try {
            diffs.forEach { d ->
                db.setQty(w, session.depot, d.product.id, d.shelf, d.counted)
                if (d.diff != 0.0) db.addMovement(w, d.product.id, "Sayım farkı ${d.shelf} (${session.no})", d.diff)
            }
            w.execSQL("UPDATE count_session SET status='SUBMITTED' WHERE id=?", arrayOf<Any>(session.id))
            val changedCount = diffs.count { it.diff != 0.0 }
            db.insertOp(w, op(
                OpType.COUNT_SUBMIT,
                JSONObject().put("sessionId", session.id).put("no", session.no).put("title", session.title).put("depot", session.depot)
                    .put("shelves", JSONArray(db.countedShelves(session.id))).put("lines", lines).put("user", user),
                "Sayım · ${session.no}|${diffs.size} kalem, $changedCount farklı",
            ))
            w.setTransactionSuccessful()
        } finally {
            w.endTransaction()
        }
        changed()
    }

    // ---- Yardımcılar ---------------------------------------------------------------------

    private fun op(type: String, payload: JSONObject, summary: String) = Op(
        id = UUID.randomUUID().toString(),
        type = type,
        payload = payload.put("device", prefs.deviceName).toString(),
        summary = summary,
        createdAt = System.currentTimeMillis(),
        status = OpStatus.PENDING,
        error = null,
    )

    companion object {
        /** Yönetici programının kabul ettiği raf kodu (server/depo.js RAF_DESEN). */
        private val SHELF_CODE = Regex("^[A-Z0-9ÇĞİÖŞÜ][A-Z0-9ÇĞİÖŞÜ\\-./ ]{0,23}$")

        fun validShelfCode(code: String) = SHELF_CODE.matches(code.trim().uppercase())

        fun hashPin(salt: String, pin: String): String =
            MessageDigest.getInstance("SHA-256").digest((salt + pin).toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }

        fun fmt(q: Double): String =
            if (q == Math.floor(q)) q.toLong().toString() else "%.2f".format(q).trimEnd('0').trimEnd(',', '.')
    }
}
