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
import android.util.Base64
import android.util.Log
import android.view.Gravity
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
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val TAG = "OrtakIzle"
private const val UI_URL = "http://appassets.androidplatform.net/index.html"

// Ekran düzeni:
//   salon  : arayüz tam ekran, oynatıcı gizli
//   izleme : yatayda oynatıcı solda + panel sağda; dikeyde oynatıcı üstte + panel altta;
//            panel kapalıyken ya da tam ekranda oynatıcı tüm ekran, arayüz köşede küçük bir hap
class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private lateinit var playerBox: FrameLayout
    private lateinit var ui: WebView
    private var player: WebView? = null
    private var popup: View? = null
    private var popupWeb: WebView? = null
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    private var watching = false
    private var panelOpen = true
    private var floatW = 0 // css px
    private var floatH = 0
    private var desktopMode = true
    private var bootstrap: String? = null
    private var insets = intArrayOf(0, 0, 0, 0) // sol, üst, sağ, alt (sistem çubukları + klavye)
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
        root.addView(playerBox, FrameLayout.LayoutParams(0, 0))
        root.addView(ui, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        // Sistem çubukları ve klavye kadar boşluk bırak (Android 15+ kenardan kenara zorunlu)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, wi ->
            val bars = wi.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = wi.getInsets(WindowInsetsCompat.Type.ime())
            insets = intArrayOf(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            relayout()
            WindowInsetsCompat.CONSUMED
        }
        root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or, ob ->
            if (r - l != or - ol || b - t != ob - ot) root.post { relayout() }
        }

        setupUi()
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
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        root.post { relayout() }
    }

    // ------------------------------------------------------------------ arayüz WebView'ı

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun setupUi() {
        val loader = WebViewAssetLoader.Builder()
            .setHttpAllowed(true)
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
        fun startHost(password: String?, userName: String?): String {
            val err = Host.start(this@MainActivity, password ?: "", userName ?: "")
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
            relayout()
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
                player?.let { applyUserAgent(it) }
            }
        }

        @JavascriptInterface
        fun keepScreenOn(on: Boolean) = runOnUiThread {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }

        @JavascriptInterface
        fun share(text: String) = runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            try {
                startActivity(Intent.createChooser(send, "Oda adresini gönder"))
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
                var engine = OrtakIzleEngine.create({ post: post, displayFont: 'OI Sans' });
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
        "hello", "engine", "sync", "tick", "nav", "buffer", "countdown", "react", "invite", "typing",
    )

    private fun fromPlayer(raw: String) {
        if (raw.length > 20_000) return
        val obj = try { JSONObject(raw) } catch (_: Exception) { return }
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
        if (docStart) WebViewCompat.addDocumentStartJavaScript(wv, bootstrapScript(), setOf("*"))

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                handleSpecialUrl(view, request.url)

            override fun onPageFinished(view: WebView, url: String?) {
                // Eski WebView'larda belge başı betiği yoksa sayfa yüklenince ekle
                if (!docStart) view.evaluateJavascript(bootstrapScript(), null)
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
    private fun applyUserAgent(wv: WebView) {
        val def = WebSettings.getDefaultUserAgent(this)
        val chrome = Regex("Chrome/(\\d+)").find(def)?.groupValues?.get(1) ?: "130"
        wv.settings.userAgentString = if (desktopMode) {
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$chrome.0.0.0 Safari/537.36"
        } else {
            def.replace("; wv", "").replace(Regex("Version/\\d+\\.\\d+ "), "")
        }
    }

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

    private fun isWeb(u: String) = Uri.parse(u).scheme?.lowercase().let { it == "http" || it == "https" }

    private fun openPlayer(url: String) {
        if (!isWeb(url)) return
        val wv = player ?: createPlayer().also {
            player = it
            playerBox.addView(it, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        applyUserAgent(wv)
        wv.loadUrl(url)
        watching = true
        panelOpen = true
        playerBox.visibility = View.VISIBLE
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
        val immersive = watching && (landscape || fullscreen || !panelOpen)

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

        val mode: String
        if (!watching) {
            mode = "full"
            place(ui, left, top, aw, ah)
        } else if (!panelOpen || fullscreen) {
            mode = "float"
            // Oynatıcı tüm ekran (sistem çubukları gizli olduğu için kenarlara kadar)
            place(playerBox, 0, 0, w, h)
            val fw = dp(if (floatW > 0) floatW else 120)
            val fh = dp(if (floatH > 0) floatH else 72)
            place(ui, right - fw, top, fw, fh)
        } else if (landscape) {
            mode = "side"
            val panel = min(dp(380), (aw * 0.42f).roundToInt())
            place(playerBox, left, top, aw - panel, ah)
            place(ui, left + aw - panel, top, panel, ah)
        } else {
            mode = "bottom"
            // Video 16:9, panel en az ekranın %45'i
            var ph = (aw * 9f / 16f).roundToInt()
            ph = min(ph, (ah * 0.55f).roundToInt())
            // Klavye açıkken videoyu küçült ama yok etme
            ph = max(min(ph, ah - dp(220)), dp(120))
            place(playerBox, left, top, aw, ph)
            place(ui, left, top + ph, aw, ah - ph)
        }
        ui.bringToFront()
        popup?.bringToFront()
        if (mode != lastLayoutMode) {
            lastLayoutMode = mode
            js("window.OI && OI.setLayout(${JSONObject().put("mode", mode).put("fullscreen", fullscreen)})")
        }
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
