package tr.arcteknik.depo.data

/**
 * Ana verinin kovaları: ürün, stokları, barkodları, raf konumları ve zimmetleri ürün kimliğinin özetine göre
 * sabit [COUNT] kovadan birindedir. Sunucu yalnız değişen kovaları gönderir (yonetici/server/depo.js `kova`).
 * İki taraf aynı sonucu vermeli: FNV-1a 32 bit, UTF-16 kod birimleri üzerinden.
 */
object Buckets {
    const val COUNT = 64

    fun of(id: String): Int {
        var h = 0x811c9dc5.toInt()
        for (c in id) {
            h = h xor c.code
            h *= 16777619
        }
        return ((h.toLong() and 0xffffffffL) % COUNT).toInt()
    }
}
