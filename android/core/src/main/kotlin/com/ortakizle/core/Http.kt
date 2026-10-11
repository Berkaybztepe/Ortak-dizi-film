package com.ortakizle.core

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URLDecoder

// Minimal HTTP/1.1 istek ayrıştırma

class HttpRequest(
    val method: String,
    val target: String,
    val version: String,
    val headers: Map<String, String>, // anahtarlar küçük harf
) {
    fun header(name: String): String? = headers[name.lowercase()]
}

class HttpBadRequest(message: String) : IOException(message)

private const val MAX_HEADER_BYTES = 16 * 1024

/** Başlıkları okur; bağlantı istekten önce kapandıysa null döner. */
fun readHttpRequest(input: InputStream): HttpRequest? {
    val buf = ByteArrayOutputStream()
    var tail = 0 // son 4 baytı tutar; "\r\n\r\n" veya "\n\n" başlık sonudur
    while (true) {
        val b = input.read()
        if (b < 0) {
            if (buf.size() == 0) return null
            throw HttpBadRequest("eksik istek")
        }
        // İstekler arasındaki boş satırları atla
        if (buf.size() == 0 && (b == '\r'.code || b == '\n'.code)) continue
        buf.write(b)
        if (buf.size() > MAX_HEADER_BYTES) throw HttpBadRequest("başlık çok büyük")
        tail = (tail shl 8) or b
        if (tail == 0x0D0A0D0A || (tail and 0xFFFF) == 0x0A0A) break
    }
    val lines = buf.toString(Charsets.ISO_8859_1).split("\r\n", "\n").filter { it.isNotEmpty() }
    val parts = lines.firstOrNull()?.split(' ')?.filter { it.isNotEmpty() } ?: throw HttpBadRequest("boş istek")
    if (parts.size != 3 || !parts[2].startsWith("HTTP/")) throw HttpBadRequest("bozuk istek satırı")
    val headers = LinkedHashMap<String, String>()
    for (line in lines.drop(1)) {
        val i = line.indexOf(':')
        if (i <= 0) continue
        val k = line.substring(0, i).trim().lowercase()
        val v = line.substring(i + 1).trim()
        headers[k] = headers[k]?.let { "$it, $v" } ?: v
    }
    return HttpRequest(parts[0].uppercase(), parts[1], parts[2], headers)
}

/**
 * İstek hedefinden yolu çıkarır, "." ve ".." parçalarını tarayıcıdaki URL gibi
 * köke sabitleyerek çözer ve yüzde kodlamasını açar. Sonuç "/" ile başlar.
 * Çözülmüş parçada "/", "\" veya NUL varsa null döner (yasak).
 */
fun normalizePath(target: String): String? {
    var t = target
    // Mutlak biçim: http://host/yol
    val scheme = t.indexOf("://")
    if (scheme in 1..10 && !t.startsWith("/")) {
        val slash = t.indexOf('/', scheme + 3)
        t = if (slash < 0) "/" else t.substring(slash)
    }
    t = t.substringBefore('#').substringBefore('?')
    if (!t.startsWith("/")) t = "/$t"
    val raw = t.substring(1).split('/')
    val out = ArrayList<String>()
    for ((idx, seg) in raw.withIndex()) {
        val low = seg.lowercase()
        val isLast = idx == raw.lastIndex
        when (low) {
            ".", "%2e" -> if (isLast) out.add("")
            "..", ".%2e", "%2e.", "%2e%2e" -> {
                if (out.isNotEmpty()) out.removeAt(out.lastIndex)
                if (isLast) out.add("")
            }
            else -> out.add(seg)
        }
    }
    val decoded = out.map { seg ->
        val d = try {
            URLDecoder.decode(seg.replace("+", "%2B"), "UTF-8")
        } catch (e: Exception) {
            return null
        }
        if (d.contains('/') || d.contains('\\') || d.contains('\u0000') || d == ".." || d == ".") return null
        d
    }
    return "/" + decoded.joinToString("/")
}

private val MIME = mapOf(
    "html" to "text/html; charset=utf-8",
    "htm" to "text/html; charset=utf-8",
    "js" to "text/javascript; charset=utf-8",
    "mjs" to "text/javascript; charset=utf-8",
    "css" to "text/css; charset=utf-8",
    "svg" to "image/svg+xml",
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "webp" to "image/webp",
    "ico" to "image/x-icon",
    "woff2" to "font/woff2",
    "woff" to "font/woff",
    "json" to "application/json",
    "webmanifest" to "application/manifest+json",
    "txt" to "text/plain; charset=utf-8",
)

fun mimeType(path: String): String {
    val name = path.substringAfterLast('/')
    val ext = if (name.contains('.')) name.substringAfterLast('.').lowercase() else ""
    return MIME[ext] ?: "application/octet-stream"
}
