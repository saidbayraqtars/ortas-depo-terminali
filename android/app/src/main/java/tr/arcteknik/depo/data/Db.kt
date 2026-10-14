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
 */
class Db(context: Context) : SQLiteOpenHelper(context, "depo.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE product(id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, vega_stock REAL NOT NULL DEFAULT 0)")
        db.execSQL("CREATE INDEX ix_product_code ON product(code)")
        db.execSQL("CREATE TABLE barcode(code TEXT PRIMARY KEY, product_id TEXT NOT NULL)")
        db.execSQL("CREATE TABLE shelf(code TEXT PRIMARY KEY, zone TEXT NOT NULL DEFAULT '')")
        db.execSQL("CREATE TABLE location(product_id TEXT NOT NULL, shelf TEXT NOT NULL, qty REAL NOT NULL, PRIMARY KEY(product_id, shelf))")
        db.execSQL("CREATE INDEX ix_location_shelf ON location(shelf)")
        db.execSQL("CREATE TABLE receipt(id TEXT PRIMARY KEY, doc_no TEXT NOT NULL, supplier TEXT NOT NULL, date TEXT NOT NULL)")
        db.execSQL("CREATE TABLE receipt_line(id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, product_id TEXT NOT NULL, accepted REAL NOT NULL, shelved REAL NOT NULL)")
        db.execSQL("CREATE INDEX ix_receipt_line ON receipt_line(receipt_id)")
        db.execSQL("CREATE TABLE count_session(id TEXT PRIMARY KEY, no TEXT NOT NULL, title TEXT NOT NULL, blind INTEGER NOT NULL, status TEXT NOT NULL)")
        db.execSQL("CREATE TABLE count_line(session_id TEXT NOT NULL, shelf TEXT NOT NULL, product_id TEXT NOT NULL, qty REAL NOT NULL, PRIMARY KEY(session_id, shelf, product_id))")
        db.execSQL("CREATE TABLE op(id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT)")
        db.execSQL("CREATE TABLE movement(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, product_id TEXT NOT NULL, text TEXT NOT NULL, qty REAL NOT NULL)")
        db.execSQL("CREATE INDEX ix_movement_product ON movement(product_id, ts)")
        db.execSQL("CREATE TABLE app_user(username TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL, salt TEXT NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    // ---- Ana veri ------------------------------------------------------------------------

    /**
     * Sunucudan gelen ana veriyi yerel tabloların yerine koyar. Gönderilmemiş işlem varken çağrılmaz;
     * aksi halde cihazdaki değişiklikler sunucunun eski haliyle ezilirdi (bkz. Sync).
     */
    fun replaceMaster(json: JSONObject) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (t in listOf("product", "barcode", "shelf", "location", "receipt", "receipt_line", "app_user")) {
                db.delete(t, null, null)
            }
            val products = json.optJSONArray("products")
            for (i in 0 until (products?.length() ?: 0)) {
                val p = products!!.getJSONObject(i)
                db.insert("product", null, ContentValues().apply {
                    put("id", p.getString("id"))
                    put("code", p.getString("code"))
                    put("name", p.getString("name"))
                    put("unit", p.optString("unit", "Adet"))
                    put("vega_stock", p.optDouble("vegaStock", 0.0))
                })
                val bcs = p.optJSONArray("barcodes")
                for (j in 0 until (bcs?.length() ?: 0)) {
                    db.insertWithOnConflict("barcode", null, ContentValues().apply {
                        put("code", bcs!!.getString(j))
                        put("product_id", p.getString("id"))
                    }, SQLiteDatabase.CONFLICT_REPLACE)
                }
            }
            val shelves = json.optJSONArray("shelves")
            for (i in 0 until (shelves?.length() ?: 0)) {
                val s = shelves!!.getJSONObject(i)
                db.insertWithOnConflict("shelf", null, ContentValues().apply {
                    put("code", s.getString("code").uppercase())
                    put("zone", s.optString("zone", ""))
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            val locs = json.optJSONArray("locations")
            for (i in 0 until (locs?.length() ?: 0)) {
                val l = locs!!.getJSONObject(i)
                db.insertWithOnConflict("location", null, ContentValues().apply {
                    put("product_id", l.getString("productId"))
                    put("shelf", l.getString("shelf").uppercase())
                    put("qty", l.getDouble("qty"))
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

    // ---- Okuma ---------------------------------------------------------------------------

    private val productCols = "p.id, p.code, p.name, p.unit, p.vega_stock, (SELECT b.code FROM barcode b WHERE b.product_id=p.id LIMIT 1)"

    private fun Cursor.product(o: Int = 0) = Product(
        id = getString(o), code = getString(o + 1), name = getString(o + 2), unit = getString(o + 3),
        vegaStock = getDouble(o + 4), barcode = getString(o + 5),
    )

    fun productById(id: String): Product? =
        query("SELECT $productCols FROM product p WHERE p.id=?", id) { it.product() }.firstOrNull()

    /** Barkod, ürün kodu ya da ürün kimliğiyle arar. */
    fun findProduct(scan: String): Product? {
        val s = scan.trim()
        return query("SELECT $productCols FROM barcode b JOIN product p ON p.id=b.product_id WHERE b.code=?", s) { it.product() }.firstOrNull()
            ?: query("SELECT $productCols FROM product p WHERE p.code=? COLLATE NOCASE", s) { it.product() }.firstOrNull()
    }

    fun shelfExists(code: String): Boolean =
        scalar("SELECT 1 FROM shelf WHERE code=?", code.trim().uppercase()) != null

    fun locationsOf(productId: String): List<Location> {
        val p = productById(productId) ?: return emptyList()
        return query("SELECT shelf, qty FROM location WHERE product_id=? AND qty>0 ORDER BY qty DESC", productId) {
            Location(p, it.getString(0), it.getDouble(1))
        }
    }

    fun shelfContents(shelf: String): List<Location> =
        query("SELECT $productCols, l.shelf, l.qty FROM location l JOIN product p ON p.id=l.product_id WHERE l.shelf=? AND l.qty>0 ORDER BY p.name", shelf.uppercase()) {
            Location(it.product(), it.getString(6), it.getDouble(7))
        }

    fun qtyAt(productId: String, shelf: String): Double =
        scalar("SELECT qty FROM location WHERE product_id=? AND shelf=?", productId, shelf.uppercase())?.toDoubleOrNull() ?: 0.0

    /** Vega'da kabul edilmiş ama henüz rafa kaldırılmamış miktar; Vega stoku bunu içerir. */
    fun pendingPutAway(productId: String): Double =
        scalar("SELECT SUM(MAX(accepted-shelved, 0)) FROM receipt_line WHERE product_id=?", productId)?.toDoubleOrNull() ?: 0.0

    fun receipts(open: Boolean): List<Receipt> {
        val all = query(
            "SELECT r.id, r.doc_no, r.supplier, r.date, COUNT(l.id), SUM(CASE WHEN l.shelved>=l.accepted THEN 1 ELSE 0 END) " +
                "FROM receipt r LEFT JOIN receipt_line l ON l.receipt_id=r.id GROUP BY r.id ORDER BY r.date DESC, r.doc_no DESC",
        ) { Receipt(it.getString(0), it.getString(1), it.getString(2), it.getString(3), it.getInt(4), it.getInt(5)) }
        return all.filter { (it.doneLines < it.lineCount) == open }
    }

    fun receipt(id: String): Receipt? = receipts(true).firstOrNull { it.id == id } ?: receipts(false).firstOrNull { it.id == id }

    fun receiptLines(receiptId: String): List<ReceiptLine> =
        query("SELECT l.id, l.receipt_id, $productCols, l.accepted, l.shelved FROM receipt_line l JOIN product p ON p.id=l.product_id WHERE l.receipt_id=? ORDER BY (l.shelved>=l.accepted), p.name", receiptId) {
            ReceiptLine(it.getString(0), it.getString(1), it.product(2), it.getDouble(8), it.getDouble(9))
        }

    fun countSessions(): List<CountSession> =
        query("SELECT id, no, title, blind, status FROM count_session WHERE status='OPEN' ORDER BY no DESC") {
            CountSession(it.getString(0), it.getString(1), it.getString(2), it.getInt(3) == 1, it.getString(4))
        }

    fun countSession(id: String): CountSession? =
        query("SELECT id, no, title, blind, status FROM count_session WHERE id=?", id) {
            CountSession(it.getString(0), it.getString(1), it.getString(2), it.getInt(3) == 1, it.getString(4))
        }.firstOrNull()

    fun countLines(sessionId: String, shelf: String? = null): List<CountLine> {
        val where = if (shelf == null) "c.session_id=?" else "c.session_id=? AND c.shelf=?"
        val args = if (shelf == null) arrayOf(sessionId) else arrayOf(sessionId, shelf)
        return query("SELECT c.shelf, $productCols, c.qty FROM count_line c JOIN product p ON p.id=c.product_id WHERE $where ORDER BY c.shelf, p.name", *args) {
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
    fun addQty(db: SQLiteDatabase, productId: String, shelf: String, delta: Double) {
        setQty(db, productId, shelf, qtyAt(productId, shelf) + delta)
    }

    fun setQty(db: SQLiteDatabase, productId: String, shelf: String, qty: Double) {
        if (qty <= 0) {
            db.delete("location", "product_id=? AND shelf=?", arrayOf(productId, shelf))
        } else {
            db.insertWithOnConflict("location", null, ContentValues().apply {
                put("product_id", productId); put("shelf", shelf); put("qty", qty)
            }, SQLiteDatabase.CONFLICT_REPLACE)
        }
    }

    fun ensureShelf(db: SQLiteDatabase, shelf: String) {
        db.insertWithOnConflict("shelf", null, ContentValues().apply {
            put("code", shelf); put("zone", shelf.substringBefore('-'))
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
        val db = writableDatabase
        for (t in listOf("product", "barcode", "shelf", "location", "receipt", "receipt_line", "count_session", "count_line", "op", "movement", "app_user")) {
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
