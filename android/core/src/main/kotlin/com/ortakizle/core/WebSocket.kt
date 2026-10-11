package com.ortakizle.core

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.Base64

// Minimal WebSocket (RFC 6455) — metin mesajları, ping/pong ve kapanış.

const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const val WS_MAX_MESSAGE = 1 shl 20 // 1 MB

object Opcode {
    const val CONT = 0x0
    const val TEXT = 0x1
    const val BINARY = 0x2
    const val CLOSE = 0x8
    const val PING = 0x9
    const val PONG = 0xA
}

fun wsAccept(key: String): String {
    val sha = MessageDigest.getInstance("SHA-1").digest((key.trim() + WS_GUID).toByteArray(Charsets.US_ASCII))
    return Base64.getEncoder().encodeToString(sha)
}

// Sınırı aşan mesaj vb. için kapanış koduyla birlikte fırlatılır
class WsProtocolException(val code: Int, message: String) : IOException(message)

class WsFrame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

sealed class WsEvent {
    class Text(val text: String) : WsEvent()
    class Ping(val payload: ByteArray) : WsEvent()
    object Pong : WsEvent()
    class Close(val code: Int?) : WsEvent()
    object Eof : WsEvent()
}

// Tek bir çerçeve okur (maskeli/maskesiz, 7/16/64 bit uzunluk)
class FrameReader(private val input: InputStream, private val maxPayload: Int = WS_MAX_MESSAGE) {

    /** Bağlantı düzgün kapandıysa (çerçeve başında EOF) null döner. */
    fun readFrame(): WsFrame? {
        val b0 = input.read()
        if (b0 < 0) return null
        val b1 = readByte()
        val fin = (b0 and 0x80) != 0
        val opcode = b0 and 0x0F
        val masked = (b1 and 0x80) != 0
        var len = (b1 and 0x7F).toLong()
        if (len == 126L) {
            len = ((readByte() shl 8) or readByte()).toLong()
        } else if (len == 127L) {
            var v = 0L
            repeat(8) { v = (v shl 8) or readByte().toLong() }
            len = v
        }
        // 64 bit değer negatifse de (en üst bit) çok büyük sayılır
        if (len < 0 || len > maxPayload) throw WsProtocolException(1009, "çerçeve çok büyük")
        val mask = if (masked) readFully(4) else null
        val payload = readFully(len.toInt())
        if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
        return WsFrame(fin, opcode, payload)
    }

    private fun readByte(): Int {
        val b = input.read()
        if (b < 0) throw EOFException()
        return b
    }

    private fun readFully(n: Int): ByteArray {
        val out = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(out, off, n - off)
            if (r < 0) throw EOFException()
            off += r
        }
        return out
    }
}

// Çerçeveleri mesajlara çevirir: parçalı (continuation) mesajları birleştirir
class WsReader(input: InputStream, private val maxMessage: Int = WS_MAX_MESSAGE) {
    private val frames = FrameReader(input, maxMessage)
    private val fragments = ByteArrayOutputStream()
    private var fragOpcode = -1 // devam eden parçalı mesajın türü, yoksa -1

    fun next(): WsEvent {
        while (true) {
            val f = frames.readFrame() ?: return WsEvent.Eof
            when (f.opcode) {
                Opcode.CLOSE -> {
                    val code = if (f.payload.size >= 2) ((f.payload[0].toInt() and 0xFF) shl 8) or (f.payload[1].toInt() and 0xFF) else null
                    return WsEvent.Close(code)
                }
                Opcode.PING -> return WsEvent.Ping(f.payload)
                Opcode.PONG -> return WsEvent.Pong
                Opcode.TEXT, Opcode.BINARY, Opcode.CONT -> {
                    if (f.opcode != Opcode.CONT) {
                        fragments.reset()
                        fragOpcode = f.opcode
                    } else if (fragOpcode < 0) {
                        continue // başı olmayan devam çerçevesi: yok say
                    }
                    if (fragments.size() + f.payload.size > maxMessage) throw WsProtocolException(1009, "mesaj çok büyük")
                    fragments.write(f.payload)
                    if (!f.fin) continue
                    val op = fragOpcode
                    val data = fragments.toByteArray()
                    fragments.reset()
                    fragOpcode = -1
                    if (op == Opcode.TEXT) return WsEvent.Text(String(data, Charsets.UTF_8))
                    // İkili mesajlar kullanılmıyor: yok say
                }
                else -> continue // bilinmeyen opcode: yok say
            }
        }
    }
}

// Sunucudan giden çerçeve: maskesiz, tek parça
fun encodeFrame(opcode: Int, payload: ByteArray): ByteArray {
    val len = payload.size
    val headerLen = when {
        len < 126 -> 2
        len < 65536 -> 4
        else -> 10
    }
    val out = ByteArray(headerLen + len)
    out[0] = (0x80 or opcode).toByte()
    when (headerLen) {
        2 -> out[1] = len.toByte()
        4 -> {
            out[1] = 126
            out[2] = (len ushr 8).toByte()
            out[3] = len.toByte()
        }
        else -> {
            out[1] = 127
            val l = len.toLong()
            for (i in 0 until 8) out[2 + i] = (l ushr (56 - 8 * i)).toByte()
        }
    }
    System.arraycopy(payload, 0, out, headerLen, len)
    return out
}
