package com.ortakizle.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

private const val TAG = "OrtakIzle"

// Uygulama içi güncelleme: GitHub'daki dist/version.json'a bakar, yeni sürüm varsa APK'yı indirir,
// aynı anahtarla imzalandığını doğrular ve Android'in kurulum ekranını açar. Eski sürümü silmeye
// gerek kalmaz (aynı imza: üstüne kurulur, ayarlar ve giriş bilgileri korunur).
object Updater {
    private const val RAW = "https://raw.githubusercontent.com/Berkaybztepe/Ortak-dizi-film"
    // Önce ana dal, sonra geliştirme dalı; hangisinde daha yeni sürüm varsa o
    private val BRANCHES = listOf("main", "claude/shared-streaming-app-62tivs")

    data class Info(val code: Int, val name: String, val notes: String, val apkUrl: String, val sha256: String?) {
        fun toJson(): JSONObject = JSONObject().put("code", code).put("name", name).put("notes", notes)
    }

    @Volatile var pending: File? = null
        private set

    /** Yalnızca test sürümünde: GitHub yerine bu adresteki version.json kullanılır */
    @Volatile var testBase: String? = null

    private fun get(url: String, timeoutMs: Int = 10_000): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.instanceFollowRedirects = true
        c.setRequestProperty("Cache-Control", "no-cache")
        return c
    }

    /** Yeni sürüm varsa bilgisini döndürür (ağ isteği: arka planda çağırın) */
    /** Son denetimde hiçbir adrese ulaşılamadı mı (internet yok)? */
    @Volatile var lastCheckFailed = false
        private set

    fun check(): Info? {
        var best: Info? = null
        var reached = false
        val bases = testBase?.let { listOf(it.trimEnd('/')) } ?: BRANCHES.map { "$RAW/$it" }
        for (base in bases) {
            try {
                val c = get("$base/dist/version.json?t=${System.currentTimeMillis() / 60000}")
                val status = c.responseCode
                reached = true
                if (status != 200) continue
                val j = JSONObject(c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) })
                val info = Info(
                    code = j.getInt("versionCode"),
                    name = j.optString("versionName"),
                    notes = j.optString("notes"),
                    apkUrl = "$base/" + j.optString("apk", "dist/OrtakIzle.apk"),
                    sha256 = j.optString("sha256").takeIf { it.length == 64 },
                )
                if (best == null || info.code > best.code) best = info
            } catch (e: Exception) {
                Log.i(TAG, "Güncelleme denetimi ($base): ${e.message}")
            }
        }
        lastCheckFailed = !reached
        return best?.takeIf { it.code > BuildConfig.VERSION_CODE }
    }

    /** APK'yı indirip doğrular; hata metni döndürür (null = hazır, [pending] dolu) */
    fun download(context: Context, info: Info, progress: (Int) -> Unit): String? {
        val dir = File(context.cacheDir, "guncelleme").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, "OrtakIzle-${info.code}.apk")
        try {
            val c = get(info.apkUrl, 30_000)
            if (c.responseCode != 200) return "İndirilemedi (HTTP ${c.responseCode})"
            val total = c.contentLengthLong
            val md = MessageDigest.getInstance("SHA-256")
            c.inputStream.use { input ->
                file.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var last = -1
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        md.update(buf, 0, n)
                        done += n
                        if (total > 0) {
                            val p = (done * 100 / total).toInt()
                            if (p != last) {
                                last = p
                                progress(minOf(p, 99)) // 100 = doğrulandı, kuruluma hazır
                            }
                        }
                    }
                }
            }
            val hash = md.digest().joinToString("") { "%02x".format(it) }
            if (info.sha256 != null && !hash.equals(info.sha256, ignoreCase = true)) {
                file.delete()
                return "İndirilen dosya bozuk, tekrar dene."
            }
        } catch (e: Exception) {
            file.delete()
            return "İndirilemedi: ${e.message ?: "bağlantı hatası"}"
        }
        val err = verify(context, file, info.code)
        if (err != null) {
            file.delete()
            return err
        }
        pending = file
        return null
    }

    // İndirilen APK bu uygulamanın daha yeni bir sürümü mü ve aynı anahtarla mı imzalanmış?
    @SuppressLint("PackageManagerGetSignatures")
    @Suppress("DEPRECATION")
    private fun verify(context: Context, file: File, code: Int): String? {
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive: PackageInfo = pm.getPackageArchiveInfo(file.path, flags) ?: return "İndirilen dosya bir uygulama değil."
        if (archive.packageName != context.packageName) return "İndirilen dosya Ortak İzle değil."
        val archiveCode = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        if (archiveCode < code || archiveCode <= BuildConfig.VERSION_CODE) return "İndirilen sürüm daha yeni değil."
        val mine = pm.getPackageInfo(context.packageName, flags)
        fun certs(p: PackageInfo): Set<String> {
            val sigs = if (Build.VERSION.SDK_INT >= 28) {
                p.signingInfo?.apkContentsSigners?.toList() ?: emptyList()
            } else {
                p.signatures?.toList() ?: emptyList()
            }
            return sigs.map { s -> MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
        }
        if (Build.VERSION.SDK_INT >= 28 || archive.signatures != null) {
            val a = certs(archive)
            if (a.isNotEmpty() && a != certs(mine)) return "İndirilen sürümün imzası farklı; güvenlik için kurulmadı."
        }
        return null
    }

    fun canInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    // "Bilinmeyen uygulamaları yükle" izni açılınca Android uygulamayı kapatır: kaldığımız yeri
    // (indirilmiş dosya önbellekte durur) bir işaretle hatırlarız, uygulama açılınca kuruluma devam
    private const val PREFS = "guncelleme"

    fun markAwaitingPermission(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("izinBekleniyor", true).apply()
    }

    /** İzin verilip dönüldüyse kurulum ekranını açar */
    fun resumeAfterPermission(activity: Activity) {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("izinBekleniyor", false) || !canInstall(activity)) return
        prefs.edit().remove("izinBekleniyor").apply()
        // APK'yı çözümlemek ana iş parçacığını bekletmesin
        Thread {
            if (pending == null) pending = restore(activity)
            if (pending != null) activity.runOnUiThread { if (!activity.isFinishing) install(activity) }
        }.start()
    }

    // Önbellekte indirilmiş, doğrulanmış en yeni APK
    private fun restore(context: Context): File? {
        val files = File(context.cacheDir, "guncelleme").listFiles() ?: return null
        val re = Regex("OrtakIzle-(\\d+)\\.apk")
        val best = files.mapNotNull { f -> re.matchEntire(f.name)?.groupValues?.get(1)?.toIntOrNull()?.let { it to f } }
            .maxByOrNull { it.first } ?: return null
        return best.second.takeIf { verify(context, it, best.first) == null }
    }

    /** Kurulum ekranını açar; izin yoksa önce "bilinmeyen uygulamaları yükle" ayarına götürür */
    fun install(activity: Activity): String? {
        val file = pending ?: return "Önce güncellemeyi indir."
        if (!file.exists()) return "Dosya bulunamadı, tekrar indir."
        if (!canInstall(activity)) {
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                )
            } catch (e: Exception) {
                return "Ayarlar açılamadı: Ayarlar → Uygulamalar → Ortak İzle → Bilinmeyen uygulamaları yükle"
            }
            return "izin"
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
        val i = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            activity.startActivity(i)
            null
        } catch (e: Exception) {
            "Kurulum ekranı açılamadı: ${e.message}"
        }
    }
}
