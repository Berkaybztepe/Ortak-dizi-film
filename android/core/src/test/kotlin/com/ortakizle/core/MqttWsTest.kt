package com.ortakizle.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// MQTT'nin WebSocket üzerinden çalıştığını yerel aracıyla dener:
//   node tests/broker.mjs 18830 18831 & OI_WS_BROKER=ws://u:p@127.0.0.1:18831/mqtt ./gradlew :core:test
class MqttWsTest {
    @Test
    fun publishesAndReceivesOverWebSocket() {
        val url = System.getenv("OI_WS_BROKER")
        assumeTrue(url != null, "OI_WS_BROKER yok")
        val got = CountDownLatch(1)
        var text = ""
        val big = "x".repeat(70_000) // 64 KB'den büyük çerçeve
        lateinit var link: MqttLink
        link = MqttLink(url!!, "oi-test-ws", onConnected = { l ->
            l.subscribe("oi/test/ws")
            Thread { Thread.sleep(300); l.publish("oi/test/ws", ("merhaba" + big).toByteArray()) }.start()
        }, onMessage = { _, payload -> text = String(payload); got.countDown() })
        val t = Thread { try { link.run() } catch (_: Exception) {} }.apply { isDaemon = true; start() }
        val ok = got.await(10, TimeUnit.SECONDS)
        link.close()
        t.join(2000)
        assertEquals(true, ok)
        assertEquals("merhaba" + big, text)
    }
}
