package com.ortakizle.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

// Ortak İzle — senkron + sohbet sunucusu (server/server.js'nin Kotlin karşılığı).
// Video taşımaz; oynat/durdur/sar, sohbet ve "kim ne açtı" bilgisini odaya iletir.

private const val MAX_HISTORY = 100
private const val MAX_TEXT = 1000
private val REACTIONS = listOf(
    "😂", "😮", "😱", "❤️", "👏", "🔥", "😢", "👀",
    // Kedi tepkileri (uygulamada videonun üstünde sesli küçük kart olarak oynar)
    "kedi:uzgun", "kedi:fiyonk", "kedi:gulen", "kedi:zipla", "kedi:sarilma", "kedi:dans", "kedi:selam", "kedi:sovalye", "kedi:asker", "kedi:samuray", "kedi:muah",
)
private val KINDS = listOf("app", "eklenti", "web")
private const val COUNTDOWN_MS = 3500L
// Planlı başlatma: istemci "şu sunucu anında başla" diyebilir (en fazla bu kadar ileri)
private const val MAX_START_LEAD_MS = 2000L
private const val PING_INTERVAL_MS = 30_000L
private const val EMPTY_ROOM_TTL_MS = 30 * 60 * 1000L
private const val HTTP_IDLE_TIMEOUT_MS = 30_000
private const val MAX_QUEUED_FRAMES = 4096

class RoomServer(
    val port: Int,
    val password: String?,
    val serverName: String,
    private val assets: AssetSource,
    private val log: (String) -> Unit = {},
) {
    // Oda durumu tek kilitle korunur; mesajlar bu kilit altında işlenir
    private val lock = Any()
    private val rooms = LinkedHashMap<String, Room>()
    private val name = serverName.take(40)
    private val pass = password?.takeIf { it.isNotEmpty() }
    private val random = SecureRandom()

    private val sockets: MutableSet<Socket> = ConcurrentHashMap.newKeySet()
    private val wsConns: MutableSet<WsConn> = ConcurrentHashMap.newKeySet()

    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var scheduler: ScheduledExecutorService? = null
    @Volatile private var running = false

    val isRunning: Boolean get() = running

    /** Gerçek dinlenen port (port 0 verildiyse sistemin seçtiği); çalışmıyorsa -1 */
    val boundPort: Int get() = serverSocket?.localPort ?: -1

    // -----------------------------------------------------------------------
    // Yaşam döngüsü
    // -----------------------------------------------------------------------

    @Synchronized
    fun start() {
        check(!running) { "Sunucu zaten çalışıyor" }
        val ss = ServerSocket()
        try {
            ss.reuseAddress = true
            ss.bind(InetSocketAddress("0.0.0.0", port), 50)
        } catch (e: IOException) {
            ss.close()
            throw e
        }
        serverSocket = ss
        val sch = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "ortak-izle-zamanlayici").apply { isDaemon = true } }
        scheduler = sch
        running = true
        sch.scheduleAtFixedRate({ sweep() }, PING_INTERVAL_MS, PING_INTERVAL_MS, TimeUnit.MILLISECONDS)
        Thread({ acceptLoop(ss) }, "ortak-izle-kabul").apply { isDaemon = true }.start()
    }

    @Synchronized
    fun stop() {
        if (!running) return
        running = false
        try {
            serverSocket?.close()
        } catch (_: IOException) {
        }
        scheduler?.shutdownNow()
        for (c in wsConns.toList()) c.forceClose()
        for (s in sockets.toList()) closeQuietly(s)
        sockets.clear()
        wsConns.clear()
        synchronized(lock) { rooms.clear() }
    }

    /** Oda adı -> üye adları (bildirim için) */
    fun summary(): List<Pair<String, List<String>>> = synchronized(lock) {
        rooms.values.map { r -> r.name to r.clients.map { it.name } }
    }

    private fun acceptLoop(ss: ServerSocket) {
        while (running) {
            val s = try {
                ss.accept()
            } catch (e: IOException) {
                if (running) log("Bağlantı kabul hatası: ${e.message}")
                break
            }
            sockets.add(s)
            Thread({ serveConnection(s) }, "ortak-izle-baglanti").apply { isDaemon = true }.start()
        }
    }

    private fun schedule(delayMs: Long, task: () -> Unit) {
        try {
            scheduler?.schedule({
                try {
                    task()
                } catch (e: Exception) {
                    log("Zamanlayıcı hatası: $e")
                }
            }, delayMs, TimeUnit.MILLISECONDS)
        } catch (_: RejectedExecutionException) {
            // Sunucu durduruluyor
        }
    }

    // Ölü bağlantıları temizle: önceki ping'e (veya herhangi bir çerçeveye) yanıt vermeyen düşer
    private fun sweep() {
        for (c in wsConns.toList()) {
            if (!c.alive) {
                c.close(1001)
                continue
            }
            c.alive = false
            c.ping()
        }
    }

    // -----------------------------------------------------------------------
    // HTTP + WebSocket yükseltme
    // -----------------------------------------------------------------------

    private fun serveConnection(sock: Socket) {
        var upgraded = false
        try {
            sock.tcpNoDelay = true
            sock.soTimeout = HTTP_IDLE_TIMEOUT_MS
            val input = BufferedInputStream(sock.getInputStream())
            val out = BufferedOutputStream(sock.getOutputStream())
            while (running) {
                val req = try {
                    readHttpRequest(input) ?: break
                } catch (e: HttpBadRequest) {
                    writeResponse(out, 400, "text/plain; charset=utf-8", "Bad Request".toByteArray(), false, head = false)
                    break
                }
                if (req.header("upgrade") != null) {
                    upgraded = true
                    upgrade(sock, req, input, out)
                    return
                }
                var keepAlive = keepAlive(req)
                if (req.header("transfer-encoding") != null) {
                    keepAlive = false // gövdeyi atlayamayız, işlemden sonra kapat
                } else {
                    val len = req.header("content-length")?.toLongOrNull() ?: 0L
                    if (len > 0) skipFully(input, len)
                }
                serveHttp(req, out, keepAlive)
                if (!keepAlive) break
            }
        } catch (_: SocketTimeoutException) {
        } catch (_: IOException) {
        } catch (e: Exception) {
            log("Bağlantı hatası: $e")
        } finally {
            if (!upgraded) {
                sockets.remove(sock)
                closeQuietly(sock)
            }
        }
    }

    private fun keepAlive(req: HttpRequest): Boolean {
        val conn = req.header("connection")?.lowercase() ?: ""
        return if (req.version == "HTTP/1.0") conn.contains("keep-alive") else !conn.contains("close")
    }

    private fun skipFully(input: InputStream, n: Long) {
        var left = n
        val buf = ByteArray(8192)
        while (left > 0) {
            val r = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (r < 0) throw IOException("eksik gövde")
            left -= r
        }
    }

    private fun serveHttp(req: HttpRequest, out: OutputStream, keepAlive: Boolean) {
        val head = req.method == "HEAD"
        val path = normalizePath(req.target)
        if (path == null) {
            writeResponse(out, 403, null, ByteArray(0), keepAlive, head)
            return
        }
        if (path == "/health") {
            writeResponse(out, 200, "application/json", healthJson().toByteArray(Charsets.UTF_8), keepAlive, head, cors = true)
            return
        }
        val p = if (path == "/") "index.html" else path.substring(1)
        val data = if (p.isEmpty()) null else try {
            assets.open(p)
        } catch (e: Exception) {
            null
        }
        if (data == null) {
            writeResponse(out, 404, "text/plain; charset=utf-8", "Bulunamadı".toByteArray(Charsets.UTF_8), keepAlive, head)
            return
        }
        writeResponse(out, 200, mimeType(p), data, keepAlive, head)
    }

    private fun healthJson(): String = synchronized(lock) {
        buildJsonObject {
            put("ok", true)
            put("app", "ortak-izle")
            put("version", 2)
            put("name", name)
            put("password", pass != null)
            put("rooms", buildJsonArray {
                for (r in rooms.values) add(buildJsonObject {
                    put("name", r.name)
                    put("members", buildJsonArray { for (c in r.clients) add(JsonPrimitive(c.name)) })
                })
            })
        }.toString()
    }

    private fun writeResponse(
        out: OutputStream,
        status: Int,
        contentType: String?,
        body: ByteArray,
        keepAlive: Boolean,
        head: Boolean,
        cors: Boolean = false,
    ) {
        val reason = when (status) {
            200 -> "OK"
            400 -> "Bad Request"
            403 -> "Forbidden"
            404 -> "Not Found"
            else -> "Error"
        }
        val sb = StringBuilder("HTTP/1.1 $status $reason\r\n")
        if (contentType != null) sb.append("Content-Type: ").append(contentType).append("\r\n")
        if (cors) sb.append("Access-Control-Allow-Origin: *\r\n")
        sb.append("Cache-Control: no-cache\r\n")
        sb.append("Content-Length: ").append(body.size).append("\r\n")
        sb.append("Connection: ").append(if (keepAlive) "keep-alive" else "close").append("\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        if (!head) out.write(body)
        out.flush()
    }

    private fun upgrade(sock: Socket, req: HttpRequest, input: InputStream, out: OutputStream) {
        val key = req.header("sec-websocket-key")
        if (key.isNullOrEmpty() || req.header("upgrade")?.lowercase() != "websocket") {
            try {
                out.write("HTTP/1.1 400 Bad Request\r\n\r\n".toByteArray())
                out.flush()
            } catch (_: IOException) {
            }
            sockets.remove(sock)
            closeQuietly(sock)
            return
        }
        try {
            out.write(
                ("HTTP/1.1 101 Switching Protocols\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n").toByteArray(Charsets.ISO_8859_1)
            )
            out.flush()
            sock.soTimeout = 0
        } catch (e: IOException) {
            sockets.remove(sock)
            closeQuietly(sock)
            return
        }
        val client = Client(newId())
        // Bu cihazın içinden bağlanan (odayı açan) kişi yönetici olabilir
        client.local = sock.inetAddress?.isLoopbackAddress == true
        val conn = WsConn(sock, out) {
            synchronized(lock) {
                client.gone = true
                leave(client)
            }
        }
        client.peer = conn
        wsConns.add(conn)
        conn.startWriter()
        // Kapanan bağlantının geç gelen mesajı (ör. join) onu odaya geri sokmasın: kontrol kilit altında
        conn.readLoop(input) { text -> synchronized(lock) { if (!client.gone) handle(client, text) } }
    }

    private fun newId(): String {
        val b = ByteArray(4)
        random.nextBytes(b)
        return b.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
    }

    private fun closeQuietly(s: Socket) {
        try {
            s.close()
        } catch (_: IOException) {
        }
    }

    // Tek bir WebSocket bağlantısı. Yazmalar kuyruk + yazıcı iş parçacığıyla sıralanır,
    // böylece çerçeveler karışmaz ve oda kilidi yavaş istemciyi beklemez.
    // Bir istemciye mesaj gönderme yolu: gerçek WebSocket ya da aracı (relay) üzerinden sanal bağlantı
    private interface Peer {
        fun sendText(text: String)
        fun send(msg: JsonElement) = sendText(msg.toString())
    }

    /** Aracı sunucu (MQTT) üzerinden gelen bir istemci için sanal bağlantı */
    interface VirtualConnection {
        val id: String
        fun receive(text: String)
        fun close()
    }

    /**
     * Ağdan değil de başka bir yoldan (ör. oda kodu ile internet üzerinden aracı sunucu)
     * gelen bir istemciyi odaya bağlar. [send] bu istemciye gidecek her mesaj için çağrılır.
     */
    fun attachVirtual(send: (String) -> Unit): VirtualConnection {
        val client = Client(newId())
        client.peer = object : Peer {
            override fun sendText(text: String) = send(text)
        }
        var closed = false
        return object : VirtualConnection {
            override val id = client.id
            override fun receive(text: String) {
                if (text.length > 1_000_000) return
                synchronized(lock) { if (!closed && !client.gone) handle(client, text) }
            }
            override fun close() {
                synchronized(lock) {
                    if (closed) return
                    closed = true
                    leave(client)
                }
            }
        }
    }

    private inner class WsConn(
        private val sock: Socket,
        private val out: OutputStream,
        private val onClose: () -> Unit,
    ) : Peer {
        private val open = AtomicBoolean(true)
        private val queue = LinkedBlockingQueue<ByteArray>()
        private val poison = ByteArray(0)
        @Volatile var alive = true

        fun startWriter() {
            Thread({ writeLoop() }, "ortak-izle-yazici").apply { isDaemon = true }.start()
        }

        private fun writeLoop() {
            try {
                while (true) {
                    val f = queue.take()
                    if (f === poison) break
                    out.write(f)
                    if (queue.isEmpty()) out.flush()
                }
                out.flush()
                sock.shutdownOutput()
            } catch (_: Exception) {
                markClosed()
                forceClose()
            }
        }

        fun readLoop(input: InputStream, onText: (String) -> Unit) {
            try {
                val reader = WsReader(input)
                while (true) {
                    val ev = reader.next()
                    alive = true
                    when (ev) {
                        is WsEvent.Text -> if (open.get()) onText(ev.text)
                        is WsEvent.Ping -> sendFrame(Opcode.PONG, ev.payload)
                        is WsEvent.Pong -> {}
                        is WsEvent.Close -> {
                            close(1000)
                            // Karşı tarafın bağlantıyı kapatmasını kısa süre bekle
                            sock.soTimeout = 3000
                            while (input.read() >= 0) { /* at */ }
                            break
                        }
                        is WsEvent.Eof -> break
                    }
                }
            } catch (e: WsProtocolException) {
                close(e.code)
            } catch (_: IOException) {
            } catch (e: Exception) {
                log("WebSocket hatası: $e")
            } finally {
                markClosed()
                forceClose()
            }
        }

        fun sendFrame(opcode: Int, payload: ByteArray) = sendEncoded(encodeFrame(opcode, payload))

        override fun sendText(text: String) = sendFrame(Opcode.TEXT, text.toByteArray(Charsets.UTF_8))
        override fun send(msg: JsonElement) = sendText(msg.toString())

        fun sendEncoded(frame: ByteArray) {
            if (!open.get()) return
            if (queue.size > MAX_QUEUED_FRAMES) {
                // Okumayan istemci belleği doldurmasın. Kapatma sonraya bırakılır:
                // burası oda kilidi altında, yayın döngüsünün içinde olabilir.
                schedule(0) { close(1008) }
                return
            }
            queue.offer(frame)
        }

        fun ping() = sendFrame(Opcode.PING, ByteArray(0))

        fun close(code: Int) {
            if (!open.compareAndSet(true, false)) return
            queue.offer(encodeFrame(Opcode.CLOSE, byteArrayOf((code shr 8).toByte(), code.toByte())))
            queue.offer(poison)
            // Karşı taraf yanıt vermezse soketi zorla kapat
            schedule(3000) { forceClose() }
            onClose()
        }

        // Karşı taraf bağlantıyı kopardı
        private fun markClosed() {
            if (!open.compareAndSet(true, false)) return
            queue.offer(poison)
            onClose()
        }

        fun forceClose() {
            wsConns.remove(this)
            sockets.remove(sock)
            queue.offer(poison)
            closeQuietly(sock)
        }
    }

    // -----------------------------------------------------------------------
    // Odalar
    // -----------------------------------------------------------------------

    // Son bilinen oynatma durumu: `at` sunucu saati (ms) — oynarken
    // güncel konum = time + (şimdi - at) / 1000
    private class PlayState(
        val paused: Boolean,
        val time: Double,
        val at: Long,
        val url: String?,
        var by: String?,
        // true: gönderenin zamanı içeriğin gerçek dakikası değil (ör. Disney+), konuma atlanmaz
        val rel: Boolean = false,
    ) {
        fun putInto(b: JsonObjectBuilder) {
            b.put("paused", paused)
            b.put("time", numJson(time))
            b.put("at", at)
            b.put("url", url)
            b.put("by", by)
            if (rel) b.put("rel", true)
        }

        fun toJson(): JsonObject = buildJsonObject { putInto(this) }
    }

    private class Room(val name: String) {
        val clients = LinkedHashSet<Client>()
        val history = ArrayList<JsonObject>()
        var seq = 0L // sohbet sıra numarası
        var state = PlayState(true, 0.0, System.currentTimeMillis(), null, null)
        // Kilit açıkken bölümü yalnızca yönetici (odayı açan) seçer; diğerleri onu takip eder
        var lock = true
        // Son kumanda hareketinin anı (sunucu saati): kaybolmuş hareketi tick'ten tanımak için
        var lastAction = 0L
        var emptySince = 0L
    }

    private inner class Client(val id: String) {
        lateinit var peer: Peer
        var room: Room? = null
        var name = ""
        var url: String? = null
        // JS'te başta tanımsız: JSON'a hiç yazılmazlar
        var title: String? = null
        var platform: String? = null
        var kind: String? = null
        var buffering = false
        var watching = false
        var admin = false
        var local = false
        var gone = false // bağlantı kapandı ya da yerine yenisi geldi
    }

    private fun memberInfo(c: Client): JsonObject = buildJsonObject {
        put("id", c.id)
        put("name", c.name)
        put("url", c.url)
        c.title?.let { put("title", it) }
        c.platform?.let { put("platform", it) }
        c.kind?.let { put("kind", it) }
        put("buffering", c.buffering)
        put("admin", c.admin)
        put("watching", c.watching)
    }

    // İstemcinin bildirdiği ölçüm anı (sunucu saatiyle). Mesaj yolda gecikse de konum o ana göre
    // hesaplanır; böylece ağ gecikmesi senkrona eklenmez. Mantıksızsa şimdiki zaman kullanılır.
    private fun clientAt(v: JsonElement?, now: Long, maxFuture: Long = 500): Long {
        val x = jsNumber(v) ?: return now
        if (!x.isFinite() || x > now + maxFuture || x < now - 5000) return now
        return Math.round(x)
    }

    // Adresin sunucu adı (www./m. olmadan). URI ayrıştırıcısı bazı geçerli adreslerde hata verdiği için elle
    private fun hostOf(u: String?): String {
        val m = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/?#]*@)?([^:/?#]+)").find(u ?: "") ?: return ""
        return m.groupValues[1].lowercase().removePrefix("www.").removePrefix("m.")
    }

    // İzleyen biri bölümden ya da odadan çıktı: oynuyorsa video herkeste dursun
    private fun pauseForAbsence(room: Room, client: Client, reason: String, url: String?): Boolean {
        val st = room.state
        if (st.paused || st.url == null) return false
        if (hostOf(url) != hostOf(st.url)) return false
        val now = System.currentTimeMillis()
        val time = st.time + maxOf(0L, now - st.at) / 1000.0
        room.state = PlayState(true, time, now, st.url, null, st.rel)
        room.lastAction = now
        broadcast(room, buildJsonObject {
            put("t", "sync")
            put("action", "pause")
            room.state.putInto(this)
            put("from", client.id)
            put("name", client.name)
            put("reason", reason)
        }, client)
        addSystemMessage(room, "${client.name} ${if (reason == "left") "odadan ayrıldı" else "bölümden çıktı"}, video durduruldu.")
        return true
    }

    private fun getRoom(roomName: String): Room = rooms.getOrPut(roomName) { Room(roomName) }

    private fun broadcast(room: Room, msg: JsonObject, except: Client? = null) {
        val text = msg.toString()
        var frame: ByteArray? = null
        for (c in room.clients) {
            if (c === except) continue
            val p = c.peer
            if (p is WsConn) p.sendEncoded(frame ?: encodeFrame(Opcode.TEXT, text.toByteArray(Charsets.UTF_8)).also { frame = it })
            else p.sendText(text)
        }
    }

    // Sohbet mesajına sıra numarası ekleyip geçmişe yazar; numaralı halini döndürür
    private fun pushHistory(room: Room, msg: JsonObject): JsonObject {
        room.seq++
        val numbered = JsonObject(msg + ("seq" to JsonPrimitive(room.seq)))
        room.history.add(numbered)
        if (room.history.size > MAX_HISTORY) room.history.removeAt(0)
        return numbered
    }

    private fun addSystemMessage(room: Room, text: String) {
        val msg = buildJsonObject {
            put("t", "chat")
            put("system", true)
            put("text", text)
            put("at", System.currentTimeMillis())
        }
        broadcast(room, pushHistory(room, msg))
    }

    private fun error(client: Client, code: String, message: String) {
        client.peer.send(buildJsonObject {
            put("t", "error")
            put("code", code)
            put("message", message)
        })
    }

    // Kilit altında çağrılır
    private fun handle(client: Client, raw: String) {
        val parsed = try {
            Json.parseToJsonElement(raw)
        } catch (e: Exception) {
            return
        }
        // JS'te dizi de "object"tir: alanları olmayan nesne gibi davranır
        val m: JsonObject = when (parsed) {
            is JsonObject -> parsed
            is JsonArray -> JsonObject(emptyMap())
            else -> return
        }
        val t = jsString(m["t"])

        // Saat eşitleme her zaman serbest
        if (t == "ping") {
            client.peer.send(buildJsonObject {
                put("t", "pong")
                m["c"]?.let { put("c", it) }
                put("s", System.currentTimeMillis())
                client.room?.let { put("cs", it.seq) } // son sohbet sıra numarası
            })
            return
        }

        if (t == "join") {
            if (pass != null && jsString(m["password"]) != pass) {
                error(client, "password", "Şifre yanlış.")
                return
            }
            val roomName = jsTrim(cleanStr(m["room"], 40)).lowercase().ifEmpty { "salon" }
            if (client.room != null) leave(client)
            client.name = jsTrim(cleanStr(m["name"], 30)).ifEmpty { "Misafir" }
            client.kind = jsString(m["kind"])?.takeIf { it in KINDS } ?: "eklenti"
            client.buffering = false
            client.watching = false
            val room = getRoom(roomName)
            client.room = room
            // Bağlantısı kopup yeniden bağlanan kişinin eski (ölü) bağlantısını sessizce kaldır: daha
            // sonra zaman aşımıyla "odadan çıktı" sayılıp videoyu durdurmasın
            val prev = cleanStr(m["prev"], 20)
            if (prev.isNotEmpty()) {
                for (old in room.clients.toList()) {
                    if (old.id != prev || old === client || old.name != client.name) continue
                    room.clients.remove(old)
                    old.room = null
                    old.gone = true
                    if (old.admin) client.local = client.local || old.local
                    broadcast(room, buildJsonObject {
                        put("t", "member-leave")
                        put("member", memberInfo(old))
                        put("replaced", true)
                    })
                    val p = old.peer
                    // Ağdan gelen eski bağlantıyı kapat (aracı üzerinden geleni Relay zaman aşımıyla temizler)
                    if (p is WsConn) schedule(0) { p.close(1000) }
                }
            }
            // Yönetici: odayı açan cihaz (sunucuya bu cihazın içinden bağlanan ilk kişi)
            client.admin = client.local && room.clients.none { it.admin }
            room.clients.add(client)
            client.peer.send(buildJsonObject {
                put("t", "welcome")
                put("you", memberInfo(client))
                put("room", roomName)
                put("server", name)
                put("members", JsonArray(room.clients.map { memberInfo(it) }))
                put("state", room.state.toJson())
                put("lastAction", room.lastAction)
                put("lock", room.lock)
                put("history", JsonArray(room.history.toList()))
                put("now", System.currentTimeMillis())
            })
            broadcast(room, buildJsonObject {
                put("t", "member-join")
                put("member", memberInfo(client))
            }, client)
            addSystemMessage(room, "${client.name} odaya katıldı.")
            log("[$roomName] + ${client.name} (${client.kind})")
            return
        }

        val room = client.room
        if (room == null) {
            error(client, "nojoin", "Önce odaya katılın.")
            return
        }

        when (t) {
            "chat" -> {
                val text = jsTrim(cleanStr(m["text"], MAX_TEXT))
                if (text.isEmpty()) return
                val cid = cleanStr(m["cid"], 20)
                if (cid.isNotEmpty()) {
                    // Aynı mesaj (bağlantı sorunu yüzünden) tekrar geldiyse çoğaltma; herkese yeniden ilet
                    // (ilk iletim birine ulaşmamış olabilir, istemciler kimliğe bakıp tekrarı göstermez)
                    val dup = room.history.firstOrNull { (it["cid"] as? JsonPrimitive)?.contentOrNull == cid }
                    if (dup != null) {
                        broadcast(room, dup)
                        return
                    }
                }
                val msg = buildJsonObject {
                    put("t", "chat")
                    put("from", client.id)
                    put("name", client.name)
                    put("text", text)
                    put("at", System.currentTimeMillis())
                    if (cid.isNotEmpty()) put("cid", cid)
                }
                val numbered = pushHistory(room, msg)
                broadcast(room, numbered)
                // Bir kez daha gönder: ilk iletim yolda kaybolduysa (istemciler tekrarı göstermez)
                schedule(1500) { synchronized(lock) { if (room.clients.isNotEmpty()) broadcast(room, numbered) } }
            }

            // İstemci arada kaçırdığı sohbet mesajlarını istiyor
            "resend" -> {
                val after = cleanNum(m["after"])
                for (h in room.history) {
                    val seq = (h["seq"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull() ?: continue
                    if (seq > after) client.peer.send(h)
                }
            }

            // Kullanıcı eliyle oynat / durdur / sar yaptı
            "sync" -> {
                val action = jsString(m["action"])?.takeIf { it == "play" || it == "pause" || it == "seek" } ?: return
                room.state = PlayState(
                    paused = when (action) {
                        "pause" -> true
                        "play" -> false
                        else -> truthy(m["paused"])
                    },
                    time = cleanNum(m["time"]),
                    // Oynatma planlı başlatılabilir (herkes aynı anda başlasın diye birkaç yüz ms sonrası)
                    at = clientAt(m["at"], System.currentTimeMillis(), if (action == "play") MAX_START_LEAD_MS else 500L),
                    url = client.url,
                    by = client.id,
                    rel = truthy(m["rel"]),
                )
                room.lastAction = minOf(System.currentTimeMillis(), room.state.at)
                val delta = jsNumber(m["delta"])?.takeIf { it.isFinite() && kotlin.math.abs(it) <= 86400 }
                broadcast(room, buildJsonObject {
                    put("t", "sync")
                    put("action", action)
                    room.state.putInto(this)
                    if (action == "seek" && delta != null) put("delta", numJson(delta))
                    put("from", client.id)
                    put("name", client.name)
                }, client)
                // Gönderene de sonucu bildir: aynı anda basılınca sunucunun sırası geçerli olsun
                client.peer.send(buildJsonObject {
                    put("t", "state")
                    put("state", room.state.toJson())
                })
            }

            // Oynatırken düzenli konum bildirimi (kayma düzeltmesi için)
            "tick" -> {
                // Bölüm sayfasında olmayan (çıkmış) birinin bildirimi odayı yönetmez
                if (!client.watching) return
                // Sadece son kumanda eden kişinin tick'i durumu belirler. İstisna: gönderenin son
                // hareketi (since) odadaki son hareketten yeniyse o hareketin mesajı yolda kaybolmuştur
                val by = room.state.by
                if (!by.isNullOrEmpty() && by != client.id) {
                    val since = jsNumber(m["since"])?.takeIf { it.isFinite() } ?: 0.0
                    if (!(since > room.lastAction && since <= System.currentTimeMillis() + 2000)) return
                    room.lastAction = since.toLong()
                }
                room.state = PlayState(truthy(m["paused"]), cleanNum(m["time"]), clientAt(m["at"], System.currentTimeMillis()), client.url, client.id, truthy(m["rel"]))
                broadcast(room, buildJsonObject {
                    put("t", "tick")
                    room.state.putInto(this)
                    put("from", client.id)
                    put("cs", room.seq)
                    put("since", room.lastAction) // bu kumandanın son hareket anı
                }, client)
            }

            // Kullanıcı bir dizi/film sayfası açtı
            "nav" -> {
                val url = cleanUrl(m["url"])
                val wasWatching = client.watching
                val oldUrl = client.url
                // Bölüm değişince eski "yükleniyor" durumu takılı kalmasın
                if (client.buffering) {
                    client.buffering = false
                    broadcast(room, buildJsonObject {
                        put("t", "buffer")
                        put("on", false)
                        put("member", memberInfo(client))
                    }, client)
                }
                client.watching = truthy(m["watching"]) && url != null
                client.url = url
                client.title = cleanStr(m["title"], 200)
                client.platform = cleanStr(m["platform"], 30)
                broadcast(room, buildJsonObject {
                    put("t", "nav")
                    put("member", memberInfo(client))
                    put("watching", client.watching)
                }, client)
                if (wasWatching && !client.watching) pauseForAbsence(room, client, "exit", oldUrl)
            }

            // Yönetici kilidi: açıkken bölümü yalnızca yönetici seçer
            "lock" -> {
                if (!client.admin) return
                room.lock = truthy(m["on"])
                broadcast(room, buildJsonObject {
                    put("t", "lock")
                    put("on", room.lock)
                })
                addSystemMessage(room, if (room.lock) "Bölümü yalnızca ${client.name} seçebilir." else "Artık herkes bölüm seçebilir.")
            }

            // Diğerlerinin tarayıcısına "buraya gel" isteği
            "invite" -> {
                val url = cleanUrl(m["url"]) ?: client.url ?: return
                val title = cleanStr(m["title"], 200)
                broadcast(room, buildJsonObject {
                    put("t", "invite")
                    put("url", url)
                    put("title", title)
                    put("from", client.id)
                    put("name", client.name)
                }, client)
                addSystemMessage(room, "${client.name} herkesi davet etti: ${title.ifEmpty { url }}")
            }

            // Hızlı tepki (videonun üstünde uçuşan emoji)
            "react" -> {
                val emoji = jsString(m["emoji"])?.takeIf { it in REACTIONS } ?: return
                broadcast(room, buildJsonObject {
                    put("t", "react")
                    put("emoji", emoji)
                    put("from", client.id)
                    put("name", client.name)
                }, client)
            }

            // İzleyenin oda durumuna göre farkı (sn): paneldeki "Senkron" yazısı gerçeğe dayansın
            "drift" -> {
                val err = jsNumber(m["err"])?.takeIf { it.isFinite() && kotlin.math.abs(it) < 86400 }
                broadcast(room, buildJsonObject {
                    put("t", "drift")
                    if (err != null) put("err", numJson(Math.round(err * 100) / 100.0)) else put("err", JsonNull)
                    put("from", client.id)
                    put("cs", room.seq) // son sohbet sıra numarası (kaçan mesaj fark edilsin)
                }, client)
            }

            // "yazıyor…" göstergesi
            "typing" -> broadcast(room, buildJsonObject {
                put("t", "typing")
                put("on", truthy(m["on"]))
                put("from", client.id)
                put("name", client.name)
            }, client)

            // Biri yükleniyor (buffer): diğerleri onu bekler
            "buffer" -> {
                val on = truthy(m["on"])
                // again: istemcinin tekrarı (ilk mesaj kaybolmuş olabilir), aynı durum da iletilir
                if (client.buffering == on && !truthy(m["again"])) return
                client.buffering = on
                broadcast(room, buildJsonObject {
                    put("t", "buffer")
                    put("on", on)
                    put("member", memberInfo(client))
                }, client)
            }

            // 3-2-1 geri sayımla birlikte başlat; herkes (gönderen dahil) aynı anda oynatır
            "countdown" -> {
                val at = System.currentTimeMillis() + COUNTDOWN_MS
                room.lastAction = System.currentTimeMillis()
                val time = cleanNum(m["time"])
                val rel = truthy(m["rel"])
                room.state = PlayState(false, time, at, client.url, client.id, rel)
                broadcast(room, buildJsonObject {
                    put("t", "countdown")
                    put("at", at)
                    put("time", numJson(time))
                    if (rel) put("rel", true)
                    put("url", client.url)
                    put("from", client.id)
                    put("name", client.name)
                })
                addSystemMessage(room, "${client.name} geri sayım başlattı.")
            }

            else -> {}
        }
    }

    // Kilit altında çağrılır
    private fun leave(client: Client) {
        val room = client.room ?: return
        room.clients.remove(client)
        client.room = null
        if (room.state.by == client.id) room.state.by = null
        broadcast(room, buildJsonObject {
            put("t", "member-leave")
            put("member", memberInfo(client))
        })
        if (!(client.watching && pauseForAbsence(room, client, "left", client.url))) addSystemMessage(room, "${client.name} odadan ayrıldı.")
        // Yönetici çıktıysa bu cihazdaki sıradaki kişi yönetici olur
        if (client.admin) {
            room.clients.firstOrNull { it.local }?.let { next ->
                next.admin = true
                broadcast(room, buildJsonObject {
                    put("t", "nav")
                    put("member", memberInfo(next))
                    put("watching", next.watching)
                })
            }
        }
        log("[${room.name}] - ${client.name}")
        if (room.clients.isEmpty()) {
            // Boş odayı bir süre sonra temizle (yenileme sırasında geçmiş kaybolmasın)
            room.emptySince = System.currentTimeMillis()
            schedule(EMPTY_ROOM_TTL_MS) {
                synchronized(lock) {
                    // Bu arada biri girip çıktıysa sayaç yeniden başlamıştır
                    if (room.clients.isEmpty() && rooms[room.name] === room &&
                        System.currentTimeMillis() - room.emptySince >= EMPTY_ROOM_TTL_MS - 1000
                    ) rooms.remove(room.name)
                }
            }
        }
    }
}
