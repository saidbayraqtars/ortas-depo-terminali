package tr.arcteknik.depo.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.database.sqlite.SQLiteStatement
import android.util.JsonReader
import android.util.JsonToken
import org.json.JSONArray
import org.json.JSONObject
import java.io.Reader

/**
 * Cihazdaki yerel veri. Sunucudan gelen ana veri (ürün, raf, stok, belge, kullanıcı) burada durur;
 * terminal internetsizken de buradan çalışır. Yapılan işlemler `op` tablosunda gönderilmeyi bekler.
 *
 * Çok depo: raf, raf stoku, Vega stoku ve asıl raf depoya bağlıdır. [depot] terminalin çalıştığı depodur
 * (transfer, sayım, sorgu); mal kabul belgesi kendi deposunu taşır ve rafa kaldırma orada olur.
 */
class Db(context: Context) : SQLiteOpenHelper(context, "depo.db", null, 7) {

    init {
        // Eşitleme ana veriyi yazarken ekranlar (ana iş parçacığı) beklemeden son kaydedilmiş hali okusun.
        setWriteAheadLoggingEnabled(true)
    }

    /** Çalışılan depo (Vega depo numarası). Repo ayardan yükler. */
    @Volatile
    var depot: Int = 0

    override fun onCreate(db: SQLiteDatabase) {
        createMaster(db)
        db.execSQL("CREATE TABLE count_session(id TEXT PRIMARY KEY, no TEXT NOT NULL, title TEXT NOT NULL, blind INTEGER NOT NULL, status TEXT NOT NULL, depot INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL DEFAULT '')")
        db.execSQL("CREATE TABLE count_line(session_id TEXT NOT NULL, shelf TEXT NOT NULL, product_id TEXT NOT NULL, qty REAL NOT NULL, PRIMARY KEY(session_id, shelf, product_id))")
        createCountShelf(db)
        db.execSQL("CREATE TABLE op(id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT)")
        db.execSQL("CREATE TABLE movement(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, product_id TEXT NOT NULL, text TEXT NOT NULL, qty REAL NOT NULL)")
        db.execSQL("CREATE INDEX ix_movement_product ON movement(product_id, ts)")
        db.execSQL("CREATE TABLE app_user(username TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL, salt TEXT NOT NULL)")
        createParts(db)
    }

    /** Boş olarak sayılan raflar: count_line'da satırları yoktur ama sayılmıştır. */
    private fun createCountShelf(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS count_shelf(session_id TEXT NOT NULL, shelf TEXT NOT NULL, PRIMARY KEY(session_id, shelf))")
    }

    /** Sunucudan alınmış ana veri parçalarının özeti (bkz. [applyParts]). */
    private fun createParts(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS master_part(key TEXT PRIMARY KEY, hash TEXT NOT NULL)")
    }

    /** Sunucudan tümüyle yeniden gelen tablolar. */
    private fun createMaster(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE product(id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, vega_stock REAL NOT NULL DEFAULT 0, bucket INTEGER NOT NULL DEFAULT 0, search TEXT NOT NULL DEFAULT '')")
        db.execSQL("CREATE INDEX ix_product_code ON product(code)")
        // Kod araması büyük/küçük harfe bakmaz (`code=? COLLATE NOCASE`); indeks aynı sıralamada olmalı, yoksa 130 bin satır taranır.
        db.execSQL("CREATE INDEX ix_product_code_nc ON product(code COLLATE NOCASE)")
        db.execSQL("CREATE INDEX ix_product_bucket ON product(bucket)")
        db.execSQL("CREATE TABLE product_stock(product_id TEXT NOT NULL, depot INTEGER NOT NULL, qty REAL NOT NULL, PRIMARY KEY(product_id, depot))")
        db.execSQL("CREATE TABLE barcode(code TEXT PRIMARY KEY, product_id TEXT NOT NULL)")
        db.execSQL("CREATE INDEX ix_barcode_product ON barcode(product_id)")
        db.execSQL("CREATE TABLE depot(id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        db.execSQL("CREATE TABLE shelf(depot INTEGER NOT NULL, code TEXT NOT NULL, zone TEXT NOT NULL DEFAULT '', PRIMARY KEY(depot, code))")
        db.execSQL("CREATE TABLE location(depot INTEGER NOT NULL, product_id TEXT NOT NULL, shelf TEXT NOT NULL, qty REAL NOT NULL, bucket INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(depot, product_id, shelf))")
        db.execSQL("CREATE INDEX ix_location_shelf ON location(depot, shelf)")
        db.execSQL("CREATE INDEX ix_location_bucket ON location(bucket)")
        db.execSQL("CREATE TABLE home(depot INTEGER NOT NULL, product_id TEXT NOT NULL, shelf TEXT NOT NULL, bucket INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(depot, product_id, shelf))")
        db.execSQL("CREATE INDEX ix_home_shelf ON home(depot, shelf)")
        db.execSQL("CREATE INDEX ix_home_bucket ON home(bucket)")
        db.execSQL("CREATE TABLE receipt(id TEXT PRIMARY KEY, doc_no TEXT NOT NULL, supplier TEXT NOT NULL, date TEXT NOT NULL, depot INTEGER NOT NULL DEFAULT 0, depot_name TEXT NOT NULL DEFAULT '')")
        db.execSQL("CREATE TABLE receipt_line(id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, product_id TEXT NOT NULL, accepted REAL NOT NULL, shelved REAL NOT NULL)")
        db.execSQL("CREATE INDEX ix_receipt_line ON receipt_line(receipt_id)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // 2: ürün kartında barkod araması ürün kimliğiyle yapılıyor (isimle arama sonuçları).
        if (oldVersion < 2) db.execSQL("CREATE INDEX IF NOT EXISTS ix_barcode_product ON barcode(product_id)")
        // 3: çok depo.
        if (oldVersion < 3) db.execSQL("ALTER TABLE count_session ADD COLUMN depot INTEGER NOT NULL DEFAULT 0")
        // 3 çok depo, 4 ürün birden çok rafa zimmetli. Ana veri tabloları boşalır, sunucudan yeniden gelir
        // (boş ürün tablosu tam liste ister); kuyruk ve süren sayım korunur.
        // 5: ana veri kovalara bölünmüş gelir (ürün, konum ve zimmette kova sütunu).
        if (oldVersion < 5) {
            for (t in listOf("product", "product_stock", "barcode", "depot", "shelf", "location", "home", "receipt", "receipt_line")) db.execSQL("DROP TABLE IF EXISTS $t")
            createMaster(db)
            createParts(db)
            db.execSQL("DELETE FROM master_part")
        }
        // 7: isimle arama SQL'de (product.search) ve kod araması indeksli; ürün listesi artık belleğe alınmıyor.
        // Arama sütunu ürünler yeniden inerken dolar, bu yüzden bütün parçalar yeniden istenir.
        if (oldVersion < 7) {
            db.execSQL("ALTER TABLE product ADD COLUMN search TEXT NOT NULL DEFAULT ''")
            db.execSQL("CREATE INDEX IF NOT EXISTS ix_product_code_nc ON product(code COLLATE NOCASE)")
            db.execSQL("DELETE FROM master_part")
        }
        // 6: sayım kapsamı (raf önekleri) ve boş sayılan raf. Baş parça yeniden istensin: kapsam gelsin,
        // yöneticide kapatılıp cihazda açık kalmış sayımlar temizlensin.
        if (oldVersion < 6) {
            db.execSQL("ALTER TABLE count_session ADD COLUMN scope TEXT NOT NULL DEFAULT ''")
            createCountShelf(db)
            db.execSQL("DELETE FROM master_part WHERE key='head'")
        }
    }

    // ---- Ana veri ------------------------------------------------------------------------

    /**
     * Sunucudan gelen ana veriyi yerel tabloların yerine koyar. Gönderilmemiş işlem varken çağrılmaz;
     * aksi halde cihazdaki değişiklikler sunucunun eski haliyle ezilirdi (bkz. Sync).
     *
     * Ana veri akıştan okunur: Ortaş'ta 130 bin ürün ve 300 bini aşan zimmetle JSON 30 MB'ı geçiyor; tek parça
     * JSONObject belleği taşırıyor, yazma da onlarca saniye sürüyordu. Bu sırada kullanıcı bir işlem kaydederse
     * (ana iş parçacığında) eşitleme yazma kilidini bırakır; yoksa ekran donar ve Android "yanıt vermiyor" der.
     *
     * @return ürün, raf, konum ve zimmet dışındaki üst alanlar (depo, kullanıcı, belge, sayım, uygulama sürümü).
     */
    fun replaceMaster(input: Reader): JSONObject {
        val head = JSONObject()
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (t in listOf("product", "product_stock", "barcode", "depot", "shelf", "location", "home", "receipt", "receipt_line", "app_user")) {
                db.delete(t, null, null)
            }
            db.delete("master_part", null, null)
            val insProduct = db.compileStatement("INSERT OR REPLACE INTO product(id, code, name, unit, vega_stock, bucket, search) VALUES(?,?,?,?,?,?,?)")
            val insStock = db.compileStatement("INSERT OR REPLACE INTO product_stock(product_id, depot, qty) VALUES(?,?,?)")
            val insBarcode = db.compileStatement("INSERT OR REPLACE INTO barcode(code, product_id) VALUES(?,?)")
            val insShelf = db.compileStatement("INSERT OR REPLACE INTO shelf(depot, code, zone) VALUES(?,?,?)")
            val insLocation = db.compileStatement("INSERT OR REPLACE INTO location(depot, product_id, shelf, qty, bucket) VALUES(?,?,?,?,?)")
            val insHome = db.compileStatement("INSERT OR REPLACE INTO home(depot, product_id, shelf, bucket) VALUES(?,?,?,?)")
            // Eski sunucu depo bilgisi göndermez; o zaman her şey tek "0" deposunda durur. Sunucu bunu ürünlerden önce yazar.
            fun defaultDepot() = head.optInt("defaultDepot", 0)
            var n = 0
            fun yieldSometimes() {
                if (++n % 500 == 0) db.yieldIfContendedSafely()
            }
            JsonReader(input).use { r ->
                r.beginObject()
                while (r.hasNext()) {
                    when (val key = r.nextName()) {
                        "products" -> r.eachObject { p ->
                            val id = p.getString("id")
                            insProduct.exec(id, p.getString("code"), p.getString("name"), p.optString("unit", "Adet"), p.optDouble("vegaStock", 0.0), Buckets.of(id), Fuzzy.searchKey(p.getString("code"), p.getString("name")))
                            val stocks = p.optJSONObject("stocks")
                            if (stocks != null) {
                                for (k in stocks.keys()) insStock.exec(id, k.toIntOrNull() ?: 0, stocks.optDouble(k, 0.0))
                            } else {
                                insStock.exec(id, defaultDepot(), p.optDouble("vegaStock", 0.0))
                            }
                            val bcs = p.optJSONArray("barcodes")
                            for (j in 0 until (bcs?.length() ?: 0)) insBarcode.exec(bcs!!.getString(j), id)
                            yieldSometimes()
                        }
                        "shelves" -> r.eachObject { s ->
                            insShelf.exec(s.optInt("depot", defaultDepot()), s.getString("code").uppercase(), s.optString("zone", ""))
                            yieldSometimes()
                        }
                        "locations" -> r.eachObject { l ->
                            insLocation.exec(l.optInt("depot", defaultDepot()), l.getString("productId"), l.getString("shelf").uppercase(), l.getDouble("qty"), Buckets.of(l.getString("productId")))
                            yieldSometimes()
                        }
                        "homes" -> r.eachObject { h ->
                            insHome.exec(h.optInt("depot", defaultDepot()), h.getString("productId"), h.getString("shelf").uppercase(), Buckets.of(h.getString("productId")))
                            yieldSometimes()
                        }
                        else -> head.put(key, r.readValue())
                    }
                }
                r.endObject()
            }
            applyHead(db, head)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return head
    }

    /** Elimizdeki ana veri parçalarının özetleri; sunucu yalnız farklı olanları gönderir. */
    fun masterParts(): Map<String, String> =
        query("SELECT key, hash FROM master_part") { it.getString(0) to it.getString(1) }.toMap()

    /** Sonraki eşitlemede bütün parçalar yeniden istensin (sunucu bir işlemi reddettiğinde). */
    fun clearMasterParts() {
        writableDatabase.delete("master_part", null, null)
    }

    /** [applyParts] sonucu: sunucuda kalan değişmiş kova sayısı ve geldiyse "head" (depo, belge, uygulama sürümü). */
    class PartsResult(val remaining: Int, val head: JSONObject?, val parts: Int, val surum: Int = -1)

    /**
     * Sunucunun `/api/master/parts` cevabını akıştan okur. Her parça (head, raflar, bir kova) kendi kısa işlemiyle
     * yazılır: kullanıcı kayıt yaparsa en çok bir kovanın (~2 bin ürün) yazılmasını bekler, ekran donmaz;
     * bağlantı yarıda koparsa yazılan kovalar kalır, sonraki tur kaldığı yerden devam eder.
     */
    fun applyParts(input: Reader): PartsResult {
        var remaining = 0
        var head: JSONObject? = null
        var parts = 0
        var surum = -1
        val db = writableDatabase
        JsonReader(input).use { r ->
            r.beginObject()
            while (r.hasNext()) {
                when (r.nextName()) {
                    "buckets" -> r.nextInt().let { if (it != Buckets.COUNT) throw java.io.IOException("Sunucunun kova sayısı farklı ($it)") }
                    "remaining" -> remaining = r.nextInt()
                    "surum" -> surum = r.nextInt()
                    "parts" -> {
                        r.beginArray()
                        while (r.hasNext()) {
                            r.beginObject()
                            var key = ""
                            var hash = ""
                            while (r.hasNext()) {
                                when (r.nextName()) {
                                    "key" -> key = r.nextString()
                                    "hash" -> hash = r.nextString()
                                    "data" -> {
                                        db.beginTransaction()
                                        try {
                                            when {
                                                key == "head" -> (r.readValue() as JSONObject).also { applyHead(db, it); head = it }
                                                key == "shelves" -> writeShelves(db, r)
                                                key.startsWith("b") -> writeBucket(db, key.substring(1).toInt(), r)
                                                key.startsWith("q") -> writeStock(db, key.substring(1).toInt(), r)
                                                else -> r.skipValue()
                                            }
                                            db.insertWithOnConflict("master_part", null, ContentValues().apply {
                                                put("key", key); put("hash", hash)
                                            }, SQLiteDatabase.CONFLICT_REPLACE)
                                            db.setTransactionSuccessful()
                                        } finally {
                                            db.endTransaction()
                                        }
                                        parts++
                                    }
                                    else -> r.skipValue()
                                }
                            }
                            r.endObject()
                        }
                        r.endArray()
                    }
                    else -> r.skipValue()
                }
            }
            r.endObject()
        }
        return PartsResult(remaining, head, parts, surum)
    }

    private fun writeShelves(db: SQLiteDatabase, r: JsonReader) {
        db.delete("shelf", null, null)
        val ins = db.compileStatement("INSERT OR REPLACE INTO shelf(depot, code, zone) VALUES(?,?,?)")
        r.eachObject { s -> ins.exec(s.optInt("depot", 0), s.getString("code").uppercase(), s.optString("zone", "")) }
    }

    /**
     * Bir kovanın Vega stoku (v2 sunucu, `q` parçası): kovadaki ürünlerin stokları baştan yazılır. Parçada olmayan ürünün
     * stoku 0'dır. Kovada olmayan ürün satırı alınmaz (kova henüz gelmediyse stok öksüz kalmasın).
     */
    private fun writeStock(db: SQLiteDatabase, b: Int, r: JsonReader) {
        val arg = arrayOf(b.toString())
        db.execSQL("DELETE FROM product_stock WHERE product_id IN (SELECT id FROM product WHERE bucket=?)", arg)
        db.execSQL("UPDATE product SET vega_stock=0 WHERE bucket=?", arg)
        val upd = db.compileStatement("UPDATE product SET vega_stock=? WHERE id=?")
        val insStock = db.compileStatement("INSERT OR REPLACE INTO product_stock(product_id, depot, qty) VALUES(?,?,?)")
        r.beginObject()
        while (r.hasNext()) {
            when (r.nextName()) {
                "items" -> r.eachObject { item ->
                    val id = item.getString("id")
                    upd.clearBindings()
                    upd.bindDouble(1, item.optDouble("vs", 0.0))
                    upd.bindString(2, id)
                    if (upd.executeUpdateDelete() > 0) {
                        val st = item.optJSONObject("st")
                        if (st != null) for (k in st.keys()) insStock.exec(id, k.toIntOrNull() ?: 0, st.optDouble(k, 0.0))
                    }
                }
                else -> r.skipValue()
            }
        }
        r.endObject()
    }

    private fun writeBucket(db: SQLiteDatabase, b: Int, r: JsonReader) {
        val arg = arrayOf(b.toString())
        // Kova yeniden yazılırken stoku silinir (v2'de stok ayrı `q` parçasında gelir); stok özeti unutulur ki bağlantı
        // yarıda kalırsa sonraki turda sunucu stok parçasını yeniden göndersin.
        db.delete("master_part", "key=?", arrayOf("q$b"))
        db.execSQL("DELETE FROM product_stock WHERE product_id IN (SELECT id FROM product WHERE bucket=?)", arg)
        db.execSQL("DELETE FROM barcode WHERE product_id IN (SELECT id FROM product WHERE bucket=?)", arg)
        for (t in listOf("product", "location", "home")) db.delete(t, "bucket=?", arg)
        val insProduct = db.compileStatement("INSERT OR REPLACE INTO product(id, code, name, unit, vega_stock, bucket, search) VALUES(?,?,?,?,?,?,?)")
        val insStock = db.compileStatement("INSERT OR REPLACE INTO product_stock(product_id, depot, qty) VALUES(?,?,?)")
        val insBarcode = db.compileStatement("INSERT OR REPLACE INTO barcode(code, product_id) VALUES(?,?)")
        val insLocation = db.compileStatement("INSERT OR REPLACE INTO location(depot, product_id, shelf, qty, bucket) VALUES(?,?,?,?,?)")
        val insHome = db.compileStatement("INSERT OR REPLACE INTO home(depot, product_id, shelf, bucket) VALUES(?,?,?,?)")
        r.beginObject()
        while (r.hasNext()) {
            when (r.nextName()) {
                "products" -> r.eachObject { p ->
                    val id = p.getString("id")
                    insProduct.exec(id, p.getString("code"), p.getString("name"), p.optString("unit", "Adet"), p.optDouble("vegaStock", 0.0), b, Fuzzy.searchKey(p.getString("code"), p.getString("name")))
                    val stocks = p.optJSONObject("stocks")
                    if (stocks != null) for (k in stocks.keys()) insStock.exec(id, k.toIntOrNull() ?: 0, stocks.optDouble(k, 0.0))
                    val bcs = p.optJSONArray("barcodes")
                    for (j in 0 until (bcs?.length() ?: 0)) insBarcode.exec(bcs!!.getString(j), id)
                }
                "locations" -> r.eachObject { l ->
                    insLocation.exec(l.optInt("depot", 0), l.getString("productId"), l.getString("shelf").uppercase(), l.getDouble("qty"), b)
                }
                "homes" -> r.eachObject { h ->
                    insHome.exec(h.optInt("depot", 0), h.getString("productId"), h.getString("shelf").uppercase(), b)
                }
                else -> r.skipValue()
            }
        }
        r.endObject()
    }

    /** Depolar, açık belgeler, sayım oturumları ve kullanıcılar. Çağıran işlemin içinde. */
    private fun applyHead(db: SQLiteDatabase, head: JSONObject) {
        val dd = head.optInt("defaultDepot", 0)
        for (t in listOf("depot", "receipt", "receipt_line", "app_user")) db.delete(t, null, null)
        val depots = head.optJSONArray("depots")
        for (i in 0 until (depots?.length() ?: 0)) {
            val d = depots!!.getJSONObject(i)
            db.insertWithOnConflict("depot", null, ContentValues().apply {
                put("id", d.getInt("id")); put("name", d.optString("name", d.getInt("id").toString()))
            }, SQLiteDatabase.CONFLICT_REPLACE)
        }
        val receipts = head.optJSONArray("receipts")
        for (i in 0 until (receipts?.length() ?: 0)) {
            val r = receipts!!.getJSONObject(i)
            db.insert("receipt", null, ContentValues().apply {
                put("id", r.getString("id"))
                put("doc_no", r.getString("docNo"))
                put("supplier", r.optString("supplier", ""))
                put("date", r.optString("date", ""))
                put("depot", r.optInt("depot", dd))
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
        val counts = head.optJSONArray("counts")
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
                put("depot", c.optInt("depot", dd))
                val scope = c.optJSONArray("scope")
                put("scope", (0 until (scope?.length() ?: 0)).joinToString(",") { scope!!.getString(it) })
            }, SQLiteDatabase.CONFLICT_REPLACE)
        }
        // Sunucuda artık açık olmayan oturumlar (yöneticide kapatılan, iptal edilen, gönderilmiş) cihazdan kalkar.
        // Cihazda başlatılıp henüz gönderilmemiş serbest sayım (LOCAL-) sunucuda yoktur; o kalır.
        query("SELECT id, status FROM count_session") { it.getString(0) to it.getString(1) }
            .filter { (id, status) -> id !in serverIds && (!id.startsWith("LOCAL-") || status == "SUBMITTED") }
            .forEach { (id, _) ->
                for (t in listOf("count_line", "count_shelf")) db.delete(t, "session_id=?", arrayOf(id))
                db.delete("count_session", "id=?", arrayOf(id))
            }
        val users = head.optJSONArray("users")
        for (i in 0 until (users?.length() ?: 0)) {
            val u = users!!.getJSONObject(i)
            db.insert("app_user", null, ContentValues().apply {
                put("username", u.getString("username").lowercase())
                put("name", u.optString("name", u.getString("username")))
                put("pin_hash", u.getString("pinHash"))
                put("salt", u.getString("salt"))
            })
        }
    }

    private fun SQLiteStatement.exec(vararg args: Any) {
        clearBindings()
        args.forEachIndexed { i, v ->
            when (v) {
                is Int -> bindLong(i + 1, v.toLong())
                is Double -> bindDouble(i + 1, v)
                else -> bindString(i + 1, v.toString())
            }
        }
        executeInsert()
    }

    /** Dizideki nesneleri birer birer okur; dizinin tamamı belleğe alınmaz. */
    private inline fun JsonReader.eachObject(f: (JSONObject) -> Unit) {
        if (peek() == JsonToken.NULL) return nextNull()
        beginArray()
        while (hasNext()) {
            val o = readValue()
            if (o is JSONObject) f(o)
        }
        endArray()
    }

    private fun JsonReader.readValue(): Any = when (peek()) {
        JsonToken.BEGIN_OBJECT -> JSONObject().also { o ->
            beginObject()
            while (hasNext()) o.put(nextName(), readValue())
            endObject()
        }
        JsonToken.BEGIN_ARRAY -> JSONArray().also { a ->
            beginArray()
            while (hasNext()) a.put(readValue())
            endArray()
        }
        JsonToken.NUMBER -> nextString().let { it.toLongOrNull() ?: it.toDouble() }
        JsonToken.BOOLEAN -> nextBoolean()
        JsonToken.NULL -> JSONObject.NULL.also { nextNull() }
        else -> nextString()
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

    /**
     * Ad ya da kodla, yazım hatasına dayanıklı arama. En iyi [limit] sonuç. Ürün listesi belleğe alınmaz (130 bin ürün
     * düşük belleli terminalde taşıyordu): 1) her kelimeyi içeren kartlar SQL'de bulunur, 2) az sonuç varsa yazım
     * hatası için kelimelerin ilk iki harfiyle başlayan sözcükleri olan kartlar (en çok 4000) puanlanır.
     * [cancelled] true olursa arama bırakılır (kullanıcı yazmaya devam etti).
     */
    fun searchProducts(q: String, limit: Int = 40, cancelled: () -> Boolean = { false }): List<Product> {
        val tokens = Fuzzy.tokens(q)
        if (tokens.isEmpty()) return emptyList()
        val t0 = System.currentTimeMillis()
        val compact = tokens.joinToString("")
        val scored = HashMap<String, Pair<Fuzzy.Entry, Double>>()
        fun consider(rows: List<Fuzzy.Entry>) {
            for (e in rows) {
                val sc = Fuzzy.score(tokens, compact, e)
                if (sc > 0) scored[e.id] = e to sc
            }
        }
        val entry = { c: Cursor -> Fuzzy.Entry(c.getString(0), c.getString(1), c.getString(2)) }
        consider(
            query(
                "SELECT id, code, name FROM product WHERE " + tokens.joinToString(" AND ") { "search LIKE ?" } + " LIMIT 3000",
                *tokens.map { "%$it%" }.toTypedArray(), map = entry,
            ),
        )
        if (cancelled()) return emptyList()
        if (scored.size < limit) {
            val pre = tokens.filter { it.length >= 3 }.map { it.take(2) }.distinct()
            if (pre.isNotEmpty()) {
                consider(
                    query(
                        "SELECT id, code, name FROM product WHERE " + pre.joinToString(" OR ") { "search LIKE ? OR search LIKE ?" } + " LIMIT 4000",
                        *pre.flatMap { listOf("$it%", "% $it%") }.toTypedArray(), map = entry,
                    ),
                )
                if (cancelled()) return emptyList()
            }
        }
        val sonuc = scored.values
            .sortedWith(compareByDescending<Pair<Fuzzy.Entry, Double>> { it.second }.thenBy { it.first.nName })
            .take(limit)
            .mapNotNull { productById(it.first.id) }
        val ms = System.currentTimeMillis() - t0
        android.util.Log.d("arama", "\"$q\" → ${sonuc.size} sonuç, ${scored.size} aday, $ms ms")
        // Yavaş arama uzaktan raporda görünsün (düşük donanımlı terminallerde ölçmek için).
        if (ms > 400) tr.arcteknik.depo.diag.Diag.crumb("arama yavaş: $ms ms (${scored.size} aday)")
        return sonuc
    }

    fun shelfExists(code: String, d: Int = depot): Boolean =
        scalar("SELECT 1 FROM shelf WHERE depot=? AND code=?", d.toString(), code.trim().uppercase()) != null

    fun locationsOf(productId: String, d: Int = depot): List<Location> {
        val p = productById(productId, d) ?: return emptyList()
        return query("SELECT shelf, qty FROM location WHERE depot=? AND product_id=? AND qty>0 ORDER BY qty DESC", d.toString(), productId) {
            Location(p, it.getString(0), it.getDouble(1))
        }
    }

    /** Ürünün zimmetli rafları (Excel, Vega kartı, yönetici); rafta hiç yokken rafa kaldırmada ilki önerilir. */
    fun homeShelves(productId: String, d: Int = depot): List<String> =
        query("SELECT shelf FROM home WHERE depot=? AND product_id=? ORDER BY shelf", d.toString(), productId) { it.getString(0) }

    fun homeShelf(productId: String, d: Int = depot): String? = homeShelves(productId, d).firstOrNull()

    /** Raftakiler + rafa zimmetli olup rafta olmayanlar (qty 0, sayılmayı bekliyor). */
    fun shelfContents(shelf: String, d: Int = depot): List<Location> {
        val s = shelf.uppercase()
        val homed = query("SELECT product_id FROM home WHERE depot=? AND shelf=?", d.toString(), s) { it.getString(0) }.toSet()
        val here = query("SELECT ${productCols(d)}, l.shelf, l.qty FROM location l JOIN product p ON p.id=l.product_id WHERE l.depot=? AND l.shelf=? AND l.qty>0 ORDER BY p.name", d.toString(), s) {
            val p = it.product()
            Location(p, it.getString(6), it.getDouble(7), p.id in homed)
        }
        val present = here.map { it.product.id }.toSet()
        val expected = query("SELECT ${productCols(d)} FROM home h JOIN product p ON p.id=h.product_id WHERE h.depot=? AND h.shelf=? ORDER BY p.name", d.toString(), s) { it.product() }
            .filter { it.id !in present }
            .map { Location(it, s, 0.0, true) }
        return here + expected
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
    fun receipts(open: Boolean): List<Receipt> = receiptRows("").filter { (it.doneLines < it.lineCount) == open }

    private fun receiptRows(where: String, vararg args: String): List<Receipt> = query(
        "SELECT r.id, r.doc_no, r.supplier, r.date, COUNT(l.id), SUM(CASE WHEN l.shelved>=l.accepted THEN 1 ELSE 0 END), r.depot, r.depot_name " +
            "FROM receipt r LEFT JOIN receipt_line l ON l.receipt_id=r.id $where GROUP BY r.id ORDER BY (r.depot<>$depot), r.date DESC, r.doc_no DESC",
        *args,
    ) { Receipt(it.getString(0), it.getString(1), it.getString(2), it.getString(3), it.getInt(4), it.getInt(5), it.getInt(6), it.getString(7)) }

    /** Tek belge; açık ya da kapalı (eskiden bütün belgeler iki kez gruplanıyordu). */
    fun receipt(id: String): Receipt? = receiptRows("WHERE r.id=?", id).firstOrNull()

    /** Belge satırları; Vega stoku belgenin deposundaki. */
    fun receiptLines(receiptId: String): List<ReceiptLine> {
        val d = scalar("SELECT depot FROM receipt WHERE id=?", receiptId)?.toIntOrNull() ?: depot
        return query("SELECT l.id, l.receipt_id, ${productCols(d)}, l.accepted, l.shelved FROM receipt_line l JOIN product p ON p.id=l.product_id WHERE l.receipt_id=? ORDER BY (l.shelved>=l.accepted), p.name", receiptId) {
            ReceiptLine(it.getString(0), it.getString(1), it.product(2), it.getDouble(8), it.getDouble(9))
        }
    }

    /** Çalışılan depodaki açık sayımlar. */
    fun countSessions(): List<CountSession> =
        query("SELECT id, no, title, blind, status, depot, scope FROM count_session WHERE status='OPEN' AND depot=? ORDER BY no DESC", depot.toString()) { it.countSession() }

    fun countSession(id: String): CountSession? =
        query("SELECT id, no, title, blind, status, depot, scope FROM count_session WHERE id=?", id) { it.countSession() }.firstOrNull()

    private fun Cursor.countSession() = CountSession(
        getString(0), getString(1), getString(2), getInt(3) == 1, getString(4), getInt(5),
        getString(6).split(',').filter { it.isNotBlank() },
    )

    /** Depoda sayımın kapsamına uyan tanımlı raflar. */
    fun scopeShelves(session: CountSession): List<String> =
        if (session.scope.isEmpty()) emptyList()
        else query("SELECT code FROM shelf WHERE depot=? ORDER BY code", session.depot.toString()) { it.getString(0) }.filter { Kapsam.icinde(it, session.scope) }.sortedWith(Kapsam.order)

    fun countLines(sessionId: String, shelf: String? = null): List<CountLine> {
        val where = if (shelf == null) "c.session_id=?" else "c.session_id=? AND c.shelf=?"
        val args = if (shelf == null) arrayOf(sessionId) else arrayOf(sessionId, shelf)
        return query("SELECT c.shelf, ${productCols()}, c.qty FROM count_line c JOIN product p ON p.id=c.product_id WHERE $where ORDER BY c.shelf, p.name", *args) {
            CountLine(it.getString(0), it.product(1), it.getDouble(7))
        }
    }

    fun countedShelves(sessionId: String): List<String> =
        query("SELECT shelf FROM count_line WHERE session_id=? UNION SELECT shelf FROM count_shelf WHERE session_id=? ORDER BY 1", sessionId, sessionId) { it.getString(0) }

    fun ops(): List<Op> =
        query("SELECT id, type, payload, summary, created_at, status, error FROM op ORDER BY created_at") {
            Op(it.getString(0), it.getString(1), it.getString(2), it.getString(3), it.getLong(4), it.getString(5), it.getString(6))
        }

    fun pendingOpCount(): Int = scalar("SELECT COUNT(*) FROM op")?.toIntOrNull() ?: 0

    /** Gönderilmeyi bekleyen (hata almamış) işlem sayısı. */
    fun pendingCount(): Int = scalar("SELECT COUNT(*) FROM op WHERE status=?", OpStatus.PENDING)?.toIntOrNull() ?: 0

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
                put("depot", d); put("product_id", productId); put("shelf", shelf); put("qty", qty); put("bucket", Buckets.of(productId))
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
        val db = writableDatabase
        for (t in listOf("product", "product_stock", "barcode", "depot", "shelf", "location", "home", "receipt", "receipt_line", "count_session", "count_line", "count_shelf", "op", "movement", "app_user", "master_part")) {
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
