package com.ortakizle.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.app.AlertDialog
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val TAG = "OrtakIzle"
// https: Web Crypto (oda kodu şifrelemesi) yalnızca güvenli bağlamda çalışır
private const val UI_URL = "https://appassets.androidplatform.net/index.html"

// Ekran düzeni:
//   salon  : arayüz tam ekran, oynatıcı gizli
//   izleme : yatayda oynatıcı solda + panel sağda; dikeyde oynatıcı üstte + panel altta;
//            panel kapalıyken ya da tam ekranda oynatıcı tüm ekran, arayüz köşede küçük bir hap
class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private lateinit var playerBox: FrameLayout
    private lateinit var ui: WebView
    private lateinit var overlay: PlayerOverlay
    private var player: WebView? = null
    private var backAllowed = true
    private var popup: View? = null
    private var popupWeb: WebView? = null
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    private var watching = false
    private var panelOpen = true
    private var typing = false // izlerken yazma çubuğu açık
    private var floatW = 0 // css px
    private var floatH = 0
    private var desktopMode = true
    private var bootstrap: String? = null
    private var insets = intArrayOf(0, 0, 0, 0) // sol, üst, sağ, alt (sistem çubukları + klavye)
    private var barsBottom = 0 // alt sistem çubuğu (klavye hariç)
    private var lastLayoutMode = ""
    private var discovery: Discovery? = null
    private var uiDead = false

    private val density get() = resources.displayMetrics.density

    private val hostStopped = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            js("OI.onHostState(${Host.info()})")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#0B0B0C")) }
        playerBox = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
        }
        ui = WebView(this)
        // Oynatıcının üstündeki yerel katman (geri düğmesi, tepkiler, mesajlar, uyarılar)
        overlay = PlayerOverlay(this, onBack = { js("window.OI && OI.onBack('button')") }, onChat = {
            // Akan mesaja dokununca sohbet açılır
            panelOpen = true
            relayout()
        })
        playerBox.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(playerBox, FrameLayout.LayoutParams(0, 0))
        root.addView(ui, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        // Sistem çubukları ve klavye kadar boşluk bırak (Android 15+ kenardan kenara zorunlu)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, wi ->
            val bars = wi.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = wi.getInsets(WindowInsetsCompat.Type.ime())
            insets = intArrayOf(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            barsBottom = bars.bottom
            relayout()
            WindowInsetsCompat.CONSUMED
        }
        root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or, ob ->
            if (r - l != or - ol || b - t != ob - ot) root.post { relayout() }
        }

        setupUi()
        ui.setOnTouchListener { _, e -> panelResize(e) || floatDrag(e) }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = onBack()
        })
        val filter = IntentFilter(HostService.ACTION_STOPPED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(hostStopped, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(hostStopped, filter)
        }
    }

    override fun onDestroy() {
        try { unregisterReceiver(hostStopped) } catch (_: Exception) {}
        discovery?.shutdown()
        closePopup()
        player?.let {
            playerBox.removeView(it)
            it.destroy()
        }
        player = null
        if (!uiDead) {
            root.removeView(ui)
            ui.destroy()
        }
        super.onDestroy()
    }

    // Arka plandayken ağ taraması pil yemesin; arayüz dönünce yeniden başlatır
    override fun onStop() {
        super.onStop()
        discovery?.stop()
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onResume() {
        super.onResume()
        js("window.OI && OI.onResume()")
        // "Bilinmeyen uygulamaları yükle" izni verilip dönüldüyse kuruluma devam et
        // (Android izni açınca uygulamayı kapatıp yeniden başlatabilir; işaret kalıcıdır)
        Updater.resumeAfterPermission(this)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        root.post { relayout() }
    }

    // ------------------------------------------------------------------ arayüz WebView'ı

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun setupUi() {
        // Test sürümü: adb ile verilen yerel aracıları kullan (am start --es araci_tcp ... --es araci_ws ...)
        if (BuildConfig.DEBUG) {
            val tcp = intent?.getStringExtra("araci_tcp")
            val ws = intent?.getStringExtra("araci_ws")
            if (tcp != null) Host.testBrokers = tcp.split(',')
            intent?.getStringExtra("guncelleme_url")?.let { Updater.testBase = it }
            if (ws != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                @SuppressLint("RequiresFeature")
                fun add() = WebViewCompat.addDocumentStartJavaScript(
                    ui, "window.__ortakIzleBrokers = ${org.json.JSONArray(ws.split(','))};", setOf("*")
                )
                add()
            }
        }
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this).let { h ->
                WebViewAssetLoader.PathHandler { path -> h.handle("web/" + path.ifEmpty { "index.html" }) }
            })
            .build()
        ui.setBackgroundColor(Color.TRANSPARENT)
        ui.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            textZoom = 100
            // Panel parmakla büyütülüp küçültülmesin
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // Aynı Wi-Fi'daki odaya ws:// ile bağlanabilmek için
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        ui.isVerticalScrollBarEnabled = false
        ui.overScrollMode = View.OVER_SCROLL_NEVER
        ui.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                // Arayüzdeki dış bağlantılar oynatıcıda açılır
                runOnUiThread { openPlayer(url.toString()) }
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "Arayüz süreci kapandı, yeniden başlatılıyor")
                uiDead = true
                root.removeView(ui)
                ui.destroy()
                recreate()
                return true
            }
        }
        ui.addJavascriptInterface(NativeBridge(), "OrtakNative")
        ui.loadUrl(UI_URL)
    }

    private fun js(code: String) {
        runOnUiThread { if (!isDestroyed && !uiDead) ui.evaluateJavascript(code, null) }
    }

    // Arayüzden (yalnızca kendi dosyalarımızdan) çağrılan yerel işlevler
    inner class NativeBridge {
        @JavascriptInterface
        fun getInfo(): String = Host.info().toString()

        @JavascriptInterface
        fun startHost(password: String?, userName: String?, code: String?): String {
            val err = Host.start(this@MainActivity, password ?: "", userName ?: "", code ?: "")
            if (err != null) return JSONObject().put("ok", false).put("error", err).toString()
            runOnUiThread {
                askNotificationPermission()
                val i = Intent(this@MainActivity, HostService::class.java)
                try {
                    startForegroundService(i)
                } catch (e: Exception) {
                    Log.w(TAG, "Ön plan hizmeti başlatılamadı", e)
                }
                discovery?.stop()
            }
            return Host.info().toString()
        }

        @JavascriptInterface
        fun stopHost() {
            runOnUiThread {
                Host.stop(this@MainActivity)
                stopService(Intent(this@MainActivity, HostService::class.java))
            }
        }

        @JavascriptInterface
        fun startDiscovery() = runOnUiThread {
            val d = discovery ?: Discovery(this@MainActivity) { list -> js("OI.onDiscovered($list)") }.also { discovery = it }
            d.start()
            js("OI.onDiscovered(${d.current()})")
        }

        @JavascriptInterface
        fun stopDiscovery() = runOnUiThread { discovery?.stop() }

        @JavascriptInterface
        fun openPlayer(url: String) = runOnUiThread { this@MainActivity.openPlayer(url) }

        @JavascriptInterface
        fun closePlayer() = runOnUiThread { this@MainActivity.closePlayer(notify = false) }

        @JavascriptInterface
        fun toPlayer(json: String) = runOnUiThread {
            player?.evaluateJavascript("window.__ortakIzleRecv && window.__ortakIzleRecv($json)", null)
        }

        @JavascriptInterface
        fun setPanel(state: String) = runOnUiThread {
            panelOpen = state == "open"
            typing = state == "type"
            relayout()
            // Yazma çubuğu: klavyeyi aç (video üstte oynamaya devam eder)
            if (typing) ui.post {
                ui.requestFocus()
                (getSystemService(Context.INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)
                    ?.showSoftInput(ui, 0)
            }
        }

        @JavascriptInterface
        fun setFloatSize(w: Int, h: Int) = runOnUiThread {
            floatW = w.coerceIn(60, 480)
            floatH = h.coerceIn(56, 600)
            relayout()
        }

        @JavascriptInterface
        fun setDesktopMode(on: Boolean) = runOnUiThread {
            if (desktopMode != on) {
                desktopMode = on
                player?.let {
                    playerDesktop = wantsDesktop(it.url)
                    applyUserAgent(it)
                }
            }
        }

        @JavascriptInterface
        fun keepScreenOn(on: Boolean) = runOnUiThread {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        // Oynatıcı katmanı: {type: react|msg|notice|note|count|back|clear, ...}
        @JavascriptInterface
        fun overlay(json: String) = runOnUiThread {
            val o = try { JSONObject(json) } catch (_: Exception) { return@runOnUiThread }
            if (BuildConfig.DEBUG) Log.i(TAG, "Katman: $o")
            when (o.optString("type")) {
                "react" -> if (watching) overlay.react(o.optString("emoji").take(16), o.optString("name").take(30))
                "meme" -> if (watching) overlay.meme(o.optString("id"), o.optBoolean("img"), o.optString("name").take(30))
                "msg" -> if (watching) overlay.message(o.optString("name").take(30), o.optString("text").take(300))
                "notice" -> if (watching) overlay.notice(o.optString("text").take(200), o.optLong("ms", 4500))
                "note" -> overlay.note(o.optString("text").takeIf { o.has("text") && !o.isNull("text") }?.take(120))
                "count" -> overlay.countdown(o.optLong("ms"))
                "back" -> {
                    backAllowed = o.optBoolean("show", true)
                    overlay.setBackVisible(watching && backAllowed)
                }
                // Sitenin düğmelerine değmeyen yerler (oynatıcı kutusunun oranı olarak)
                "spots" -> {
                    val b = o.optJSONArray("back")
                    if (b != null && b.length() == 2) overlay.setBackSpot(b.optDouble(0).toFloat(), b.optDouble(1).toFloat())
                    else overlay.setBackSpot(null, null)
                    autoChatY = if (o.has("chat") && !o.isNull("chat")) o.optDouble("chat").toFloat().takeIf { it in 0f..1f } else null
                    relayout()
                }
            }
        }

        // Onay penceresi; sonuç OI.onConfirm(id, evet/hayır) ile döner
        @JavascriptInterface
        fun confirm(json: String) = runOnUiThread {
            val o = try { JSONObject(json) } catch (_: Exception) { return@runOnUiThread }
            val id = JSONObject.quote(o.optString("id"))
            if (BuildConfig.DEBUG) Log.i(TAG, "Onay: ${o.optString("title")}")
            AlertDialog.Builder(this@MainActivity)
                .setTitle(o.optString("title"))
                .setMessage(o.optString("text"))
                .setPositiveButton(o.optString("ok", "Tamam")) { _, _ -> js("OI.onConfirm($id, true)") }
                .setNegativeButton(o.optString("cancel", "Vazgeç")) { _, _ -> js("OI.onConfirm($id, false)") }
                .setOnCancelListener { js("OI.onConfirm($id, false)") }
                .show()
        }

        // Oynatıcıda bir sayfa geri; geçmiş yoksa ana ekrana dön
        @JavascriptInterface
        fun playerBack() = runOnUiThread {
            val p = player
            if (p != null && p.canGoBack()) p.goBack() else closePlayer(notify = true)
        }

        @JavascriptInterface
        fun appVersion(): String = JSONObject().put("name", BuildConfig.VERSION_NAME).put("code", BuildConfig.VERSION_CODE).toString()

        // Yeni sürüm var mı? Sonuç OI.onUpdate(bilgi | null) ile döner
        @JavascriptInterface
        fun checkUpdate() {
            Thread {
                val info = Updater.check()
                val failed = Updater.lastCheckFailed
                // Ulaşılamadıysa eldeki bilgiyi silme (indirme sürerken kart kaybolmasın)
                if (!failed) lastUpdate = info
                js("OI.onUpdate(${info?.toJson() ?: "null"}, $failed)")
            }.start()
        }

        // Yeni sürümü indir ve kurulum ekranını aç; ilerleme OI.onUpdateProgress(yüzde | hata)
        @JavascriptInterface
        fun installUpdate() {
            val info = lastUpdate ?: return
            Thread {
                // Zaten indirildiyse (ör. kurulum ekranı kapatıldıysa) yeniden indirme
                val ready = Updater.pending?.takeIf { it.exists() && it.name == "OrtakIzle-${info.code}.apk" } != null
                val err = if (ready) null else Updater.download(this@MainActivity, info) { p -> js("OI.onUpdateProgress($p)") }
                if (err != null) {
                    js("OI.onUpdateProgress(${JSONObject.quote(err)})")
                    return@Thread
                }
                js("OI.onUpdateProgress(100)")
                runOnUiThread {
                    when (val r = Updater.install(this@MainActivity)) {
                        null -> {}
                        "izin" -> {
                            Updater.markAwaitingPermission(this@MainActivity)
                            js("OI.onUpdateProgress(${JSONObject.quote("izin")})")
                        }
                        else -> js("OI.onUpdateProgress(${JSONObject.quote(r)})")
                    }
                }
            }.start()
        }

        @JavascriptInterface
        fun share(text: String) = runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            try {
                startActivity(Intent.createChooser(send, "Paylaş"))
            } catch (e: Exception) {
                Log.w(TAG, "Paylaşım açılamadı", e)
            }
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    // ------------------------------------------------------------------ oynatıcı WebView'ı

    private fun bootstrapScript(): String {
        bootstrap?.let { return it }
        val engine = assets.open("web/engine.js").use { it.readBytes().toString(Charsets.UTF_8) }
        val font = try {
            Base64.encodeToString(
                assets.open("web/fonts/plus-jakarta-sans-latin-800-normal.woff2").use { it.readBytes() },
                Base64.NO_WRAP,
            )
        } catch (_: Exception) {
            ""
        }
        val glue = """
            ;(function () {
              if (window.top !== window || window.__ortakIzle) return;
              window.__ortakIzle = true;
              var bridge = window.OrtakIzleNative;
              function post(m) {
                var s = JSON.stringify(m);
                if (bridge && bridge.postMessage) bridge.postMessage(s);
                else if (window.OrtakIzleBridge) window.OrtakIzleBridge.post(s);
              }
              try {
                if ('$font') {
                  var bin = atob('$font'), buf = new Uint8Array(bin.length);
                  for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
                  var face = new FontFace('OI Sans', buf.buffer, { weight: '800' });
                  face.load().then(function () { document.fonts.add(face); }).catch(function () {});
                }
              } catch (e) {}
              function start() {
                // Tepki, geri sayım ve notlar Android katmanında çizilir (stage: false)
                var engine = OrtakIzleEngine.create({ post: post, displayFont: 'OI Sans', stage: false });
                window.__ortakIzleRecv = function (m) { engine.receive(typeof m === 'string' ? JSON.parse(m) : m); };
              }
              if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
            })();
        """.trimIndent()
        return ("(function(){ if (window.top !== window) return;\n$engine\n})();\n$glue").also { bootstrap = it }
    }

    // Oynatıcı sayfasından gelen mesajı doğrula ve arayüze ilet. Sayfa güvenilmez
    // olduğu için yalnızca bilinen türler geçer ve JSON yeniden üretilir.
    private val allowedFromPlayer = setOf(
        "hello", "engine", "sync", "tick", "nav", "buffer", "countdown", "react", "invite", "typing", "drift", "notice",
        "zones", "diag",
    )

    private fun fromPlayer(raw: String) {
        if (raw.length > 20_000) return
        val obj = try { JSONObject(raw) } catch (_: Exception) { return }
        // Sitenin kendi ±10 sn tuşu (gerçek tuş basışı): yalnızca sağ/sol ok, en fazla 60 kez
        if (obj.optString("t") == "input") {
            playerKeys(obj.optString("key"), obj.optInt("n", 1).coerceIn(1, 60))
            return
        }
        if (obj.optString("t") !in allowedFromPlayer) return
        js("OI.fromPlayer($obj)")
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface", "RequiresFeature")
    private fun createPlayer(): WebView {
        val wv = WebView(this)
        wv.setBackgroundColor(Color.BLACK)
        configureBrowser(wv)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(wv, "OrtakIzleNative", setOf("*")) { _, message, _, isMainFrame, _ ->
                if (isMainFrame) message.data?.let { fromPlayer(it) }
            }
        } else {
            wv.addJavascriptInterface(object {
                @JavascriptInterface
                fun post(json: String) = runOnUiThread { fromPlayer(json) }
            }, "OrtakIzleBridge")
        }
        val docStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (docStart) {
            WebViewCompat.addDocumentStartJavaScript(wv, desktopPlatformScript, setOf("*"))
            WebViewCompat.addDocumentStartJavaScript(wv, bootstrapScript(), setOf("*"))
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (handleSpecialUrl(view, request.url)) return true
                // Oynatıcı içinde başka bir siteye geçildi (ör. YouTube'dan Disney+'a): masaüstü/mobil
                // kimliği o siteye göre değiştir ve sayfayı yeni kimlikle aç
                if (request.isForMainFrame && request.method == "GET" && !request.isRedirect) {
                    val want = wantsDesktop(request.url.toString())
                    if (want != playerDesktop) {
                        playerDesktop = want
                        applyUserAgent(view)
                        view.loadUrl(request.url.toString())
                        return true
                    }
                }
                return false
            }

            override fun onPageFinished(view: WebView, url: String?) {
                // Eski WebView'larda belge başı betiği yoksa sayfa yüklenince ekle
                if (!docStart) {
                    view.evaluateJavascript(desktopPlatformScript, null)
                    view.evaluateJavascript(bootstrapScript(), null)
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "Oynatıcı süreci kapandı")
                // Aynı süreçteki arayüz de gitmiş olabilir; ölü WebView'a dokunmadan kapat
                if (view == player) {
                    playerBox.removeView(view)
                    player = null
                    view.destroy()
                }
                closePlayer(notify = true)
                return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            // DRM (Widevine) izni: yalnızca korumalı içerik kimliği verilir
            override fun onPermissionRequest(request: PermissionRequest) {
                val ok = request.resources.filter { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }
                runOnUiThread {
                    if (ok.isNotEmpty()) request.grant(ok.toTypedArray()) else request.deny()
                }
            }

            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                customView = view
                customCallback = callback
                playerBox.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                overlay.bringToFront() // tam ekranda da tepkiler ve geri düğmesi görünsün
                relayout()
            }

            override fun onHideCustomView() = hideCustomView()

            // Giriş pencereleri (Apple ID, Google, Disney hesabı açılır pencereleri)
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (!isUserGesture) return false // reklam açılır pencereleri
                val child = openPopup()
                (resultMsg.obj as WebView.WebViewTransport).webView = child
                resultMsg.sendToTarget()
                return true
            }

            override fun onCloseWindow(window: WebView) {
                if (window == popupWeb) closePopup()
            }

            override fun getDefaultVideoPoster() =
                android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888)
        }
        return wv
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureBrowser(wv: WebView) {
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            allowFileAccess = false
            allowContentAccess = false
            textZoom = 100
        }
        applyUserAgent(wv)
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(wv, true)
        }
    }

    // Disney+ ve HBO Max telefonda web oynatıcıyı yalnızca masaüstü tarayıcıya açıyor.
    // Masaüstü modunda Windows'taki Chrome gibi görünürüz; değilse "wv" işaretini kaldırırız.
    // Bu platformlar telefonda web oynatıcıyı yalnızca masaüstü tarayıcıya açar: ayardan bağımsız
    // her zaman masaüstü kimliğiyle açılır
    private val desktopHosts = Regex("(^|\\.)(disneyplus\\.com|hbomax\\.com|max\\.com|netflix\\.com|primevideo\\.com|amazon\\.[a-z.]+|tv\\.apple\\.com|apple\\.com)$")
    private var playerDesktop = true

    private fun wantsDesktop(url: String?): Boolean {
        val host = url?.let { Uri.parse(it).host?.lowercase() } ?: return desktopMode
        return desktopMode || desktopHosts.containsMatchIn(host)
    }

    private fun applyUserAgent(wv: WebView, desktop: Boolean = playerDesktop) {
        val def = WebSettings.getDefaultUserAgent(this)
        val chrome = Regex("Chrome/(\\d+)").find(def)?.groupValues?.get(1) ?: "130"
        wv.settings.userAgentString = if (desktop) {
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$chrome.0.0.0 Safari/537.36"
        } else {
            def.replace("; wv", "").replace(Regex("Version/\\d+\\.\\d+ "), "")
        }
        // Siteler cihazı yalnızca User-Agent'tan değil "client hints" bilgisinden de anlıyor;
        // masaüstü modunda onu da Windows'taki Chrome gibi göster
        if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
            if (defaultUaMetadata == null) defaultUaMetadata = WebSettingsCompat.getUserAgentMetadata(wv.settings)
            val meta = if (desktop) {
                fun brand(name: String, major: String) =
                    UserAgentMetadata.BrandVersion.Builder().setBrand(name).setMajorVersion(major).setFullVersion("$major.0.0.0").build()
                UserAgentMetadata.Builder()
                    .setBrandVersionList(listOf(brand("Chromium", chrome), brand("Google Chrome", chrome), brand("Not_A Brand", "24")))
                    .setFullVersion("$chrome.0.0.0")
                    .setPlatform("Windows")
                    .setPlatformVersion("15.0.0")
                    .setArchitecture("x86")
                    .setBitness(64)
                    .setMobile(false)
                    .setModel("")
                    .build()
            } else {
                defaultUaMetadata
            }
            meta?.let { WebSettingsCompat.setUserAgentMetadata(wv.settings, it) }
        }
    }

    private var defaultUaMetadata: UserAgentMetadata? = null
    @Volatile private var lastUpdate: Updater.Info? = null

    // Masaüstü kimliğiyle açıldıysa sayfanın gördüğü diğer bilgiler de Windows'taki Chrome gibi olsun
    // (bazı siteler User-Agent dışında navigator.platform / userAgentData / dokunmatik ekrana bakıyor)
    private val desktopPlatformScript = """
        (function () {
          if (!/Windows NT/.test(navigator.userAgent)) return;
          function def(o, k, v) { try { Object.defineProperty(o, k, { get: function () { return v; }, configurable: true }); } catch (e) {} }
          def(Navigator.prototype, 'platform', 'Win32');
          def(Navigator.prototype, 'vendor', 'Google Inc.');
          // Masaüstü oynatıcılar dokunmatik ekran görünce kendi dokunma kipine geçip düğmelere
          // basılmasını engelleyebiliyor (Netflix, Disney+): fareli bilgisayar gibi görün
          def(Navigator.prototype, 'maxTouchPoints', 0);
          try {
            ['ontouchstart', 'ontouchmove', 'ontouchend', 'ontouchcancel'].forEach(function (k) {
              [Window.prototype, Document.prototype, HTMLElement.prototype, Element.prototype].forEach(function (p) {
                try { delete p[k]; } catch (e) {}
              });
              try { delete window[k]; } catch (e) {}
            });
          } catch (e) {}
          try {
            var mm = window.matchMedia.bind(window);
            var fix = function (q) {
              return String(q).replace(/\(\s*(any-)?(pointer|hover)\s*:\s*([a-z-]+)\s*\)/gi, function (all, any, kind, val) {
                var yes = kind.toLowerCase() === 'pointer' ? val.toLowerCase() === 'fine' : val.toLowerCase() === 'hover';
                return yes ? '(min-width: 0px)' : '(max-width: -1px)';
              });
            };
            window.matchMedia = function (q) { return mm(fix(q)); };
          } catch (e) {}
          try {
            var u = navigator.userAgentData;
            if (!u || u.mobile || u.platform !== 'Windows') {
              var v = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '130';
              var brands = [{ brand: 'Chromium', version: v }, { brand: 'Google Chrome', version: v }, { brand: 'Not_A Brand', version: '24' }];
              var fake = {
                brands: brands, mobile: false, platform: 'Windows',
                getHighEntropyValues: function () {
                  return Promise.resolve({ brands: brands, mobile: false, platform: 'Windows', platformVersion: '15.0.0',
                    architecture: 'x86', bitness: '64', model: '', uaFullVersion: v + '.0.0.0',
                    fullVersionList: brands.map(function (b) { return { brand: b.brand, version: b.version + '.0.0.0' }; }) });
                },
                toJSON: function () { return { brands: brands, mobile: false, platform: 'Windows' }; }
              };
              def(Navigator.prototype, 'userAgentData', fake);
            }
          } catch (e) {}
        })();
    """.trimIndent()

    // Uygulama mağazasına ya da platformun kendi uygulamasına atma bağlantılarını engelle
    private fun handleSpecialUrl(view: WebView, uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return true
        if (scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data") return false
        if (scheme == "intent") {
            val fallback = Regex("S\\.browser_fallback_url=([^;]+)").find(uri.toString())?.groupValues?.get(1)
            if (fallback != null) Uri.decode(fallback).takeIf(::isWeb)?.let(view::loadUrl)
        }
        Log.i(TAG, "Engellenen bağlantı: $uri")
        return true
    }

    // Oynatıcıya gerçek ok tuşu basışı: Disney+ gibi oynatıcılar videonun konumunun dışarıdan
    // değiştirilmesine dayanamayıp donuyor; kendi ±10 sn tuşlarıyla sarınca sorun olmuyor.
    private fun playerKeys(key: String, n: Int) {
        val code = when (key) {
            "left" -> KeyEvent.KEYCODE_DPAD_LEFT
            "right" -> KeyEvent.KEYCODE_DPAD_RIGHT
            else -> return
        }
        val wv = player ?: return
        if (BuildConfig.DEBUG) Log.i(TAG, "Tuş: $key x$n")
        // Tuşlar odaktaki görünüme gider: kullanıcı yazı yazmıyorsa odağı oynatıcıya ver
        if (!wv.hasFocus() && !typing) wv.requestFocus()
        for (i in 0 until n) {
            wv.postDelayed({
                if (player !== wv) return@postDelayed
                val t = SystemClock.uptimeMillis()
                wv.dispatchKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0))
                wv.dispatchKeyEvent(KeyEvent(t, t + 40, KeyEvent.ACTION_UP, code, 0))
            }, i * 160L)
        }
    }

    private fun isWeb(u: String) = Uri.parse(u).scheme?.lowercase().let { it == "http" || it == "https" }

    private fun openPlayer(url: String) {
        if (!isWeb(url)) return
        val wv = player ?: createPlayer().also {
            player = it
            playerBox.addView(it, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        playerDesktop = wantsDesktop(url)
        applyUserAgent(wv)
        wv.loadUrl(url)
        watching = true
        panelOpen = true
        typing = false
        playerBox.visibility = View.VISIBLE
        overlay.clear()
        overlay.setBackVisible(backAllowed)
        overlay.bringToFront()
        relayout()
    }

    private fun closePlayer(notify: Boolean) {
        hideCustomView()
        closePopup()
        player?.let {
            playerBox.removeView(it)
            it.stopLoading()
            it.loadUrl("about:blank")
            it.destroy()
        }
        player = null
        watching = false
        overlay.clear()
        overlay.setBackVisible(false)
        playerBox.visibility = View.GONE
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        relayout()
        if (notify) js("OI.onPlayerClosed()")
    }

    private fun hideCustomView() {
        val v = customView ?: return
        playerBox.removeView(v)
        customView = null
        customCallback?.onCustomViewHidden()
        customCallback = null
        relayout()
    }

    // ------------------------------------------------------------------ açılır pencere (giriş)

    @SuppressLint("SetJavaScriptEnabled")
    private fun openPopup(): WebView {
        closePopup()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0B0B0C"))
            isClickable = true
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(8), dp(8), dp(8))
        }
        val title = TextView(this).apply {
            text = "Giriş"
            setTextColor(Color.WHITE)
            textSize = 15f
        }
        val close = TextView(this).apply {
            text = "Kapat"
            setTextColor(Color.parseColor("#FF6B3D"))
            textSize = 15f
            setPadding(dp(16), dp(10), dp(16), dp(10))
            setOnClickListener { closePopup() }
        }
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(close)
        val web = WebView(this)
        configureBrowser(web)
        web.settings.setSupportMultipleWindows(false)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = handleSpecialUrl(view, request.url)
            override fun onPageFinished(view: WebView, url: String?) {
                title.text = view.title?.takeIf { it.isNotBlank() } ?: "Giriş"
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                closePopup()
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView) = closePopup()
        }
        box.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        box.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        popup = box
        popupWeb = web
        relayout()
        return web
    }

    private fun closePopup() {
        val box = popup ?: return
        root.removeView(box)
        popupWeb?.destroy()
        popup = null
        popupWeb = null
    }

    // ------------------------------------------------------------------ geri tuşu

    private fun onBack() {
        when {
            popup != null -> {
                val w = popupWeb
                if (w != null && w.canGoBack()) w.goBack() else closePopup()
            }
            customView != null -> hideCustomView()
            // İzlerken geri hareketi kazara bölümden çıkarmasın: arayüz karar verir (onay sorar,
            // kilitliyse engeller). Arayüz yoksa eski davranış.
            watching && !uiDead -> js("window.OI ? OI.onBack('system') : OrtakNative.playerBack()")
            watching -> {
                val p = player
                if (p != null && p.canGoBack()) p.goBack() else closePlayer(notify = true)
            }
            else -> {
                // Oda açıksa uygulama kapanmasın, arka plana geçsin
                if (Host.hosting) moveTaskToBack(true) else finish()
            }
        }
    }

    // ------------------------------------------------------------------ yerleşim

    private fun dp(v: Int) = (v * density).roundToInt()

    private fun relayout() {
        val w = root.width
        val h = root.height
        if (w == 0 || h == 0) return
        val (il, itop, ir, ib) = insets.toList()
        val landscape = w > h
        val fullscreen = customView != null
        val immersive = watching && (landscape || fullscreen || !panelOpen || typing)

        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (immersive) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }

        // Kullanılabilir alan (sistem çubukları / klavye dışında)
        val left = il
        val top = itop
        val right = w - ir
        val bottom = h - ib
        val aw = right - left
        val ah = bottom - top

        popup?.let { place(it, left, top, aw, ah) }
        // Tam ekranda (sistem çubukları gizli) geri düğmesi çentiğe denk gelmesin
        if (!watching || (!panelOpen || fullscreen)) overlay.setInsets(il, itop) else overlay.setInsets(0, 0)

        val mode: String
        if (!watching) {
            mode = "full"
            place(ui, left, top, aw, ah)
        } else if (typing) {
            mode = "type"
            // Video üstte tam genişlik, altta (klavyenin hemen üstünde) yazma çubuğu
            val bar = dp(58)
            val ph = max(dp(100), bottom - bar)
            place(playerBox, 0, 0, w, ph)
            place(ui, left, ph, aw, bottom - ph)
        } else if (!panelOpen || fullscreen) {
            mode = "float"
            // Oynatıcı tüm ekran (sistem çubukları gizli olduğu için kenarlara kadar)
            place(playerBox, 0, 0, w, h)
            val fw = dp(if (floatW > 0) floatW else 120)
            val fh = dp(if (floatH > 0) floatH else 72)
            if (!floatDragging) {
                // Klavye hesaba katılmaz (yazma çubuğu kapanırken klavye bir an açık kalıyor)
                val (x, y) = floatSpot(landscape, left, top, right, h - barsBottom, fw, fh)
                place(ui, x, y, fw, fh)
            }
        } else if (landscape) {
            mode = "side"
            // Panel genişliği: kullanıcı kenarından sürükleyip ayarladıysa o (dp), yoksa varsayılan
            val want = prefs.getInt("panelGenislik", 0).takeIf { it > 0 }?.let { dp(it) } ?: min(dp(380), (aw * 0.42f).roundToInt())
            val panel = want.coerceIn(min(dp(250), aw / 2), (aw * 0.7f).roundToInt())
            place(playerBox, left, top, aw - panel, ah)
            place(ui, left + aw - panel, top, panel, ah)
        } else {
            mode = "bottom"
            // Video 16:9, panel en az ekranın %45'i
            var ph = (aw * 9f / 16f).roundToInt()
            ph = min(ph, (ah * 0.55f).roundToInt())
            // Kullanıcı panelin üst kenarını sürükleyip videoyu büyüttü/küçülttüyse
            prefs.getFloat("videoYukseklik", 0f).takeIf { it > 0f }?.let { ph = (ah * it).roundToInt() }
            // Klavye açıkken videoyu küçült ama yok etme
            ph = max(min(ph, ah - dp(220)), dp(120))
            place(playerBox, left, top, aw, ph)
            place(ui, left, top + ph, aw, ah - ph)
        }
        ui.bringToFront()
        popup?.bringToFront()
        // Oynatıcı kutusunun boyutu (dp) arayüze: katman düğmelerinin yeri buna göre seçilir
        if (watching) {
            val lp = playerBox.layoutParams
            val box = "${(lp.width / density).roundToInt()}x${(lp.height / density).roundToInt()}"
            if (box != lastPlayerBox && lp.width > 0) {
                lastPlayerBox = box
                js("window.OI && OI.setPlayerBox && OI.setPlayerBox(${JSONObject().put("w", (lp.width / density).roundToInt()).put("h", (lp.height / density).roundToInt())})")
            }
        } else lastPlayerBox = ""
        if (BuildConfig.DEBUG && watching) overlay.postDelayed({
            overlay.backCenter()?.let { Log.i(TAG, "Geri düğmesi: ${it[0]} ${it[1]}") }
            if (lastLayoutMode == "float") logFloat()
            player?.let { p ->
                val loc = IntArray(2)
                p.getLocationOnScreen(loc)
                Log.i(TAG, "Oynatıcı kutusu: ${loc[0]} ${loc[1]} ${p.width} ${p.height}")
            }
            val ul = IntArray(2)
            ui.getLocationOnScreen(ul)
            Log.i(TAG, "Arayüz kutusu: ${ul[0]} ${ul[1]} ${ui.width} ${ui.height} $lastLayoutMode")
        }, 400)
        if (mode != lastLayoutMode) {
            lastLayoutMode = mode
            js("window.OI && OI.setLayout(${JSONObject().put("mode", mode).put("fullscreen", fullscreen)})")
        }
    }

    // ------------------------------------------------------------------ sohbet düğmesi (yüzen hap)
    // Varsayılan yer: dikeyde sağ alt (videonun altındaki boşluk), yatayda sağ kenarın ortası
    // (yatayda sağ altta oynatıcının ayar / tam ekran düğmeleri var). Parmakla sürüklenir, yer
    // dikey ve yatay için ayrı ayrı hatırlanır.
    // Konum, alanın oranı olarak saklanır: fx = hapın sağ kenarı, fy = hapın orta noktası.
    private val prefs by lazy { getSharedPreferences("yerlesim", Context.MODE_PRIVATE) }
    private var floatDragging = false
    private var autoChatY: Float? = null // sitenin düğmelerinden kaçan varsayılan yükseklik
    private var lastPlayerBox = ""
    private var floatUp = false
    private var dragX = 0f
    private var dragY = 0f
    private var dragStartX = 0
    private var dragStartY = 0

    private fun floatHalf() = dp(39) // düğme sırasının yarı yüksekliği (12 + 54/2)

    private fun floatSpot(landscape: Boolean, left: Int, top: Int, right: Int, bottom: Int, fw: Int, fh: Int): Pair<Int, Int> {
        val key = if (landscape) "yatay" else "dikey"
        val fx = prefs.getFloat("${key}X", 1f)
        // Kullanıcı sürüklediyse onun yeri; yoksa sitenin düğmelerine değmeyen yer; yoksa varsayılan
        val fy = if (prefs.contains("${key}Y")) prefs.getFloat("${key}Y", 0.5f) else autoChatY ?: if (landscape) 0.5f else 0.93f
        val aw = right - left
        val ah = bottom - top
        val edge = (left + fx * aw).roundToInt().coerceIn(left + min(fw, aw), right)
        val x = (edge - fw).coerceIn(left, max(left, right - fw))
        val cy = (top + fy * ah).roundToInt()
        // Alt yarıdaysa bildirimler düğmenin üstünde açılır (pencere yukarı doğru büyür)
        val up = fy > 0.5f
        // Hap moduna her girişte de bildir (arayüz bu arada yeniden yüklenmiş olabilir)
        if (up != floatUp || lastLayoutMode != "float") {
            floatUp = up
            js("window.OI && OI.setFloatUp && OI.setFloatUp($up)")
        }
        val y = (if (up) cy + floatHalf() - fh else cy - floatHalf()).coerceIn(top, max(top, bottom - fh))
        return x to y
    }

    // Test sürümü: sohbet düğmesinin (turuncu) ekrandaki orta noktası
    private fun logFloat() {
        val lp = ui.layoutParams as? FrameLayout.LayoutParams ?: return
        val cx = lp.leftMargin + lp.width - dp(39)
        val cy = if (floatUp) lp.topMargin + lp.height - dp(39) else lp.topMargin + dp(39)
        Log.i(TAG, "Sohbet düğmesi: $cx $cy")
    }

    // Paneli boyutlandırma: yanda sol kenarından (sağa-sola), altta üst kenarından (yukarı-aşağı)
    // tutup sürükle. Yeni boyut hatırlanır.
    private var resizing = false
    private fun panelResize(e: MotionEvent): Boolean {
        val mode = lastLayoutMode
        if (mode != "side" && mode != "bottom") return false
        val lp = ui.layoutParams as? FrameLayout.LayoutParams ?: return false
        val (il, itop, ir, ib) = insets.toList()
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                // Tutamak bölgesi: panelin kenarındaki 20 dp'lik şerit (düğmeler bunun dışında)
                resizing = if (mode == "side") e.x < dp(20) else e.y < dp(20)
                return resizing
            }
            MotionEvent.ACTION_MOVE -> {
                if (!resizing) return false
                if (mode == "side") {
                    val right = root.width - ir
                    val aw = right - il
                    val w = (right - e.rawX.roundToInt()).coerceIn(min(dp(250), aw / 2), (aw * 0.7f).roundToInt())
                    prefs.edit().putInt("panelGenislik", (w / density).roundToInt()).apply()
                } else {
                    val ah = root.height - ib - itop
                    val ph = (e.rawY.roundToInt() - itop).coerceIn(dp(120), max(dp(120), ah - dp(200)))
                    prefs.edit().putFloat("videoYukseklik", ph.toFloat() / ah).apply()
                }
                relayout()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val was = resizing
                resizing = false
                if (was && BuildConfig.DEBUG) Log.i(TAG, "Panel boyutu: ${lp.width} x ${lp.height}")
                return was
            }
        }
        return resizing
    }

    private fun floatDrag(e: MotionEvent): Boolean {
        if (lastLayoutMode != "float") return false
        val lp = ui.layoutParams as? FrameLayout.LayoutParams ?: return false
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragX = e.rawX
                dragY = e.rawY
                dragStartX = lp.leftMargin
                dragStartY = lp.topMargin
                floatDragging = false
                return false
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = e.rawX - dragX
                val dy = e.rawY - dragY
                if (!floatDragging) {
                    if (hypot(dx, dy) < dp(10)) return false
                    floatDragging = true
                    // Düğme "basıldı" sanmasın
                    val cancel = MotionEvent.obtain(e).apply { action = MotionEvent.ACTION_CANCEL }
                    ui.onTouchEvent(cancel)
                    cancel.recycle()
                }
                val w = root.width
                val h = root.height
                place(
                    ui,
                    (dragStartX + dx.roundToInt()).coerceIn(0, max(0, w - lp.width)),
                    (dragStartY + dy.roundToInt()).coerceIn(0, max(0, h - lp.height)),
                    lp.width, lp.height,
                )
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (!floatDragging) return false
                floatDragging = false
                val (il, itop, ir, _) = insets.toList()
                val w = root.width
                val h = root.height
                val aw = (w - ir - il).coerceAtLeast(1)
                val ah = (h - barsBottom - itop).coerceAtLeast(1)
                val now = ui.layoutParams as FrameLayout.LayoutParams
                val fx = ((now.leftMargin + now.width - il).toFloat() / aw).coerceIn(0f, 1f)
                val cy = if (floatUp) now.topMargin + now.height - floatHalf() else now.topMargin + floatHalf()
                val fy = ((cy - itop).toFloat() / ah).coerceIn(0f, 1f)
                val key = if (w > h) "yatay" else "dikey"
                prefs.edit().putFloat("${key}X", fx).putFloat("${key}Y", fy).apply()
                relayout()
                if (BuildConfig.DEBUG) ui.postDelayed({ logFloat() }, 300)
                return true
            }
        }
        return floatDragging
    }

    private fun place(v: View, x: Int, y: Int, width: Int, height: Int) {
        val lp = (v.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(width, height)
        if (lp.width == width && lp.height == height && lp.leftMargin == x && lp.topMargin == y && v.layoutParams != null) return
        lp.width = width
        lp.height = height
        lp.leftMargin = x
        lp.topMargin = y
        lp.gravity = Gravity.TOP or Gravity.START
        v.layoutParams = lp
    }
}
