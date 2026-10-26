package tr.arcteknik.depo.data

/**
 * Raf sayımının kapsamı: sayılacak rafları seçen önekler ("K1", "KAT-1", "TK2-H"). Yönetici (server/kapsam.js) aynı kuralı uygular.
 * Önek bir sayı ya da harf dizisini bölmez: "K1" → K1, K1-A3, K1A-2; K10 değil. Sonda "*" varsa düz önek: "K1*" → K10 da.
 */
object Kapsam {
    private fun sinif(c: Char) = when {
        c.isDigit() -> 1
        c.isLetter() -> 2
        else -> 0
    }

    private fun uyar(kod: String, onek: String): Boolean {
        if (onek.endsWith("*")) return kod.startsWith(onek.dropLast(1))
        if (!kod.startsWith(onek)) return false
        if (kod.length == onek.length) return true
        val s = sinif(onek.last())
        return s == 0 || s != sinif(kod[onek.length])
    }

    /** Raf kodlarını sayıları sayı olarak sıralar: KAT-1-A-2, KAT-1-A-10 (A-10, A-2 değil). */
    private val parca = Regex("\\d+|\\D+")
    val order: Comparator<String> = Comparator { a, b ->
        val x = parca.findAll(a).map { it.value }.toList()
        val y = parca.findAll(b).map { it.value }.toList()
        for (i in 0 until minOf(x.size, y.size)) {
            val p = x[i]
            val q = y[i]
            val c = if (p[0].isDigit() && q[0].isDigit()) compareValuesBy(p, q, { it.length }, { it }) else p.compareTo(q)
            if (c != 0) return@Comparator c
        }
        x.size - y.size
    }

    /** Kapsam boşsa her raf kapsamdadır. */
    fun icinde(kod: String, onekler: List<String>): Boolean = onekler.isEmpty() || onekler.any { uyar(kod, it) }
}
