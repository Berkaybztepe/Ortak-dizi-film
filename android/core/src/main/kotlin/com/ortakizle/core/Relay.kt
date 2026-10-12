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

/**
 * web/room-client.js içindeki BROKERS listesiyle aynı aracılar. Son ikisi 443 (HTTPS) portundan
 * WebSocket ile bağlanır: VPN (ör. WARP) ya da sıkı ağlar başka portları kessin diye.
 */
val DEFAULT_BROKERS = listOf(
    "ssl://broker.emqx.io:8883",
    "ssl://broker.hivemq.com:8883",
    "ssl://test.mosquitto.org:8886",
    "wss://mqtt.eclipseprojects.io:443/mqtt",
    "wss://public:public@public.cloud.shiftr.io:443/",
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

/**
 * Asgari MQTT 3.1.1 istemcisi (TCP, TLS ya da WebSocket üzerinden; yalnızca QoS 0).
 * Adreste kullanıcı:şifre varsa (ör. wss://public:public@...) bağlanırken gönderilir. Bir bağlantı = bir nesne.
 */
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
        val ws = uri.scheme == "ws" || uri.scheme == "wss"
        val tls = uri.scheme == "ssl" || uri.scheme == "tls" || uri.scheme == "mqtts" || uri.scheme == "wss"
        val port = if (uri.port > 0) uri.port else if (ws) (if (tls) 443 else 80) else if (tls) 8883 else 1883
        val sock: Socket = if (tls) {
            // El sıkışma takılırsa iş parçacığı sonsuza kadar beklemesin
            val plain = Socket().apply {
                connect(InetSocketAddress(uri.host, port), 10_000)
                soTimeout = 15_000
            }
            val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
            val ssl = factory.createSocket(plain, uri.host, port, true) as SSLSocket
            ssl.sslParameters = ssl.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
            ssl.startHandshake()
            ssl
        } else {
            Socket().apply { connect(InetSocketAddress(uri.host, port), 10_000) }
        }
        sock.tcpNoDelay = true
        socket = sock
        try {
            var input: InputStream = BufferedInputStream(sock.getInputStream())
            var output: OutputStream = sock.getOutputStream()
            if (ws) {
                sock.soTimeout = 15_000
                wsHandshake(uri, port, input, output)
                val frames = WsStreams(input, output)
                input = frames.input
                output = frames.output
            }
            sock.soTimeout = 50_000 // 25 sn'de bir ping atarız: 50 sn ses yoksa bağlantı ölmüştür
            out = output
            val id = clientId.toByteArray(Charsets.UTF_8)
            val auth = uri.rawUserInfo?.split(':', limit = 2)?.map { java.net.URLDecoder.decode(it, "UTF-8").toByteArray(Charsets.UTF_8) }
            val flags = if (auth != null) (if (auth.size > 1) 0xC2 else 0x82) else 0x02
            val body = ByteArrayOutputStream()
            body.write(byteArrayOf(0, 4, 'M'.code.toByte(), 'Q'.code.toByte(), 'T'.code.toByte(), 'T'.code.toByte(), 4, flags.toByte(), 0, 40))
            body.write(id.size shr 8); body.write(id.size and 0xFF); body.write(id)
            auth?.forEach { f -> body.write(f.size shr 8); body.write(f.size and 0xFF); body.write(f) }
            send(0x10, body.toByteArray())
            readLoop(input)
        } finally {
            close()
        }
    }

    /** WebSocket el sıkışması (alt protokol "mqtt"); 101 dışı cevapta hata */
    private fun wsHandshake(uri: URI, port: Int, input: InputStream, output: OutputStream) {
        val key = java.util.Base64.getEncoder().encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) })
        val path = (uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/") + (uri.rawQuery?.let { "?$it" } ?: "")
        val hostHeader = if (port == 443 || port == 80) uri.host else "${uri.host}:$port"
        val req = "GET $path HTTP/1.1\r\nHost: $hostHeader\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: mqtt\r\n" +
            "User-Agent: OrtakIzle\r\n\r\n"
        output.write(req.toByteArray(Charsets.ISO_8859_1))
        output.flush()
        val head = StringBuilder()
        while (!head.endsWith("\r\n\r\n")) {
            val b = input.read()
            if (b < 0) throw IOException("WebSocket cevabı yarım")
            head.append(b.toChar())
            if (head.length > 8192) throw IOException("WebSocket cevabı çok uzun")
        }
        val status = head.lineSequence().first()
        if (!status.contains(" 101")) throw IOException("WebSocket reddedildi: $status")
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
        header.write(body)
        val packet = header.toByteArray()
        synchronized(writeLock) {
            val o = out ?: throw IOException("bağlı değil")
            o.write(packet)
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

    // Önce soketi kapat: yazma ölü ağda takılı kaldıysa kilidi beklemeyelim (aracı kopuşu zaten görür)
    fun close() {
        connected = false
        try { socket?.close() } catch (_: Exception) {}
        out = null
    }
}

/**
 * MQTT için WebSocket çerçeveleme: her write() tek bir maskeli ikili çerçeve olur;
 * gelen çerçevelerin içi düz bir akış olarak okunur (ping'e pong ile cevap verilir).
 */
private class WsStreams(private val raw: InputStream, private val rawOut: OutputStream) {
    private val lock = Any()
    private val random = SecureRandom()

    private fun frame(opcode: Int, data: ByteArray, off: Int, len: Int) {
        val f = ByteArrayOutputStream(len + 14)
        f.write(0x80 or opcode)
        when {
            len < 126 -> f.write(0x80 or len)
            len < 65536 -> { f.write(0x80 or 126); f.write(len shr 8); f.write(len and 0xFF) }
            else -> { f.write(0x80 or 127); for (i in 7 downTo 0) f.write(((len.toLong() shr (8 * i)) and 0xFF).toInt()) }
        }
        val mask = ByteArray(4).also { random.nextBytes(it) }
        f.write(mask)
        for (i in 0 until len) f.write((data[off + i].toInt() xor mask[i and 3].toInt()) and 0xFF)
        synchronized(lock) {
            rawOut.write(f.toByteArray())
            rawOut.flush()
        }
    }

    val output = object : OutputStream() {
        override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
        override fun write(b: ByteArray, off: Int, len: Int) = frame(0x2, b, off, len)
        override fun flush() {}
    }

    val input = object : InputStream() {
        private var cur = ByteArray(0)
        private var pos = 0

        private fun readN(n: Int): ByteArray? {
            val b = ByteArray(n)
            var r = 0
            while (r < n) {
                val k = raw.read(b, r, n - r)
                if (k < 0) return null
                r += k
            }
            return b
        }

        /** Sonraki veri çerçevesini yükler; bağlantı kapandıysa false */
        private fun next(): Boolean {
            while (true) {
                val h = readN(2) ?: return false
                val opcode = h[0].toInt() and 0x0F
                val masked = (h[1].toInt() and 0x80) != 0
                var len = (h[1].toInt() and 0x7F).toLong()
                if (len == 126L) len = readN(2)?.let { ((it[0].toLong() and 0xFF) shl 8) or (it[1].toLong() and 0xFF) } ?: return false
                else if (len == 127L) len = readN(8)?.fold(0L) { a, x -> (a shl 8) or (x.toLong() and 0xFF) } ?: return false
                if (len > 2_000_000) throw IOException("çok büyük çerçeve")
                val mask = if (masked) readN(4) ?: return false else null
                val data = readN(len.toInt()) ?: return false
                if (mask != null) for (i in data.indices) data[i] = (data[i].toInt() xor mask[i and 3].toInt()).toByte()
                when (opcode) {
                    0x0, 0x1, 0x2 -> if (data.isNotEmpty()) { cur = data; pos = 0; return true }
                    0x8 -> return false
                    0x9 -> frame(0xA, data, 0, data.size)
                    else -> {}
                }
            }
        }

        override fun read(): Int {
            if (pos >= cur.size && !next()) return -1
            return cur[pos++].toInt() and 0xFF
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (pos >= cur.size && !next()) return -1
            val n = minOf(len, cur.size - pos)
            System.arraycopy(cur, pos, b, off, n)
            pos += n
            return n
        }
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
        @Volatile var hasData = false
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
                // İstemci "merhaba"yı tüm aracılardan yollar, ilk cevap verenle devam eder: veri gelmeye
                // başladıktan sonra geç gelen "merhaba" cevap yolunu kapanmış bir aracıya çevirmesin
                if (!peer.hasData) peer.link = l
                peer.lastSeen = System.currentTimeMillis()
                sendVia(l, peer.cid, """{"_":"hi","name":${jsonString(server.serverName)}}""")
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
                peer.hasData = true
                peer.lastSeen = System.currentTimeMillis()
                peer.conn.receive(text)
            }
        }
    }

    private fun send(peer: Peer, text: String) {
        sendVia(peer.link ?: return, peer.cid, text)
    }

    private fun sendVia(l: Link, cid: String, text: String) {
        try {
            l.writer.execute {
                val m = l.mqtt ?: return@execute
                if (!m.connected) return@execute
                try {
                    m.publish("${crypto.topic}/down/$cid", crypto.seal(text))
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
