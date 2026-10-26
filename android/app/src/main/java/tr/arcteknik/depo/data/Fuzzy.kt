package tr.arcteknik.depo.data

import java.util.Locale

/**
 * İsimle arama: Türkçe harfler sadeleştirilir (ş→s, ı→i…), her kelime ayrı aranır, yazım hatası
 * (filitre ↔ filtre, amortisor ↔ amortisör) benzerlik oranıyla tolere edilir.
 * Aynı kurallar yönetici programında da var (yonetici/server/fuzzy.js); birini değiştiren ikisini de değiştirsin.
 */
object Fuzzy {
    private val TR = Locale("tr")

    /** Küçük harf, Türkçe harfler sadeleşmiş, harf/rakam dışı tek boşluk. 130 bin ürün için çağrılır: Regex yok, tek geçiş. */
    fun norm(s: String): String {
        val sb = StringBuilder(s.length)
        var bosluk = true // baştaki boşluk atılır
        for (ch in s.lowercase(TR)) {
            val c = when (ch) {
                'ç' -> 'c'; 'ğ' -> 'g'; 'ı' -> 'i'; 'ö' -> 'o'; 'ş' -> 's'; 'ü' -> 'u'
                'â' -> 'a'; 'î' -> 'i'; 'û' -> 'u'
                in 'a'..'z', in '0'..'9' -> ch
                else -> ' '
            }
            if (c == ' ') {
                if (!bosluk) sb.append(' ')
                bosluk = true
            } else {
                sb.append(c)
                bosluk = false
            }
        }
        if (sb.isNotEmpty() && sb[sb.length - 1] == ' ') sb.setLength(sb.length - 1)
        return sb.toString()
    }

    /**
     * Ürün satırındaki arama sütunu (`product.search`): sadeleşmiş ad, kod ve boşluksuz kod. Aramanın ilk adımı
     * bunda `LIKE '%kelime%'` ile yapılır; ürün listesinin hepsi belleğe alınmaz.
     */
    fun searchKey(code: String, name: String): String {
        val nCode = norm(code)
        return "${norm(name)} $nCode ${nCode.replace(" ", "")}".trim()
    }

    fun tokens(q: String): List<String> = norm(q).split(' ').filter { it.isNotEmpty() }

    /** 0..1; 1 = aynı. */
    fun similarity(a: String, b: String): Double {
        if (a == b) return 1.0
        val n = a.length
        val m = b.length
        if (n == 0 || m == 0) return 0.0
        var prev = IntArray(m + 1) { it }
        var cur = IntArray(m + 1)
        for (i in 1..n) {
            cur[0] = i
            for (j in 1..m) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                cur[j] = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            }
            val t = prev; prev = cur; cur = t
        }
        return 1.0 - prev[m].toDouble() / maxOf(n, m)
    }

    class Entry(val id: String, val code: String, val name: String) {
        val nCode = norm(code)
        val nCodeCompact = nCode.replace(" ", "")
        val nName = norm(name)
        val words = (nName.split(' ') + nCode.split(' ')).filter { it.isNotEmpty() }.distinct()
    }

    /** Sorgu ile kayıt arasındaki puan; 0 = eşleşmedi. */
    fun score(qTokens: List<String>, qCompact: String, e: Entry): Double {
        if (qTokens.isEmpty()) return 0.0
        if (qCompact.isNotEmpty() && e.nCodeCompact == qCompact) return 100.0
        var total = 0.0
        var missing = 0
        for (t in qTokens) {
            val s = when {
                e.nCodeCompact.startsWith(t) -> 4.0
                e.words.any { it.startsWith(t) } -> 3.0
                e.nName.contains(t) || e.nCode.contains(t) -> 2.0
                t.length < 3 -> 0.0
                else -> {
                    var best = 0.0
                    for (w in e.words) {
                        if (kotlin.math.abs(w.length - t.length) > 3 && w.length < t.length) continue
                        best = maxOf(best, similarity(t, w), similarity(t, w.take(t.length + 1)), similarity(t, w.take(t.length)))
                        if (best >= 0.99) break
                    }
                    if (best >= 0.7) best * 2 else 0.0
                }
            }
            if (s == 0.0) missing++
            total += s
        }
        // Kelimelerin yarısından fazlası tutmuyorsa sonuç değil.
        if (missing * 2 > qTokens.size) return 0.0
        return total / qTokens.size - missing * 0.8
    }
}
