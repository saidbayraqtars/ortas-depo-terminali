package tr.arcteknik.depo.data

data class Product(
    val id: String,
    val code: String,
    val name: String,
    val unit: String,
    /** Vega'daki toplam stok; raflardaki toplamla karşılaştırmak için. */
    val vegaStock: Double,
    val barcode: String?,
)

data class Shelf(val code: String, val zone: String)

/** Vega deposu (F{firma}TBLDEPOLAR.IND). */
data class Depot(val id: Int, val name: String)

/** [assigned]: ürün bu rafa zimmetli; qty 0 ise rafta hiç sayılmamış (beklenen). */
data class Location(val product: Product, val shelf: String, val qty: Double, val assigned: Boolean = false)

data class Receipt(
    val id: String,
    val docNo: String,
    val supplier: String,
    val date: String,
    val lineCount: Int,
    val doneLines: Int,
    /** Belge depo bazlı: rafa kaldırma bu depoda olur. */
    val depot: Int = 0,
    val depotName: String = "",
)

data class ReceiptLine(
    val id: String,
    val receiptId: String,
    val product: Product,
    val accepted: Double,
    val shelved: Double,
) {
    val remaining: Double get() = (accepted - shelved).coerceAtLeast(0.0)
}

data class CountSession(
    val id: String,
    val no: String,
    val title: String,
    /** Kör sayımda sayan kişi sistem miktarını görmez. */
    val blind: Boolean,
    val status: String,
    val depot: Int = 0,
    /** Raf önekleri (bkz. [Kapsam]); boşsa bütün raflar. */
    val scope: List<String> = emptyList(),
)

data class CountLine(val shelf: String, val product: Product, val qty: Double)

data class CountDiff(
    val shelf: String,
    val product: Product,
    val system: Double,
    val counted: Double,
) {
    val diff: Double get() = counted - system
}

data class Op(
    val id: String,
    val type: String,
    val payload: String,
    val summary: String,
    val createdAt: Long,
    val status: String,
    val error: String?,
)

data class Movement(val ts: Long, val text: String, val qty: Double)

data class User(val username: String, val name: String, val pinHash: String, val salt: String)

object OpStatus {
    const val PENDING = "PENDING"
    const val ERROR = "ERROR"
}

object OpType {
    const val PUTAWAY = "PUTAWAY"
    const val TRANSFER = "TRANSFER"
    const val COUNT_SUBMIT = "COUNT_SUBMIT"
    const val SHELF_ADD = "SHELF_ADD"
    /** Raftan alma (1.5.0+ sunucu). */
    const val PICK = "PICK"
}
