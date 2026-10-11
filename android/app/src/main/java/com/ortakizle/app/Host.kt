package com.ortakizle.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import com.ortakizle.core.AssetSource
import com.ortakizle.core.RoomServer
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface

const val NSD_TYPE = "_ortakizle._tcp."
private const val TAG = "OrtakIzle"
private val PORTS = listOf(8787, 8788, 8789, 8790)

// Bu cihazda açık olan oda: sunucu + ağda duyurma. Uygulama süreci boyunca tek örnek.
object Host {
    @Volatile var server: RoomServer? = null
        private set
    @Volatile var displayName: String = ""
        private set
    private var nsdListener: NsdManager.RegistrationListener? = null

    val hosting: Boolean get() = server?.isRunning == true
    val port: Int get() = server?.boundPort ?: -1

    // Oda sunucusunu başlatır; zaten açıksa dokunmaz. Hata metnini döndürür (null = başarılı).
    @Synchronized
    fun start(context: Context, password: String, userName: String): String? {
        if (hosting) return null
        val app = context.applicationContext
        val assets = AssetSource { path ->
            try {
                app.assets.open("web/$path").use { it.readBytes() }
            } catch (_: Exception) {
                null
            }
        }
        val name = utf8Prefix(userName.trim().ifBlank { "Ortak İzle" } + " · " + android.os.Build.MODEL, 63)
        var lastError: Exception? = null
        for (p in PORTS) {
            val s = RoomServer(p, password.ifEmpty { null }, name, assets) { Log.i(TAG, it) }
            try {
                s.start()
                server = s
                displayName = name
                register(app, p, name)
                return null
            } catch (e: Exception) {
                lastError = e
                try { s.stop() } catch (_: Exception) {}
            }
        }
        return "Oda açılamadı: ${lastError?.message ?: "port kullanımda"}"
    }

    @Synchronized
    fun stop(context: Context) {
        unregister(context.applicationContext)
        server?.stop()
        server = null
    }

    private fun register(context: Context, port: Int, name: String) {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = NSD_TYPE
            setPort(port)
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) { Log.i(TAG, "NSD kaydı: ${info.serviceName}") }
            override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) { Log.w(TAG, "NSD kaydı başarısız: $code") }
            override fun onServiceUnregistered(info: NsdServiceInfo) {}
            override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) {}
        }
        try {
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
            nsdListener = listener
        } catch (e: Exception) {
            Log.w(TAG, "NSD kaydı yapılamadı", e)
        }
    }

    private fun unregister(context: Context) {
        val l = nsdListener ?: return
        nsdListener = null
        try {
            (context.getSystemService(Context.NSD_SERVICE) as? NsdManager)?.unregisterService(l)
        } catch (_: Exception) {}
    }

    // Kardeşe verilecek adresler: Wi-Fi, Tailscale, hotspot, kablolu
    fun addresses(port: Int): List<Pair<String, String>> {
        val out = mutableListOf<Pair<String, String>>()
        try {
            for (ni in NetworkInterface.getNetworkInterfaces().toList()) {
                if (!ni.isUp || ni.isLoopback) continue
                val n = ni.name.lowercase()
                for (addr in ni.inetAddresses.toList()) {
                    if (addr !is Inet4Address || addr.isLoopbackAddress || addr.isLinkLocalAddress) continue
                    val ip = addr.hostAddress ?: continue
                    val b = addr.address
                    val cgnat = (b[0].toInt() and 0xff) == 100 && (b[1].toInt() and 0xc0) == 64
                    val label = when {
                        n.startsWith("tun") && cgnat -> "Tailscale"
                        cgnat && !n.startsWith("rmnet") && !n.startsWith("ccmni") -> "Tailscale"
                        n.startsWith("wlan") || n.startsWith("wifi") -> "Wi-Fi"
                        n.startsWith("swlan") || n.startsWith("ap") || n.contains("softap") -> "Hotspot"
                        n.startsWith("eth") -> "Kablolu ağ"
                        n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("pdp") -> continue
                        n.startsWith("tun") -> "VPN"
                        else -> "Ağ"
                    }
                    out += label to "$ip:$port"
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Adresler okunamadı", e)
        }
        val order = listOf("Wi-Fi", "Tailscale", "Hotspot", "Kablolu ağ", "VPN", "Ağ")
        return out.distinctBy { it.second }.sortedBy { order.indexOf(it.first) }
    }

    // DNS-SD adı en fazla 63 bayt olabilir; harf ortasından bölmeden kısalt
    private fun utf8Prefix(text: String, maxBytes: Int): String {
        val sb = StringBuilder()
        var bytes = 0
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val n = String(Character.toChars(cp)).toByteArray(Charsets.UTF_8).size
            if (bytes + n > maxBytes) break
            sb.appendCodePoint(cp)
            bytes += n
            i += Character.charCount(cp)
        }
        return sb.toString()
    }

    fun info(): JSONObject {
        val o = JSONObject()
        o.put("hosting", hosting)
        o.put("ok", hosting)
        o.put("port", port)
        o.put("name", displayName)
        val arr = JSONArray()
        if (hosting) {
            for ((label, address) in addresses(port)) arr.put(JSONObject().put("label", label).put("address", address))
        }
        o.put("addresses", arr)
        return o
    }
}
