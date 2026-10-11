package com.ortakizle.core

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class WebSocketTest {
    private val mask = byteArrayOf(0x37, 0xfa.toByte(), 0x21, 0x3d)

    // İstemci gibi maskeli çerçeve üretir
    private fun clientFrame(opcode: Int, payload: ByteArray, fin: Boolean = true, masked: Boolean = true): ByteArray {
        val out = ByteArrayOutputStream()
        out.write((if (fin) 0x80 else 0) or opcode)
        val m = if (masked) 0x80 else 0
        when {
            payload.size < 126 -> out.write(m or payload.size)
            payload.size < 65536 -> {
                out.write(m or 126)
                out.write(payload.size shr 8); out.write(payload.size and 0xFF)
            }
            else -> {
                out.write(m or 127)
                val l = payload.size.toLong()
                for (i in 0 until 8) out.write((l ushr (56 - 8 * i)).toInt() and 0xFF)
            }
        }
        if (masked) {
            out.write(mask)
            out.write(ByteArray(payload.size) { (payload[it].toInt() xor mask[it and 3].toInt()).toByte() })
        } else out.write(payload)
        return out.toByteArray()
    }

    private fun reader(vararg frames: ByteArray) = WsReader(ByteArrayInputStream(frames.fold(ByteArray(0)) { a, b -> a + b }))

    @Test
    fun maskedText() {
        // RFC 6455 5.7 örneği: maskeli "Hello"
        val bytes = byteArrayOf(0x81.toByte(), 0x85.toByte(), 0x37, 0xfa.toByte(), 0x21, 0x3d, 0x7f, 0x9f.toByte(), 0x4d, 0x51, 0x58)
        val ev = WsReader(ByteArrayInputStream(bytes)).next()
        assertEquals("Hello", (ev as WsEvent.Text).text)
    }

    @Test
    fun unmaskedAndUtf8() {
        val ev = reader(clientFrame(Opcode.TEXT, "Kardeş 😂".toByteArray(), masked = false)).next()
        assertEquals("Kardeş 😂", (ev as WsEvent.Text).text)
    }

    @Test
    fun length126And127() {
        val mid = "a".repeat(300)
        val big = "b".repeat(70_000)
        val r = reader(clientFrame(Opcode.TEXT, mid.toByteArray()), clientFrame(Opcode.TEXT, big.toByteArray()))
        assertEquals(mid, (r.next() as WsEvent.Text).text)
        assertEquals(big, (r.next() as WsEvent.Text).text)
        assertTrue(r.next() is WsEvent.Eof)
    }

    @Test
    fun fragmentedWithPingInBetween() {
        val r = reader(
            clientFrame(Opcode.TEXT, "Hel".toByteArray(), fin = false),
            clientFrame(Opcode.PING, "p".toByteArray()),
            clientFrame(Opcode.CONT, "lo ".toByteArray(), fin = false),
            clientFrame(Opcode.CONT, "dünya".toByteArray()),
        )
        val ping = r.next() as WsEvent.Ping
        assertArrayEquals("p".toByteArray(), ping.payload)
        assertEquals("Hello dünya", (r.next() as WsEvent.Text).text)
    }

    @Test
    fun closeCode() {
        val ev = reader(clientFrame(Opcode.CLOSE, byteArrayOf(0x03, 0xE8.toByte()))).next()
        assertEquals(1000, (ev as WsEvent.Close).code)
    }

    @Test
    fun tooLarge() {
        // 64 bit uzunlukta 2 MB bildirilen çerçeve: veri gelmeden reddedilir
        val header = byteArrayOf(0x81.toByte(), (0x80 or 127).toByte(), 0, 0, 0, 0, 0, 0x20, 0, 0)
        val e = assertThrows<WsProtocolException> { WsReader(ByteArrayInputStream(header)).next() }
        assertEquals(1009, e.code)
        // Parçaların toplamı sınırı aşarsa da
        val part = ByteArray(600_000) { 'x'.code.toByte() }
        val r = reader(clientFrame(Opcode.TEXT, part, fin = false), clientFrame(Opcode.CONT, part))
        assertEquals(1009, assertThrows<WsProtocolException> { r.next() }.code)
    }

    @Test
    fun serverFrameRoundTrip() {
        for (n in listOf(5, 125, 126, 65535, 65536, 100_000)) {
            val payload = ByteArray(n) { (it % 251).toByte() }
            val f = FrameReader(ByteArrayInputStream(encodeFrame(Opcode.TEXT, payload))).readFrame()!!
            assertTrue(f.fin)
            assertEquals(Opcode.TEXT, f.opcode)
            assertArrayEquals(payload, f.payload)
        }
    }

    @Test
    fun acceptKey() {
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", wsAccept("dGhlIHNhbXBsZSBub25jZQ=="))
    }

    @Test
    fun pathAndUrlNormalization() {
        assertEquals("/server.js", normalizePath("/../server.js"))
        assertEquals("/fonts/a b.woff2", normalizePath("/x/../fonts/a%20b.woff2?v=1"))
        assertEquals(null, normalizePath("/%2e%2e%2fetc"))
        assertEquals("https://www.disneyplus.com/play/abc", normalizeHttpUrl("https://www.disneyplus.com/play/abc"))
        assertEquals("http://a.com/", normalizeHttpUrl("HTTP://A.com:80"))
        assertEquals("https://x.com/a%20b?q=%22", normalizeHttpUrl("https://x.com/a b?q=\""))
        assertEquals(null, normalizeHttpUrl("javascript:alert(1)"))
        assertEquals(null, normalizeHttpUrl("https://"))
    }
}
