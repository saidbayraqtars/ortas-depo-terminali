package tr.arcteknik.depo.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

/**
 * Cihazdaki yerel veri. Sunucudan gelen ana veri (ürün, raf, stok, belge, kullanıcı) burada durur;
 * terminal internetsizken de buradan çalışır. Yapılan işlemler `op` tablosunda gönderilmeyi bekler.
 *
 * Çok depo: raf, raf stoku, Vega stoku ve asıl raf depoya bağlıdır. [depot] terminalin çalıştığı depodur
 * (transfer, sayım, sorgu); mal kabul belgesi kendi deposunu taşır ve rafa kaldırma orada olur.
 */
class Db(context: Context) : SQLiteOpenHelper(context, "depo.db", null, 3) {

    /** Çalışılan depo (Vega depo numarası). Repo ayardan yükler. */
    @Volatile
    var depot: Int = 0

    override fun onCreate(db: SQLiteDatabase) {
        createMaster(db)
        db.execSQL("CREATE TABLE count_session(id TEXT PRIMARY KEY, no TEXT NOT NULL, title TEXT NOT NULL, blind INTEGER NOT NULL, status TEXT NOT NULL, depot INTEGER NOT NULL DEFAULT 0)")
        db.execSQL("CREATE TABLE count_line(session_id TEXT NOT NULL, shelf TEXT NOT NULL, product_id TEXT NOT NULL, qty REAL NOT NULL, PRIMARY KEY(session_id, shelf, product_id))")
        db.execSQL("CREATE TABLE op(id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT)")
        db.execSQL("CREATE TABLE movement(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, product_id TEXT NOT NULL, text TEXT NOT NULL, qty REAL NOT NULL)")
        db.execSQL("CREATE INDEX ix_movement_product ON movement(product_id, ts)")
        db.execSQL("CREATE TABLE app_user(username TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL, salt TEXT NOT NULL)")
    }

    /** Sunucudan tümüyle yeniden gelen tablolar. */
    private fun createMaster(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE product(id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, vega_stock REAL NOT NULL DEFAULT 0)")
        db.execSQL("CREATE INDEX ix_product_code ON product(code)")
        db.execSQL("CREATE TABLE product_stock(product_id TEXT NOT NULL, depot INTEGER NOT NULL, qty REAL NOT NULL, PRIMARY KEY(product_id, depot))")
        db.execSQL("CREATE TABLE barcode(code TEXT PRIMARY KEY, product_id TEXT NOT NULL)")
        db.execSQL("CREATE INDEX ix_barcode_product ON barcode(product_id)")
        db.execSQL("CREATE TABLE depot(id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        db.execSQL("CREATE TABLE shelf(depot INTEGER NOT NULL, code TEXT NOT NULL, zone TEXT NOT NULL DEFAULT '', PRIMARY KEY(depot, code))")
        db.execSQL("CREATE TABLE location(depot INTEGER NOT NULL, product_id TEXT NOT NULL, shelf TEXT NOT NULL, qty REAL NOT NULL, PRIMARY KEY(depot, product_id, shelf))")
        db.execSQL("CREATE INDEX ix_location_shelf ON location(depot, shelf)")
        db.execSQL("CREATE TABLE home(depot INTEGER NOT NULL, product_id TEXT NOT NULL, shelf TEXT NOT NULL, PRIMARY KEY(depot, product_id))")
        db.execSQL("CREATE TABLE receipt(id TEXT PRIMARY KEY, doc_no TEXT NOT NULL, supplier TEXT NOT NULL, date TEXT NOT NULL, depot INTEGER NOT NULL DEFAULT 0, depot_name TEXT NOT NULL DEFAULT '')")
        db.execSQL("CREATE TABLE receipt_line(id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, product_id TEXT NOT NULL, accepted REAL NOT NULL, shelved REAL NOT NULL)")
        db.execSQL("CREATE INDEX ix_receipt_line ON receipt_line(receipt_id)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // 2: ürün kartında barkod araması ürün kimliğiyle yapılıyor (isimle arama sonuçları).
        if (oldVersion < 2) db.execSQL("CREATE INDEX IF NOT EXISTS ix_barcode_product ON barcode(product_id)")
        // 3: çok depo. Ana veri tabloları sunucudan yeniden gelir; kuyruk ve süren sayım korunur.
        if (oldVersion < 3) {
            for (t in listOf("product", "barcode", "shelf", "location", "receipt", "receipt_line")) db.execSQL("DROP TABLE IF EXISTS $t")
            createMaster(db)
            db.execSQL("ALTER TABLE count_session ADD COLUMN depot INTEGER NOT NULL DEFAULT 0")
        }
    }

    // ---- Ana veri ------------------------------------------------------------------------

    /**
     * Sunucudan gelen ana veriyi yerel tabloların yerine koyar. Gönderilmemiş işlem varken çağrılmaz;
     * aksi halde cihazdaki değişiklikler sunucunun eski haliyle ezilirdi (bkz. Sync).
     */
    fun replaceMaster(json: JSONObject) {
        searchIndex = null
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (t in listOf("product", "product_stock", "barcode", "depot", "shelf", "location", "home", "receipt", "receipt_line", "app_user")) {
                db.delete(t, null, null)
            }
            // Eski sunucu depo bilgisi göndermez; o zaman her şey tek "0" deposunda durur.
            val defaultDepot = json.optInt("defaultDepot", 0)
            val depots = json.optJSONArray("depots")
            for (i in 0 until (depots?.length() ?: 0)) {
                val d = depots!!.getJSONObject(i)
                db.insertWithOnConflict("depot", null, ContentValues().apply {
                    put("id", d.getInt("id")); put("name", d.optString("name", d.getInt("id").toString()))
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            val products = json.optJSONArray("products")
            for (i in 0 until (products?.length() ?: 0)) {
                val p = products!!.getJSONObject(i)
                val id = p.getString("id")
                db.insert("product", null, ContentValues().apply {
                    put("id", id)
                    put("code", p.getString("code"))
                    put("name", p.getString("name"))
                    put("unit", p.optString("unit", "Adet"))
                    put("vega_stock", p.optDouble("vegaStock", 0.0))
                })
                val stocks = p.optJSONObject("stocks")
                if (stocks != null) {
                    for (k in stocks.keys()) {
                        db.insert("product_stock", null, ContentValues().apply {
                            put("product_id", id); put("depot", k.toIntOrNull() ?: 0); put("qty", stocks.optDouble(k, 0.0))
                        })
                    }
                } else {
                    db.insert("product_stock", null, ContentValues().apply {
                        put("product_id", id); put("depot", defaultDepot); put("qty", p.optDouble("vegaStock", 0.0))
                    })
                }
                val bcs = p.optJSONArray("barcodes")
                for (j in 0 until (bcs?.length() ?: 0)) {
                    db.insertWithOnConflict("barcode", null, ContentValues().apply {
                        put("code", bcs!!.getString(j))
                        put("product_id", id)
                    }, SQLiteDatabase.CONFLICT_REPLACE)
                }
            }
            val shelves = json.optJSONArray("shelves")
            for (i in 0 until (shelves?.length() ?: 0)) {
                val s = shelves!!.getJSONObject(i)
                db.insertWithOnConflict("shelf", null, ContentValues().apply {
                    put("depot", s.optInt("depot", defaultDepot))
                    put("code", s.getString("code").uppercase())
                    put("zone", s.optString("zone", ""))
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            val locs = json.optJSONArray("locations")
            for (i in 0 until (locs?.length() ?: 0)) {
                val l = locs!!.getJSONObject(i)
                db.insertWithOnConflict("location", null, ContentValues().apply {
                    put("depot", l.optInt("depot", defaultDepot))
                    put("product_id", l.getString("productId"))
                    put("shelf", l.getString("shelf").uppercase())
                    put("qty", l.getDouble("qty"))
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            val homes = json.optJSONArray("homes")
            for (i in 0 until (homes?.length() ?: 0)) {
                val h = homes!!.getJSONObject(i)
                db.insertWithOnConflict("home", null, ContentValues().apply {
                    put("depot", h.optInt("depot", defaultDepot))
                    put("product_id", h.getString("productId"))
                    put("shelf", h.getString("shelf").uppercase())
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            val receipts = json.optJSONArray("receipts")
            for (i in 0 until (receipts?.length() ?: 0)) {
                val r = receipts!!.getJSONObject(i)
                db.insert("receipt", null, ContentValues().apply {
                    put("id", r.getString("id"))
                    put("doc_no", r.getString("docNo"))
                    put("supplier", r.optString("supplier", ""))
                    put("date", r.optString("date", ""))
                    put("depot", r.optInt("depot", defaultDepot))
                    put("depot_name", r.optString("depotName", ""))
                })
                val lines = r.optJSONArray("lines")
                for (j in 0 until (lines?.length() ?: 0)) {
                    val l = lines!!.getJSONObject(j)
                    db.insert("receipt_line", null, ContentValues().apply {
                        put("id", l.getString("id"))
                        put("receipt_id", r.getString("id"))
                        put("product_id", l.getString("productId"))
                        put("accepted", l.getDouble("accepted"))
                        put("shelved", l.optDouble("shelved", 0.0))
                    })
                }
            }
            // Sayım oturumları: sunucudan gelenler eklenir/güncellenir, cihazda sürenlerin satırları korunur.
            val counts = json.optJSONArray("counts")
            val serverIds = mutableSetOf<String>()
            for (i in 0 until (counts?.length() ?: 0)) {
                val c = counts!!.getJSONObject(i)
                serverIds += c.getString("id")
                val status = scalar("SELECT status FROM count_session WHERE id=?", c.getString("id")) ?: "OPEN"
                db.insertWithOnConflict("count_session", null, ContentValues().apply {
                    put("id", c.getString("id"))
                    put("no", c.getString("no"))
                    put("title", c.optString("title", ""))
                    put("blind", if (c.optBoolean("blind", true)) 1 else 0)
                    put("status", status)
                    put("depot", c.optInt("depot", defaultDepot))
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            // Sunucuda artık açık olmayan ve cihazda gönderilmiş oturumları temizle.
            query("SELECT id FROM count_session WHERE status='SUBMITTED'") { it.getString(0) }
                .filter { it !in serverIds }
                .forEach { id ->
                    db.delete("count_line", "session_id=?", arrayOf(id))
                    db.delete("count_session", "id=?", arrayOf(id))
                }
            val users = json.optJSONArray("users")
            for (i in 0 until (users?.length() ?: 0)) {
                val u = users!!.getJSONObject(i)
                db.insert("app_user", null, ContentValues().apply {
                    put("username", u.getString("username").lowercase())
                    put("name", u.optString("name", u.getString("username")))
                    put("pin_hash", u.getString("pinHash"))
                    put("salt", u.getString("salt"))
                })
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun isEmpty(): Boolean = (scalar("SELECT COUNT(*) FROM product")?.toIntOrNull() ?: 0) == 0

    // ---- Depolar -------------------------------------------------------------------------

    fun depots(): List<Depot> = query("SELECT id, name FROM depot ORDER BY name") { Depot(it.getInt(0), it.getString(1)) }

    fun depotName(id: Int): String = scalar("SELECT name FROM depot WHERE id=?", id.toString()) ?: if (id == 0) "" else id.toString()

    // ---- Okuma ---------------------------------------------------------------------------

    /** Vega stoku çalışılan depodaki (ya da verilen depodaki) miktardır. */
    private fun productCols(d: Int = depot) =
        "p.id, p.code, p.name, p.unit, IFNULL((SELECT s.qty FROM product_stock s WHERE s.product_id=p.id AND s.depot=$d), 0), (SELECT b.code FROM barcode b WHERE b.product_id=p.id LIMIT 1)"

    private fun Cursor.product(o: Int = 0) = Product(
        id = getString(o), code = getString(o + 1), name = getString(o + 2), unit = getString(o + 3),
        vegaStock = getDouble(o + 4), barcode = getString(o + 5),
    )

    fun productById(id: String, d: Int = depot): Product? =
        query("SELECT ${productCols(d)} FROM product p WHERE p.id=?", id) { it.product() }.firstOrNull()

    /** Barkod, ürün kodu ya da ürün kimliğiyle arar. */
    fun findProduct(scan: String): Product? {
        val s = scan.trim()
        return query("SELECT ${productCols()} FROM barcode b JOIN product p ON p.id=b.product_id WHERE b.code=?", s) { it.product() }.firstOrNull()
            ?: query("SELECT ${productCols()} FROM product p WHERE p.code=? COLLATE NOCASE", s) { it.product() }.firstOrNull()
    }

    // İsimle arama dizini: ürün listesi yalnız ana veri gelince değişir; o zaman sıfırlanır.
    @Volatile
    private var searchIndex: List<Fuzzy.Entry>? = null

    /** Ad ya da kodla, yazım hatasına dayanıklı arama. En iyi [limit] sonuç. */
    fun searchProducts(q: String, limit: Int = 40): List<Product> {
        val tokens = Fuzzy.tokens(q)
        if (tokens.isEmpty()) return emptyList()
        val index = searchIndex ?: query("SELECT id, code, name FROM product") { Fuzzy.Entry(it.getString(0), it.getString(1), it.getString(2)) }
            .also { searchIndex = it }
        val compact = tokens.joinToString("")
        val hits = index.mapNotNull { e -> Fuzzy.score(tokens, compact, e).takeIf { it > 0 }?.let { e to it } }
            .sortedWith(compareByDescending<Pair<Fuzzy.Entry, Double>> { it.second }.thenBy { it.first.name })
            .take(limit)
        return hits.mapNotNull { productById(it.first.id) }
    }

    fun shelfExists(code: String, d: Int = depot): Boolean =
        scalar("SELECT 1 FROM shelf WHERE depot=? AND code=?", d.toString(), code.trim().uppercase()) != null

    fun locationsOf(productId: String, d: Int = depot): List<Location> {
        val p = productById(productId, d) ?: return emptyList()
        return query("SELECT shelf, qty FROM location WHERE depot=? AND product_id=? AND qty>0 ORDER BY qty DESC", d.toString(), productId) {
            Location(p, it.getString(0), it.getDouble(1))
        }
    }

    /** Ürünün asıl rafı (Excel'den); rafta hiç yokken rafa kaldırmada önerilir. */
    fun homeShelf(productId: String, d: Int = depot): String? =
        scalar("SELECT shelf FROM home WHERE depot=? AND product_id=?", d.toString(), productId)

    fun shelfContents(shelf: String, d: Int = depot): List<Location> =
        query("SELECT ${productCols(d)}, l.shelf, l.qty FROM location l JOIN product p ON p.id=l.product_id WHERE l.depot=? AND l.shelf=? AND l.qty>0 ORDER BY p.name", d.toString(), shelf.uppercase()) {
            Location(it.product(), it.getString(6), it.getDouble(7))
        }

    fun qtyAt(productId: String, shelf: String, d: Int = depot): Double =
        scalar("SELECT qty FROM location WHERE depot=? AND product_id=? AND shelf=?", d.toString(), productId, shelf.uppercase())?.toDoubleOrNull() ?: 0.0

    /** Vega'da kabul edilmiş ama henüz rafa kaldırılmamış miktar (çalışılan depoda); Vega stoku bunu içerir. */
    fun pendingPutAway(productId: String, d: Int = depot): Double =
        scalar(
            "SELECT SUM(MAX(l.accepted-l.shelved, 0)) FROM receipt_line l JOIN receipt r ON r.id=l.receipt_id WHERE l.product_id=? AND r.depot=?",
            productId, d.toString(),
        )?.toDoubleOrNull() ?: 0.0

    /** Bütün depoların belgeleri; çalışılan deponunkiler önce. */
    fun receipts(open: Boolean): List<Receipt> {
        val all = query(
            "SELECT r.id, r.doc_no, r.supplier, r.date, COUNT(l.id), SUM(CASE WHEN l.shelved>=l.accepted THEN 1 ELSE 0 END), r.depot, r.depot_name " +
                "FROM receipt r LEFT JOIN receipt_line l ON l.receipt_id=r.id GROUP BY r.id ORDER BY (r.depot<>$depot), r.date DESC, r.doc_no DESC",
        ) { Receipt(it.getString(0), it.getString(1), it.getString(2), it.getString(3), it.getInt(4), it.getInt(5), it.getInt(6), it.getString(7)) }
        return all.filter { (it.doneLines < it.lineCount) == open }
    }

    fun receipt(id: String): Receipt? = receipts(true).firstOrNull { it.id == id } ?: receipts(false).firstOrNull { it.id == id }

    /** Belge satırları; Vega stoku belgenin deposundaki. */
    fun receiptLines(receiptId: String): List<ReceiptLine> {
        val d = scalar("SELECT depot FROM receipt WHERE id=?", receiptId)?.toIntOrNull() ?: depot
        return query("SELECT l.id, l.receipt_id, ${productCols(d)}, l.accepted, l.shelved FROM receipt_line l JOIN product p ON p.id=l.product_id WHERE l.receipt_id=? ORDER BY (l.shelved>=l.accepted), p.name", receiptId) {
            ReceiptLine(it.getString(0), it.getString(1), it.product(2), it.getDouble(8), it.getDouble(9))
        }
    }

    /** Çalışılan depodaki açık sayımlar. */
    fun countSessions(): List<CountSession> =
        query("SELECT id, no, title, blind, status, depot FROM count_session WHERE status='OPEN' AND depot=? ORDER BY no DESC", depot.toString()) {
            CountSession(it.getString(0), it.getString(1), it.getString(2), it.getInt(3) == 1, it.getString(4), it.getInt(5))
        }

    fun countSession(id: String): CountSession? =
        query("SELECT id, no, title, blind, status, depot FROM count_session WHERE id=?", id) {
            CountSession(it.getString(0), it.getString(1), it.getString(2), it.getInt(3) == 1, it.getString(4), it.getInt(5))
        }.firstOrNull()

    fun countLines(sessionId: String, shelf: String? = null): List<CountLine> {
        val where = if (shelf == null) "c.session_id=?" else "c.session_id=? AND c.shelf=?"
        val args = if (shelf == null) arrayOf(sessionId) else arrayOf(sessionId, shelf)
        return query("SELECT c.shelf, ${productCols()}, c.qty FROM count_line c JOIN product p ON p.id=c.product_id WHERE $where ORDER BY c.shelf, p.name", *args) {
            CountLine(it.getString(0), it.product(1), it.getDouble(7))
        }
    }

    fun countedShelves(sessionId: String): List<String> =
        query("SELECT DISTINCT shelf FROM count_line WHERE session_id=? ORDER BY shelf", sessionId) { it.getString(0) }

    fun ops(): List<Op> =
        query("SELECT id, type, payload, summary, created_at, status, error FROM op ORDER BY created_at") {
            Op(it.getString(0), it.getString(1), it.getString(2), it.getString(3), it.getLong(4), it.getString(5), it.getString(6))
        }

    fun pendingOpCount(): Int = scalar("SELECT COUNT(*) FROM op")?.toIntOrNull() ?: 0

    fun movements(productId: String, limit: Int = 5): List<Movement> =
        query("SELECT ts, text, qty FROM movement WHERE product_id=? ORDER BY ts DESC LIMIT $limit", productId) {
            Movement(it.getLong(0), it.getString(1), it.getDouble(2))
        }

    fun user(username: String): User? =
        query("SELECT username, name, pin_hash, salt FROM app_user WHERE username=?", username.trim().lowercase()) {
            User(it.getString(0), it.getString(1), it.getString(2), it.getString(3))
        }.firstOrNull()

    // ---- Yazma (Repo üzerinden, işlem kuyruğuyla birlikte) -------------------------------

    // Android 8'deki SQLite 3.18 "ON CONFLICT DO UPDATE" (3.24+) bilmiyor; oku-yaz yapılır.
    fun addQty(db: SQLiteDatabase, d: Int, productId: String, shelf: String, delta: Double) {
        setQty(db, d, productId, shelf, qtyAt(productId, shelf, d) + delta)
    }

    fun setQty(db: SQLiteDatabase, d: Int, productId: String, shelf: String, qty: Double) {
        if (qty <= 0) {
            db.delete("location", "depot=? AND product_id=? AND shelf=?", arrayOf(d.toString(), productId, shelf))
        } else {
            db.insertWithOnConflict("location", null, ContentValues().apply {
                put("depot", d); put("product_id", productId); put("shelf", shelf); put("qty", qty)
            }, SQLiteDatabase.CONFLICT_REPLACE)
        }
    }

    fun ensureShelf(db: SQLiteDatabase, d: Int, shelf: String) {
        db.insertWithOnConflict("shelf", null, ContentValues().apply {
            put("depot", d); put("code", shelf); put("zone", shelf.substringBefore('-'))
        }, SQLiteDatabase.CONFLICT_IGNORE)
    }

    fun addMovement(db: SQLiteDatabase, productId: String, text: String, qty: Double) {
        db.insert("movement", null, ContentValues().apply {
            put("ts", System.currentTimeMillis()); put("product_id", productId); put("text", text); put("qty", qty)
        })
    }

    fun insertOp(db: SQLiteDatabase, op: Op) {
        db.insert("op", null, ContentValues().apply {
            put("id", op.id); put("type", op.type); put("payload", op.payload); put("summary", op.summary)
            put("created_at", op.createdAt); put("status", op.status); put("error", op.error)
        })
    }

    fun deleteOp(id: String) {
        writableDatabase.delete("op", "id=?", arrayOf(id))
    }

    fun markOpError(id: String, error: String) {
        writableDatabase.update("op", ContentValues().apply { put("status", OpStatus.ERROR); put("error", error) }, "id=?", arrayOf(id))
    }

    fun resetOpErrors() {
        writableDatabase.update("op", ContentValues().apply { put("status", OpStatus.PENDING); putNull("error") }, "status=?", arrayOf(OpStatus.ERROR))
    }

    fun clearAll() {
        searchIndex = null
        val db = writableDatabase
        for (t in listOf("product", "product_stock", "barcode", "depot", "shelf", "location", "home", "receipt", "receipt_line", "count_session", "count_line", "op", "movement", "app_user")) {
            db.delete(t, null, null)
        }
    }

    // ---- Yardımcılar ---------------------------------------------------------------------

    fun <T> query(sql: String, vararg args: String, map: (Cursor) -> T): List<T> {
        readableDatabase.rawQuery(sql, args).use { c ->
            val out = ArrayList<T>(c.count)
            while (c.moveToNext()) out += map(c)
            return out
        }
    }

    fun scalar(sql: String, vararg args: String): String? =
        query(sql, *args) { if (it.isNull(0)) null else it.getString(0) }.firstOrNull()
}
