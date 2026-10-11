package com.ortakizle.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

// Oda bu cihazda açıkken uygulamayı arka planda canlı tutar (ön plan hizmeti),
// Wi-Fi'ın uykuya geçmesini engeller ve bildirimde odadakileri gösterir.
class HostService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var lastText = ""

    private val refresh = object : Runnable {
        override fun run() {
            if (!Host.hosting) {
                stopSelf()
                return
            }
            val text = summaryText()
            if (text != lastText) {
                lastText = text
                getSystemService(NotificationManager::class.java)?.notify(NOTIF_ID, build(text))
            }
            handler.postDelayed(this, 5000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Host.stop(this)
            sendBroadcast(Intent(ACTION_STOPPED).setPackage(packageName))
            stopSelf()
            return START_NOT_STICKY
        }
        if (!Host.hosting) {
            stopSelf()
            return START_NOT_STICKY
        }
        createChannel()
        val notif = build(summaryText())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        acquireLocks()
        handler.removeCallbacks(refresh)
        handler.post(refresh)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(refresh)
        releaseLocks()
        super.onDestroy()
    }

    // Uygulama son kullanılanlardan kaydırılıp kapatılırsa oda da kapanır
    override fun onTaskRemoved(rootIntent: Intent?) {
        Host.stop(this)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    private fun summaryText(): String {
        val people = Host.server?.summary()?.flatMap { it.second } ?: emptyList()
        return when {
            people.isEmpty() -> "Kimse bağlı değil · ${Host.addresses(Host.port).firstOrNull()?.second ?: "adres yok"}"
            else -> "${people.size} kişi: ${people.joinToString(", ")}"
        }
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val ch = NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW)
        ch.description = getString(R.string.channel_desc)
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
    }

    private fun build(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, HostService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_room)
            .setContentTitle("Oda açık")
            .setContentText(text)
            .setColor(0xFFD6A75B.toInt())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Odayı kapat", stop).build())
            .build()
    }

    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wm?.createWifiLock(mode, "OrtakIzle:oda")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OrtakIzle:oda")?.apply {
                setReferenceCounted(false)
                acquire(6 * 60 * 60 * 1000L) // en fazla 6 saat
            }
        }
    }

    private fun releaseLocks() {
        try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        wifiLock = null
        wakeLock = null
    }

    companion object {
        const val CHANNEL = "oda"
        const val NOTIF_ID = 1
        const val ACTION_STOP = "com.ortakizle.app.STOP_HOST"
        const val ACTION_STOPPED = "com.ortakizle.app.HOST_STOPPED"
    }
}
