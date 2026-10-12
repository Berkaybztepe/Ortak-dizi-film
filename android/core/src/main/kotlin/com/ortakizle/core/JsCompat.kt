package com.ortakizle.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.net.IDN

// server.js'deki JavaScript davranışlarının (truthy, trim, URL) Kotlin karşılıkları

/** JSON string ise içeriği, değilse null (typeof v === 'string'). */
internal fun jsString(v: JsonElement?): String? =
    (v as? JsonPrimitive)?.takeIf { it.isString }?.content

/** JSON sayı ise değeri (typeof v === 'number'). */
internal fun jsNumber(v: JsonElement?): Double? =
    (v as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull && it.booleanOrNull == null }?.doubleOrNull

/** JavaScript'teki !!v */
internal fun truthy(v: JsonElement?): Boolean = when (v) {
    null, JsonNull -> false
    is JsonObject, is JsonArray -> true
    is JsonPrimitive -> when {
        v.isString -> v.content.isNotEmpty()
        v.booleanOrNull != null -> v.booleanOrNull!!
        else -> v.doubleOrNull.let { it != null && it != 0.0 && !it.isNaN() }
    }
}

/** Sayıyı JS'teki gibi yazar: tam sayıysa ondalıksız (42.0 -> 42). */
internal fun numJson(d: Double): JsonPrimitive =
    if (d.isFinite() && d == Math.floor(d) && Math.abs(d) < 1e15) JsonPrimitive(d.toLong()) else JsonPrimitive(d)

private fun isJsSpace(c: Char): Boolean = when (c) {
    '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ', ' ',
    ' ', ' ', '　', '﻿' -> true
    else -> c in ' '..' '
}

/** String.prototype.trim */
internal fun jsTrim(s: String): String = s.trim(::isJsSpace)

/** cleanStr: string ise ilk max UTF-16 birimi, değilse "" */
internal fun cleanStr(v: JsonElement?, max: Int = 200): String = jsString(v)?.take(max) ?: ""

/** cleanNum: sonlu ve >= 0 sayı, değilse 0 */
internal fun cleanNum(v: JsonElement?): Double = jsNumber(v)?.takeIf { it.isFinite() && it >= 0 } ?: 0.0

// --- URL (WHATWG URL'nin http/https için sadeleştirilmiş hali) ---

private const val HEX = "0123456789ABCDEF"

private fun encodeSet(s: String, extra: String): String {
    val sb = StringBuilder()
    var i = 0
    while (i < s.length) {
        val cp = s.codePointAt(i)
        val n = Character.charCount(cp)
        if (cp < 0x20 || cp > 0x7E || extra.indexOf(cp.toChar()) >= 0 && cp < 0x80) {
            for (b in String(Character.toChars(cp)).toByteArray(Charsets.UTF_8)) {
                val x = b.toInt() and 0xFF
                sb.append('%').append(HEX[x shr 4]).append(HEX[x and 15])
            }
        } else {
            sb.appendCodePoint(cp)
        }
        i += n
    }
    return sb.toString()
}

private const val FRAGMENT_SET = " \"<>`"
private const val QUERY_SET = " \"#<>'"
private const val PATH_SET = " \"#<>?`{}"
private const val USERINFO_SET = " \"#<>?`{}/:;=@[\\]^|"
private const val FORBIDDEN_HOST = "\u0000\t\n\r #/:<>?@[\\]^|%"

private fun isDot(seg: String) = seg == "." || seg.equals("%2e", true)
private fun isDotDot(seg: String) = when (seg.lowercase()) {
    "..", ".%2e", "%2e.", "%2e%2e" -> true
    else -> false
}

/** cleanUrl: sadece http/https, en fazla 2000 karakter; geçersizse null. */
internal fun cleanUrl(v: JsonElement?): String? = jsString(v)?.let { normalizeHttpUrl(it) }?.take(2000)

internal fun normalizeHttpUrl(input: String): String? {
    val s = input.trim { it <= ' ' }.filter { it != '\t' && it != '\n' && it != '\r' }
    val colon = s.indexOf(':')
    if (colon <= 0) return null
    val scheme = s.substring(0, colon).lowercase()
    if (scheme != "http" && scheme != "https") return null
    val rest = s.substring(colon + 1).trimStart('/', '\\')
    val authEnd = rest.indexOfFirst { it == '/' || it == '\\' || it == '?' || it == '#' }.let { if (it < 0) rest.length else it }
    val authority = rest.substring(0, authEnd)
    var tail = rest.substring(authEnd)

    // Kullanıcı bilgisi
    val at = authority.lastIndexOf('@')
    val userinfo = if (at >= 0) authority.substring(0, at) else ""
    val hostPort = authority.substring(at + 1)

    // Sunucu ve port
    var host: String
    var port = ""
    if (hostPort.startsWith("[")) {
        val end = hostPort.indexOf(']')
        if (end < 0) return null
        host = hostPort.substring(0, end + 1).lowercase()
        if (!host.substring(1, host.length - 1).all { it.isLetterOrDigit() && it.code < 128 || it == ':' || it == '.' }) return null
        val after = hostPort.substring(end + 1)
        if (after.isNotEmpty()) {
            if (!after.startsWith(":")) return null
            port = after.substring(1)
        }
    } else {
        val c = hostPort.lastIndexOf(':')
        host = if (c >= 0) hostPort.substring(0, c) else hostPort
        if (c >= 0) port = hostPort.substring(c + 1)
        host = try {
            java.net.URLDecoder.decode(host.replace("+", "%2B"), "UTF-8")
        } catch (e: Exception) {
            return null
        }
        if (host.any { it.code >= 128 }) {
            host = try {
                IDN.toASCII(host, IDN.ALLOW_UNASSIGNED)
            } catch (e: Exception) {
                return null
            }
        }
        host = host.lowercase()
        if (host.any { it.code < 0x20 || it.code == 0x7F || FORBIDDEN_HOST.indexOf(it) >= 0 }) return null
    }
    if (host.isEmpty()) return null
    if (port.isNotEmpty()) {
        if (!port.all { it in '0'..'9' }) return null
        val p = port.trimStart('0').ifEmpty { "0" }
        if (p.length > 5 || p.toInt() > 65535) return null
        port = if ((scheme == "http" && p == "80") || (scheme == "https" && p == "443")) "" else p
    }

    // Yol, sorgu, parça
    var fragment: String? = null
    val hash = tail.indexOf('#')
    if (hash >= 0) {
        fragment = tail.substring(hash + 1)
        tail = tail.substring(0, hash)
    }
    var query: String? = null
    val q = tail.indexOf('?')
    if (q >= 0) {
        query = tail.substring(q + 1)
        tail = tail.substring(0, q)
    }
    val segs = tail.replace('\\', '/').removePrefix("/").split('/')
    val out = ArrayList<String>()
    for ((i, seg) in segs.withIndex()) {
        val last = i == segs.lastIndex
        when {
            isDotDot(seg) -> {
                if (out.isNotEmpty()) out.removeAt(out.lastIndex)
                if (last) out.add("")
            }
            isDot(seg) -> if (last) out.add("")
            else -> out.add(encodeSet(seg, PATH_SET))
        }
    }
    val path = "/" + out.joinToString("/")

    val sb = StringBuilder(scheme).append("://")
    if (userinfo.isNotEmpty()) {
        val ci = userinfo.indexOf(':')
        val user = encodeSet(if (ci >= 0) userinfo.substring(0, ci) else userinfo, USERINFO_SET)
        val pass = if (ci >= 0) encodeSet(userinfo.substring(ci + 1), USERINFO_SET) else ""
        if (user.isNotEmpty() || pass.isNotEmpty()) {
            sb.append(user)
            if (pass.isNotEmpty()) sb.append(':').append(pass)
            sb.append('@')
        }
    }
    sb.append(host)
    if (port.isNotEmpty()) sb.append(':').append(port)
    sb.append(path)
    if (query != null) sb.append('?').append(encodeSet(query, QUERY_SET))
    if (fragment != null) sb.append('#').append(encodeSet(fragment, FRAGMENT_SET))
    return sb.toString()
}
