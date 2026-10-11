package com.ortakizle.core

import java.io.File
import java.io.FileOutputStream
import java.io.FileDescriptor
import java.io.PrintStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.CountDownLatch

// Masaüstünde deneme için: PORT, ODA_SIFRE, ODA_ADI, ASSETS_DIR ortam değişkenleri

fun localAddresses(): List<String> = try {
    NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.toList() }
        .filterIsInstance<Inet4Address>()
        .map { it.hostAddress }
} catch (e: Exception) {
    emptyList()
}

fun main() {
    // Konsol yerel ayarı ne olursa olsun Türkçe karakterler bozulmasın
    System.setOut(PrintStream(FileOutputStream(FileDescriptor.out), true, "UTF-8"))
    val port = System.getenv("PORT")?.toIntOrNull() ?: 8787
    val password = System.getenv("ODA_SIFRE")?.takeIf { it.isNotEmpty() }
    val hostname = try {
        InetAddress.getLocalHost().hostName
    } catch (e: Exception) {
        null
    }
    val name = (System.getenv("ODA_ADI")?.takeIf { it.isNotEmpty() } ?: hostname?.takeIf { it.isNotEmpty() } ?: "Ortak İzle").take(40)
    val assets = DirectoryAssetSource(File(System.getenv("ASSETS_DIR") ?: "../web"))
    val fmt = DateTimeFormatter.ofPattern("HH:mm:ss")

    val server = RoomServer(port, password, name, assets) { println("${LocalTime.now().format(fmt)} $it") }
    server.start()
    val p = server.boundPort
    println("\n  Ortak İzle sunucusu çalışıyor 🎬\n")
    println("  Bu cihazda:      http://localhost:$p")
    for (ip in localAddresses()) println("  Aynı Wi-Fi'da:   http://$ip:$p")
    println("\n  Eklentideki \"Sunucu adresi\" alanına yukarıdakilerden birini yazın.")
    println("  Farklı evlerdeyseniz README'deki Tailscale adımlarına bakın.")
    println(if (password != null) "  Şifre: AÇIK (ODA_SIFRE)\n" else "  Şifre: kapalı (ODA_SIFRE ile açabilirsiniz)\n")

    val done = CountDownLatch(1)
    Runtime.getRuntime().addShutdownHook(Thread {
        server.stop()
        done.countDown()
    })
    done.await()
}
