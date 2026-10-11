package com.ortakizle.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.util.concurrent.Executors

// Aynı Wi-Fi'daki açık odaları bulur (mDNS / NSD).
class Discovery(context: Context, private val onChange: (JSONArray) -> Unit) {
    private val app = context.applicationContext
    private val nsd = app.getSystemService(Context.NSD_SERVICE) as? NsdManager
    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private var listener: NsdManager.DiscoveryListener? = null
    private var multicast: WifiManager.MulticastLock? = null
    private val found = LinkedHashMap<String, JSONObject>() // servis adı -> {name, host, port}
    private val queue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var gen = 0 // her start/stop'ta artar; eski oturumun geç gelen cevapları yok sayılır
    private var pendingCb: NsdManager.ServiceInfoCallback? = null

    fun start() {
        if (listener != null || nsd == null) return
        try {
            val wm = app.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            multicast = wm?.createMulticastLock("OrtakIzle:kesif")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {}
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w("OrtakIzle", "Keşif başlatılamadı: $errorCode")
                main.post { listener = null }
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                main.post { enqueue(info) }
            }
            override fun onServiceLost(info: NsdServiceInfo) {
                main.post {
                    if (found.remove(info.serviceName) != null) publish()
                }
            }
        }
        try {
            nsd.discoverServices(NSD_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
            listener = l
        } catch (e: Exception) {
            Log.w("OrtakIzle", "Keşif hatası", e)
        }
    }

    fun stop() {
        gen++
        val l = listener ?: return
        listener = null
        try { nsd?.stopServiceDiscovery(l) } catch (_: Exception) {}
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            pendingCb?.let { try { nsd?.unregisterServiceInfoCallback(it) } catch (_: Exception) {} }
        }
        pendingCb = null
        try { multicast?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        multicast = null
        queue.clear()
        resolving = false
        found.clear()
    }

    fun shutdown() {
        stop()
        executor.shutdownNow()
    }

    fun current(): JSONArray = JSONArray(found.values.toList())

    private fun enqueue(info: NsdServiceInfo) {
        if (queue.any { it.serviceName == info.serviceName }) return
        queue.addLast(info)
        next()
    }

    // Eski Android sürümlerinde aynı anda tek çözümleme yapılabiliyor; sırayla çöz
    @Suppress("DEPRECATION")
    private fun next() {
        if (resolving || listener == null) return
        val info = queue.removeFirstOrNull() ?: return
        resolving = true
        val myGen = gen
        var finished = false
        lateinit var timeout: Runnable
        val done: (NsdServiceInfo?) -> Unit = { resolved ->
            main.post {
                if (myGen != gen || finished) return@post
                finished = true
                main.removeCallbacks(timeout)
                pendingCb = null
                resolving = false
                if (resolved != null) {
                    val host = hostOf(resolved)
                    if (host != null) {
                        found[resolved.serviceName] = JSONObject()
                            .put("name", resolved.serviceName)
                            .put("host", host)
                            .put("port", resolved.port)
                            .put("self", Host.hosting && resolved.port == Host.port && Host.addresses(Host.port).any { it.second.startsWith("$host:") })
                        publish()
                    }
                }
                next()
            }
            Unit
        }
        // Cevap gelmeyen çözümleme sırayı kilitlemesin
        timeout = Runnable {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                pendingCb?.let { try { nsd?.unregisterServiceInfoCallback(it) } catch (_: Exception) {} }
            }
            done(null)
        }
        main.postDelayed(timeout, 8000)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                var cb: NsdManager.ServiceInfoCallback? = null
                cb = object : NsdManager.ServiceInfoCallback {
                    override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = done(null)
                    override fun onServiceUpdated(si: NsdServiceInfo) {
                        try { cb?.let { nsd?.unregisterServiceInfoCallback(it) } } catch (_: Exception) {}
                        done(si)
                    }
                    override fun onServiceLost() {
                        try { cb?.let { nsd?.unregisterServiceInfoCallback(it) } } catch (_: Exception) {}
                        done(null)
                    }
                    override fun onServiceInfoCallbackUnregistered() {}
                }
                pendingCb = cb
                nsd?.registerServiceInfoCallback(info, executor, cb)
            } else {
                nsd?.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(si: NsdServiceInfo, errorCode: Int) = done(null)
                    override fun onServiceResolved(si: NsdServiceInfo) = done(si)
                })
            }
        } catch (e: Exception) {
            done(null)
        }
    }

    @Suppress("DEPRECATION")
    private fun hostOf(info: NsdServiceInfo): String? {
        val addrs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) info.hostAddresses else listOfNotNull(info.host)
        return (addrs.firstOrNull { it is Inet4Address } ?: addrs.firstOrNull())?.hostAddress
    }

    private fun publish() = onChange(current())
}
