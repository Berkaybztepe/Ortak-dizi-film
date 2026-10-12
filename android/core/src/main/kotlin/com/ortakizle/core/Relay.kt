package com.ortakizle.core

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

// Oda kodu: farklı evlerdeki cihazlar herkese açık MQTT aracıları üzerinden buluşur.
// Bu cihaz (odayı açan) aracıya bağlanır ve gelen her istemciyi RoomServer'a sanal
// bağlantı olarak ekler. Şifreleme ve konu adları web/room-client.js ile birebir aynıdır.

/** web/room-client.js içindeki BROKERS listesiyle aynı aracılar (TCP+TLS uçları) */
val DEFAULT_BROKERS = listOf(
    "ssl://broker.emqx.io:8883",
    "ssl://broker.hivemq.com:8883",
    "ssl://test.mosquitto.org:8886",
)

private const val CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

object RoomCode {
    fun normalize(code: String) = code.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }
    fun format(code: String) = normalize(code).let { if (it.length == 6) it.take(3) + "-" + it.drop(3) else it }
    fun generate(): String {
        val r = SecureRandom()
        return (1..6).map { CODE_ALPHABET[r.nextInt(256) % CODE_ALPHABET.length] }.joinToString("")
    }
}

/** Oda kodundan konu adı ve AES-GCM anahtarı */
class RelayCrypto(code: String) {
    val topic: String
    private val key: SecretKey
    private val random = SecureRandom()

    init {
        val norm = RoomCode.normalize(code)
        val digest = MessageDigest.getInstance("SHA-256").digest("ortak-izle/konu/$norm".toByteArray(Charsets.UTF_8))
        topic = "ortakizle/v1/" + digest.joinToString("") { "%02x".format(it.toInt() and 0xFF) }.take(32)
        val spec = PBEKeySpec(norm.toCharArray(), "ortak-izle/anahtar/v1".toByteArray(Charsets.UTF_8), 100_000, 256)
        val raw = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        key = SecretKeySpec(raw, "AES")
    }

    fun seal(text: String): ByteArray {
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        return iv + c.doFinal(text.toByteArray(Charsets.UTF_8))
    }

    fun open(data: ByteArray): String? {
        if (data.size < 29) return null
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, data, 0, 12))
            String(c.doFinal(data, 12, data.size - 12), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }
}

/** Asgari MQTT 3.1.1 istemcisi (TCP ya da TLS, yalnızca QoS 0). Bir bağlantı = bir nesne. */
class MqttLink(
    private val url: String,
    private val clientId: String,
    private val onConnected: (MqttLink) -> Unit,
    private val onMessage: (String, ByteArray) -> Unit,
) {
    @Volatile private var socket: Socket? = null
    private var out: OutputStream? = null
    private val writeLock = Any()
    @Volatile var connected = false
        private set
    val host: String = try { URI(url).host ?: url } catch (_: Exception) { url }

    /** Bağlanır ve bağlantı kopana kadar okur (çağıran iş parçacığını bloklar). */
    fun run() {
        val uri = URI(url)
        val tls = uri.scheme == "ssl" || uri.scheme == "tls" || uri.scheme == "mqtts"
        val port = if (uri.port > 0) uri.port else if (tls) 8883 else 1883
        val sock: Socket = if (tls) {
            val plain = Socket().apply { connect(InetSocketAddress(uri.host, port), 10_000) }
            val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
            val ssl = factory.createSocket(plain, uri.host, port, true) as SSLSocket
            ssl.sslParameters = ssl.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
            ssl.startHandshake()
            ssl
        } else {
            Socket().apply { connect(InetSocketAddress(uri.host, port), 10_000) }
        }
        sock.tcpNoDelay = true
        sock.soTimeout = 50_000 // 25 sn'de bir ping atarız: 50 sn ses yoksa bağlantı ölmüştür
        socket = sock
        out = sock.getOutputStream()
        try {
            val id = clientId.toByteArray(Charsets.UTF_8)
            val body = ByteArrayOutputStream()
            body.write(byteArrayOf(0, 4, 'M'.code.toByte(), 'Q'.code.toByte(), 'T'.code.toByte(), 'T'.code.toByte(), 4, 2, 0, 40))
            body.write(id.size shr 8); body.write(id.size and 0xFF); body.write(id)
            send(0x10, body.toByteArray())
            readLoop(BufferedInputStream(sock.getInputStream()))
        } finally {
            close()
        }
    }

    private fun readLoop(input: InputStream) {
        while (true) {
            val b0 = input.read()
            if (b0 < 0) return
            var len = 0
            var mul = 1
            var i = 0
            while (true) {
                val d = input.read()
                if (d < 0) return
                len += (d and 0x7F) * mul
                mul *= 128
                if (d and 0x80 == 0) break
                if (++i >= 4) throw IOException("bozuk uzunluk")
            }
            if (len > 2_000_000) throw IOException("çok büyük paket")
            val body = ByteArray(len)
            var read = 0
            while (read < len) {
                val n = input.read(body, read, len - read)
                if (n < 0) return
                read += n
            }
            when (b0 shr 4) {
                2 -> { // CONNACK
                    if (body.size < 2 || body[1].toInt() != 0) throw IOException("aracı bağlantıyı reddetti")
                    connected = true
                    onConnected(this)
                }
                3 -> { // PUBLISH (QoS 0)
                    if (body.size < 2) continue
                    val tl = ((body[0].toInt() and 0xFF) shl 8) or (body[1].toInt() and 0xFF)
                    if (2 + tl > body.size) continue
                    val topic = String(body, 2, tl, Charsets.UTF_8)
                    var off = 2 + tl
                    if ((b0 shr 1) and 3 > 0) off += 2 // QoS>0 ise paket kimliği (beklenmez)
                    onMessage(topic, body.copyOfRange(off, body.size))
                }
                else -> {} // SUBACK, PINGRESP
            }
        }
    }

    private fun send(type: Int, body: ByteArray) {
        val header = ByteArrayOutputStream()
        header.write(type)
        var n = body.size
        do {
            var d = n % 128
            n /= 128
            if (n > 0) d = d or 0x80
            header.write(d)
        } while (n > 0)
        synchronized(writeLock) {
            val o = out ?: throw IOException("bağlı değil")
            o.write(header.toByteArray())
            o.write(body)
            o.flush()
        }
    }

    fun subscribe(topic: String) {
        val t = topic.toByteArray(Charsets.UTF_8)
        val body = ByteArrayOutputStream()
        body.write(0); body.write(1)
        body.write(t.size shr 8); body.write(t.size and 0xFF); body.write(t)
        body.write(0)
        send(0x82, body.toByteArray())
    }

    fun publish(topic: String, payload: ByteArray) {
        val t = topic.toByteArray(Charsets.UTF_8)
        val body = ByteArrayOutputStream(2 + t.size + payload.size)
        body.write(t.size shr 8); body.write(t.size and 0xFF); body.write(t); body.write(payload)
        send(0x30, body.toByteArray())
    }

    fun ping() = try { send(0xC0, ByteArray(0)) } catch (_: IOException) { close() }

    fun close() {
        connected = false
        try { if (out != null) send(0xE0, ByteArray(0)) } catch (_: Exception) {}
        try { socket?.close() } catch (_: Exception) {}
        out = null
    }
}

/**
 * Oda koduyla gelen istemcileri [server]'a bağlar. [brokers] listesindeki her aracıya
 * aynı anda bağlanır; istemci hangisinden gelirse cevabı oradan gönderir.
 */
class Relay(
    code: String,
    private val server: RoomServer,
    private val brokers: List<String> = DEFAULT_BROKERS,
    private val log: (String) -> Unit = {},
) {
    val code: String = RoomCode.normalize(code)
    private val crypto = RelayCrypto(this.code)
    private val random = SecureRandom()

    private class Peer(val cid: String, val conn: RoomServer.VirtualConnection) {
        @Volatile var link: Link? = null
        @Volatile var lastSeen = System.currentTimeMillis()
    }

    // Her aracı için bir bağlantı ve tek yazıcı iş parçacığı (mesaj sırası korunur)
    private inner class Link(val url: String) {
        @Volatile var mqtt: MqttLink? = null
        val writer: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "oda-kodu-yaz").apply { isDaemon = true } }
        var thread: Thread? = null
    }

    private val peers = ConcurrentHashMap<String, Peer>()
    private val links = brokers.map { Link(it) }
    private var scheduler: ScheduledExecutorService? = null
    @Volatile private var running = false

    /** Şu an en az bir aracıya bağlı mı (arayüzde "internetten ulaşılabilir" göstergesi) */
    val online: Boolean get() = links.any { it.mqtt?.connected == true }

    @Synchronized
    fun start() {
        if (running) return
        running = true
        for (l in links) {
            l.thread = Thread({ loop(l) }, "oda-kodu-${l.url}").apply {
                isDaemon = true
                start()
            }
        }
        scheduler = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "oda-kodu-zaman").apply { isDaemon = true } }.also {
            it.scheduleWithFixedDelay({ sweep() }, 10, 10, TimeUnit.SECONDS)
            it.scheduleWithFixedDelay({ for (l in links) l.mqtt?.takeIf { m -> m.connected }?.let { m -> l.writer.execute { m.ping() } } }, 25, 25, TimeUnit.SECONDS)
        }
    }

    @Synchronized
    fun stop() {
        if (!running) return
        running = false
        // Bağlı istemcilere haber ver ki hemen yeniden bağlanmaya geçsinler
        for (p in peers.values) send(p, """{"_":"bye"}""")
        for (l in links) {
            l.writer.execute { l.mqtt?.close() }
            l.writer.shutdown()
            try { l.writer.awaitTermination(1, TimeUnit.SECONDS) } catch (_: InterruptedException) {}
            l.mqtt?.close()
            l.thread?.interrupt()
        }
        scheduler?.shutdownNow()
        for (p in peers.values) p.conn.close()
        peers.clear()
    }

    private fun loop(l: Link) {
        var attempt = 0
        while (running) {
            val id = "oi-h-" + ByteArray(6).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
            val m = MqttLink(l.url, id, onConnected = { link ->
                attempt = 0
                link.subscribe("${crypto.topic}/up/+")
                log("Oda kodu hazır: ${link.host}")
            }, onMessage = { topic, payload -> onUp(l, topic, payload) })
            l.mqtt = m
            try {
                m.run()
            } catch (e: Exception) {
                if (running) log("Aracı bağlantısı koptu (${m.host}): ${e.message}")
            }
            l.mqtt = null
            if (!running) break
            val delay = minOf(2000L shl minOf(attempt++, 5), 60_000L)
            try { Thread.sleep(delay) } catch (_: InterruptedException) { break }
        }
    }

    private fun onUp(l: Link, topic: String, payload: ByteArray) {
        val cid = topic.substringAfterLast('/')
        if (cid.length != 16 || !cid.all { it in '0'..'9' || it in 'a'..'f' }) return
        val text = crypto.open(payload) ?: return
        val ctl = if (text.startsWith("{\"_\"")) Regex("^\\{\"_\":\"([a-z]+)\"").find(text)?.groupValues?.get(1) else null
        when (ctl) {
            "hello" -> {
                val peer = peers.computeIfAbsent(cid) { c ->
                    lateinit var p: Peer
                    val conn = server.attachVirtual { msg -> send(p, msg) }
                    p = Peer(c, conn)
                    p
                }
                peer.link = l
                peer.lastSeen = System.currentTimeMillis()
                send(peer, """{"_":"hi","name":${jsonString(server.serverName)}}""")
            }
            "bye" -> peers.remove(cid)?.conn?.close()
            else -> {
                val peer = peers[cid]
                if (peer == null) {
                    // Bu cihaz yeniden başlamış: istemci baştan bağlansın
                    val tmp = Peer(cid, object : RoomServer.VirtualConnection {
                        override val id = ""
                        override fun receive(text: String) {}
                        override fun close() {}
                    })
                    tmp.link = l
                    send(tmp, """{"_":"reset"}""")
                    return
                }
                peer.link = l
                peer.lastSeen = System.currentTimeMillis()
                peer.conn.receive(text)
            }
        }
    }

    private fun send(peer: Peer, text: String) {
        val l = peer.link ?: return
        try {
            l.writer.execute {
                val m = l.mqtt ?: return@execute
                if (!m.connected) return@execute
                try {
                    m.publish("${crypto.topic}/down/${peer.cid}", crypto.seal(text))
                } catch (_: IOException) {
                    m.close()
                }
            }
        } catch (_: Exception) {
            // yazıcı kapandı (oda kapanıyor)
        }
    }

    // 30 sn'dir ses vermeyen istemci gitmiş sayılır (istemciler 6 sn'de bir ping atar)
    private fun sweep() {
        val now = System.currentTimeMillis()
        for ((cid, p) in peers) {
            if (now - p.lastSeen > 30_000) {
                peers.remove(cid)
                p.conn.close()
            }
        }
    }

    private fun jsonString(s: String): String =
        kotlinx.serialization.json.JsonPrimitive(s).toString()
}
