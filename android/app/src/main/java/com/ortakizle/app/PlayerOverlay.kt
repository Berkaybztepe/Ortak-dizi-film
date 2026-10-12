package com.ortakizle.app

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.SurfaceTexture
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.media.MediaPlayer
import android.view.Surface
import android.view.TextureView
import android.view.ViewOutlineProvider
import android.widget.ImageView
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.sign
import kotlin.math.roundToInt
import kotlin.random.Random

private val INK = Color.parseColor("#0B0B0C")
private val CORAL = Color.parseColor("#FF6B3D")
private val PAPER = Color.parseColor("#F7F3EE")

// Oynatıcının üstündeki yerel katman. Dizi sitesinin sayfasına bağlı değildir: site tam ekrana
// geçse, kendi katmanlarını en üste koysa da görünür. Dokunuşları yalnızca geri düğmesi, akan
// mesajlar ve uyarı alır; gerisi alttaki oynatıcıya geçer.
//   - sol üstte ayrı bir "geri" düğmesi
//   - tepkiler (emoji) sağ altta yükselir
//   - sohbet mesajları sol altta akar (kaydırınca kapanır, dokununca sohbet açılır)
//   - büyük uyarılar ("Kardeş bölümden çıktı, video durdu")
//   - 3-2-1 geri sayımı ve "X yükleniyor, bekleniyor…" notu
@SuppressLint("ViewConstructor")
class PlayerOverlay(context: Context, private val onBack: () -> Unit, private val onChat: () -> Unit) : FrameLayout(context) {
    private val density = resources.displayMetrics.density
    private fun dp(v: Float) = (v * density).roundToInt()
    private val main = Handler(Looper.getMainLooper())

    private val back = BackButton(context).apply {
        contentDescription = "Geri"
        setOnClickListener { onBack() }
    }
    private val reacts = FrameLayout(context)
    private val ticker = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.BOTTOM or Gravity.START
    }
    private val notice = pill(15f).apply {
        visibility = View.GONE
        swipeAway(this, null) { visibility = View.GONE }
    }
    private val note = pill(14f).apply { visibility = View.GONE }
    private val count = TextView(context).apply {
        setTextColor(PAPER)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 84f)
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        gravity = Gravity.CENTER
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.argb(170, 11, 11, 12))
            setStroke(dp(3f), CORAL)
        }
        visibility = View.GONE
    }
    private var countTarget = 0L
    private var countShown = -1
    private var noticeHide: Runnable? = null

    init {
        isClickable = false
        isFocusable = false
        addView(reacts, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        addView(ticker, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
            leftMargin = dp(14f)
            bottomMargin = dp(84f) // oynatıcının alt düğmelerinin üstünde
        })
        addView(notice, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
            topMargin = dp(64f)
            leftMargin = dp(16f)
            rightMargin = dp(16f)
        })
        addView(note, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply {
            leftMargin = dp(16f)
            rightMargin = dp(16f)
        })
        addView(count, LayoutParams(dp(150f), dp(150f), Gravity.CENTER))
        addView(back, LayoutParams(dp(46f), dp(46f), Gravity.TOP or Gravity.START).apply {
            leftMargin = dp(12f)
            topMargin = dp(12f)
        })
    }

    // Uzun metinli, koyu zeminli, turuncu kenarlı hap
    private fun pill(sp: Float) = TextView(context).apply {
        setTextColor(PAPER)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        gravity = Gravity.CENTER
        setPadding(dp(18f), dp(11f), dp(18f), dp(11f))
        background = GradientDrawable().apply {
            cornerRadius = dp(999f).toFloat()
            setColor(Color.argb(235, 11, 11, 12))
            setStroke(dp(2f), CORAL)
        }
        elevation = dp(6f).toFloat()
    }

    // Parmakla yana kaydırılınca kaybolur; kaydırmadan dokunulursa onTap
    @SuppressLint("ClickableViewAccessibility")
    private fun swipeAway(v: View, onTap: (() -> Unit)?, onGone: () -> Unit) {
        var x0 = 0f
        var y0 = 0f
        var moved = false
        v.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    if (BuildConfig.DEBUG) Log.i("OrtakIzle", "Kaydırma başladı: ${e.rawX.roundToInt()} ${e.rawY.roundToInt()}")
                    x0 = e.rawX
                    y0 = e.rawY
                    moved = false
                    v.animate().cancel()
                    v.alpha = 1f
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - x0
                    if (abs(dx) > dp(8f) || abs(e.rawY - y0) > dp(8f)) moved = true
                    v.translationX = dx
                    v.alpha = (1f - abs(dx) / max(v.width, 1)).coerceIn(0.2f, 1f)
                }
                MotionEvent.ACTION_UP -> {
                    val dx = e.rawX - x0
                    if (BuildConfig.DEBUG) Log.i("OrtakIzle", "Kaydırma: dx=${dx.roundToInt()} w=${v.width} moved=$moved")
                    if (abs(dx) > max(dp(56f), v.width / 4)) {
                        v.animate().translationX(sign(dx) * v.width * 1.2f).alpha(0f).setDuration(180)
                            .withEndAction {
                                v.translationX = 0f
                                v.alpha = 1f
                                onGone()
                            }.start()
                    } else {
                        v.animate().translationX(0f).alpha(1f).setDuration(180).start()
                        if (!moved) {
                            v.performClick()
                            onTap?.invoke()
                        }
                    }
                }
                MotionEvent.ACTION_CANCEL -> v.animate().translationX(0f).alpha(1f).setDuration(180).start()
            }
            true
        }
    }

    /** Geri düğmesinin ekrandaki orta noktası (test sürümü günlüğe yazar); görünmüyorsa null */
    fun backCenter(): IntArray? {
        if (back.visibility != View.VISIBLE || back.width == 0) return null
        val loc = IntArray(2)
        back.getLocationOnScreen(loc)
        return intArrayOf(loc[0] + back.width / 2, loc[1] + back.height / 2)
    }

    fun setBackVisible(show: Boolean) {
        back.visibility = if (show) View.VISIBLE else View.GONE
    }

    private var insetL = 0
    private var insetT = 0
    private var spotX: Float? = null
    private var spotY: Float? = null

    /** Geri düğmesinin yeri: sistem çubukları/çentik kadar içeride */
    fun setInsets(left: Int, top: Int) {
        insetL = left
        insetT = top
        placeBack()
    }

    /** Sitenin düğmelerine değmeyen yer (oynatıcının oranı, düğmenin ortası); null: sol üst */
    fun setBackSpot(fx: Float?, fy: Float?) {
        spotX = fx?.takeIf { it in 0f..1f }
        spotY = fy?.takeIf { it in 0f..1f }
        placeBack()
    }

    private fun placeBack() {
        val size = dp(46f)
        val minL = dp(12f) + insetL
        val minT = dp(12f) + insetT
        val fx = spotX
        val fy = spotY
        val l = if (fx != null && width > 0) maxOf(minL, (fx * width).roundToInt() - size / 2) else minL
        val t = if (fy != null && height > 0) maxOf(minT, (fy * height).roundToInt() - size / 2) else minT
        val lp = back.layoutParams as LayoutParams
        if (lp.leftMargin == l && lp.topMargin == t) return
        lp.leftMargin = l
        lp.topMargin = t
        back.layoutParams = lp
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (spotX != null || spotY != null) post { placeBack() }
    }

    fun react(emoji: String, name: String?) {
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        box.addView(TextView(context).apply {
            text = emoji
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 40f)
            setShadowLayer(dp(6f).toFloat(), 0f, dp(2f).toFloat(), Color.argb(120, 0, 0, 0))
        })
        if (!name.isNullOrBlank()) {
            box.addView(TextView(context).apply {
                text = name
                setTextColor(PAPER)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setPadding(dp(7f), dp(2f), dp(7f), dp(3f))
                background = GradientDrawable().apply {
                    cornerRadius = dp(99f).toFloat()
                    setColor(Color.argb(210, 11, 11, 12))
                }
            })
        }
        val lp = LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            rightMargin = (width * 0.06f).roundToInt() + Random.nextInt(0, dp(60f))
            bottomMargin = (height * 0.16f).roundToInt()
        }
        reacts.addView(box, lp)
        val rise = -(height * 0.5f).coerceAtLeast(dp(160f).toFloat())
        box.alpha = 0f
        box.scaleX = 0.6f
        box.scaleY = 0.6f
        val dx = Random.nextInt(-dp(30f), dp(30f)).toFloat()
        AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(box, View.TRANSLATION_Y, 0f, rise),
                ObjectAnimator.ofFloat(box, View.TRANSLATION_X, 0f, dx),
                ObjectAnimator.ofFloat(box, View.SCALE_X, 0.6f, 1f, 1f),
                ObjectAnimator.ofFloat(box, View.SCALE_Y, 0.6f, 1f, 1f),
                ObjectAnimator.ofFloat(box, View.ALPHA, 0f, 1f, 1f, 1f, 0f),
            )
            duration = 3200
            interpolator = DecelerateInterpolator(1.4f)
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    reacts.removeView(box)
                }
            })
            start()
        }
    }

    // Sohbet mesajı alttan akar, birkaç saniye sonra kaybolur
    fun message(name: String, text: String) {
        while (ticker.childCount >= 3) ticker.removeViewAt(0)
        val s = SpannableStringBuilder()
        s.append(name)
        s.setSpan(StyleSpan(Typeface.BOLD), 0, name.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        s.setSpan(ForegroundColorSpan(CORAL), 0, name.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        s.append("  ").append(text)
        val tv = TextView(context).apply {
            this.text = s
            setTextColor(PAPER)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            maxLines = 3
            ellipsize = TextUtils.TruncateAt.END
            maxWidth = (this@PlayerOverlay.width * 0.62f).roundToInt().coerceAtLeast(dp(200f))
            setPadding(dp(12f), dp(8f), dp(14f), dp(9f))
            background = GradientDrawable().apply {
                cornerRadius = dp(14f).toFloat()
                setColor(Color.argb(215, 11, 11, 12))
            }
        }
        swipeAway(tv, onChat) {
            ticker.removeView(tv)
            if (BuildConfig.DEBUG) Log.i("OrtakIzle", "Mesaj kaydırılıp kapatıldı")
        }
        ticker.addView(tv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(6f)
        })
        if (BuildConfig.DEBUG) tv.postDelayed({
            val loc = IntArray(2)
            tv.getLocationOnScreen(loc)
            Log.i("OrtakIzle", "Mesaj yeri: ${loc[0] + tv.width / 2} ${loc[1] + tv.height / 2}")
        }, 600)
        tv.alpha = 0f
        tv.translationX = -dp(40f).toFloat()
        tv.animate().alpha(1f).translationX(0f).setDuration(260).setInterpolator(DecelerateInterpolator()).start()
        main.postDelayed({
            tv.animate().alpha(0f).translationX(-dp(30f).toFloat()).setDuration(400).withEndAction { ticker.removeView(tv) }.start()
        }, (10000L + text.length * 50L).coerceAtMost(16000L)) // okuyup dokunmaya/kaydırmaya vakit kalsın
    }

    fun notice(text: String, ms: Long) {
        noticeHide?.let { main.removeCallbacks(it) }
        notice.text = text
        notice.translationX = 0f
        if (notice.visibility != View.VISIBLE) {
            notice.visibility = View.VISIBLE
            notice.alpha = 0f
            notice.translationY = -dp(16f).toFloat()
        }
        notice.animate().alpha(1f).translationY(0f).setDuration(220).start()
        val hide = Runnable {
            notice.animate().alpha(0f).setDuration(300).withEndAction { notice.visibility = View.GONE }.start()
        }
        noticeHide = hide
        main.postDelayed(hide, ms.coerceIn(1500L, 15000L))
    }

    fun note(text: String?) {
        if (text.isNullOrBlank()) {
            note.visibility = View.GONE
            return
        }
        note.text = text
        note.visibility = View.VISIBLE
    }

    // Geri sayım: hedef ana kadar kalan saniye (3, 2, 1)
    fun countdown(ms: Long) {
        countTarget = SystemClock.elapsedRealtime() + ms
        countShown = -1
        main.removeCallbacks(countTick)
        if (ms <= 0) {
            count.visibility = View.GONE
            return
        }
        countTick.run()
    }

    private val countTick = object : Runnable {
        override fun run() {
            val left = countTarget - SystemClock.elapsedRealtime()
            if (left <= 0) {
                count.animate().alpha(0f).setDuration(200).withEndAction { count.visibility = View.GONE }.start()
                return
            }
            val n = ceil(left / 1000.0).toInt()
            if (n != countShown) {
                countShown = n
                count.text = n.toString()
                count.visibility = View.VISIBLE
                count.alpha = 1f
                count.scaleX = 0.7f
                count.scaleY = 0.7f
                count.animate().scaleX(1f).scaleY(1f).setDuration(350).setInterpolator(OvershootInterpolator()).start()
            }
            main.postDelayed(this, 50)
        }
    }

    // ------------------------------------------------------------------ kedi tepkisi
    // Uygulamanın içindeki kısa kedi videosu (ya da resmi) sol üst köşeden (geri düğmesinin
    // altından) kayarak girer, küçük yuvarlak bir kartta sesli oynar, bitince kayarak çıkar.
    // Ekranın ortasını ve alttaki altyazıyı kapatmaz. Dokununca ya da kaydırınca kapanır.
    private var memeCard: View? = null
    private var memePlayer: MediaPlayer? = null
    private var memeEnd: Runnable? = null

    fun meme(id: String, img: Boolean, name: String) {
        if (!Regex("[a-z]{2,24}").matches(id)) return
        stopMeme()
        val maxW = (width * 0.26f).roundToInt().coerceIn(dp(130f), dp(220f))
        val maxH = (height * 0.34f).roundToInt().coerceIn(dp(110f), dp(250f))
        val card = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.START
        }
        val frame = FrameLayout(context).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(18f).toFloat()
                setColor(INK)
                setStroke(dp(2f), CORAL)
            }
            outlineProvider = ViewOutlineProvider.BACKGROUND
            clipToOutline = true
            elevation = dp(10f).toFloat()
        }
        // Videonun/resmin oranına göre kartın boyu (genişlik sabit, en fazla ekranın yarısı)
        fun fit(vw: Int, vh: Int) {
            if (vw <= 0 || vh <= 0) return
            var w = maxW
            var h = (w.toFloat() * vh / vw).roundToInt()
            if (h > maxH) {
                h = maxH
                w = (h.toFloat() * vw / vh).roundToInt()
            }
            frame.layoutParams = (frame.layoutParams as LinearLayout.LayoutParams).apply {
                width = w
                height = h
            }
        }
        card.addView(frame, LinearLayout.LayoutParams(maxW, (maxW * 9f / 16f).roundToInt()))
        if (img) {
            val bmp = try {
                context.assets.open("web/memes/$id.jpg").use { BitmapFactory.decodeStream(it) }
            } catch (_: Exception) {
                null
            } ?: return
            frame.addView(ImageView(context).apply {
                setImageBitmap(bmp)
                scaleType = ImageView.ScaleType.CENTER_CROP
            }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            fit(bmp.width, bmp.height)
        } else {
            val afd = try {
                context.assets.openFd("web/memes/$id.mp4")
            } catch (_: Exception) {
                return
            }
            val tv = TextureView(context)
            tv.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
                    if (memeCard !== card) return
                    val mp = MediaPlayer()
                    memePlayer = mp
                    try {
                        mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                        afd.close()
                        mp.setSurface(Surface(st))
                        mp.setVolume(0.9f, 0.9f)
                        mp.setOnVideoSizeChangedListener { _, vw, vh -> fit(vw, vh) }
                        mp.setOnPreparedListener { it.start() }
                        mp.setOnCompletionListener { dismissMeme(card) }
                        mp.setOnErrorListener { _, _, _ ->
                            dismissMeme(card)
                            true
                        }
                        mp.prepareAsync()
                    } catch (_: Exception) {
                        dismissMeme(card)
                    }
                }

                override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
                override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean = true
                override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
            }
            frame.addView(tv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        if (name.isNotBlank()) {
            card.addView(TextView(context).apply {
                text = name
                setTextColor(PAPER)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setPadding(dp(9f), dp(3f), dp(9f), dp(4f))
                background = GradientDrawable().apply {
                    cornerRadius = dp(99f).toFloat()
                    setColor(Color.argb(220, 11, 11, 12))
                }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
        }
        memeCard = card
        swipeAway(card, { dismissMeme(card) }) { dismissMeme(card) }
        addView(card, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
            leftMargin = dp(14f) + insetL
            topMargin = dp(72f) + insetT // geri düğmesinin altında
        })
        if (BuildConfig.DEBUG) Log.i("OrtakIzle", "Kedi: $id")
        // Soldan kayarak girer
        card.alpha = 0f
        card.translationX = -(maxW + dp(30f)).toFloat()
        card.animate().alpha(1f).translationX(0f).setDuration(380).setInterpolator(OvershootInterpolator(1.1f)).start()
        // Resim 3,5 sn; video bitince (en geç 20 sn)
        val end = Runnable { dismissMeme(card) }
        memeEnd = end
        main.postDelayed(end, if (img) 4000L else 20000L)
    }

    private fun dismissMeme(card: View) {
        if (memeCard !== card) return
        memeCard = null
        memeEnd?.let { main.removeCallbacks(it) }
        memePlayer?.let {
            try {
                it.stop()
            } catch (_: Exception) {
            }
            it.release()
        }
        memePlayer = null
        // Sola kayarak çıkar
        card.animate().alpha(0f).translationX(-(card.width + dp(30f)).toFloat()).setDuration(300).withEndAction { removeView(card) }.start()
    }

    private fun stopMeme() {
        memeCard?.let { c ->
            memeCard = null
            removeView(c)
        }
        memeEnd?.let { main.removeCallbacks(it) }
        memePlayer?.let {
            try {
                it.stop()
            } catch (_: Exception) {
            }
            it.release()
        }
        memePlayer = null
    }

    fun clear() {
        stopMeme()
        main.removeCallbacksAndMessages(null)
        reacts.removeAllViews()
        ticker.removeAllViews()
        notice.visibility = View.GONE
        note.visibility = View.GONE
        count.visibility = View.GONE
    }

    // Yuvarlak, koyu zeminli, turuncu oklu geri düğmesi
    private class BackButton(context: Context) : View(context) {
        private val d = context.resources.displayMetrics.density
        private val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(200, 11, 11, 12) }
        private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 1.5f * d
            color = Color.argb(90, 255, 255, 255)
        }
        private val arrow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 2.6f * d
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
            color = PAPER
        }
        private val path = Path()

        init {
            isClickable = true
            isFocusable = true
            elevation = 6f * d
        }

        override fun onDraw(canvas: Canvas) {
            val w = width.toFloat()
            val h = height.toFloat()
            val r = minOf(w, h) / 2f
            canvas.drawCircle(w / 2, h / 2, r - ring.strokeWidth, bg)
            canvas.drawCircle(w / 2, h / 2, r - ring.strokeWidth, ring)
            val s = r * 0.42f
            path.reset()
            path.moveTo(w / 2 + s * 0.15f, h / 2 - s)
            path.lineTo(w / 2 - s * 0.75f, h / 2)
            path.lineTo(w / 2 + s * 0.15f, h / 2 + s)
            path.moveTo(w / 2 - s * 0.7f, h / 2)
            path.lineTo(w / 2 + s * 1.05f, h / 2)
            canvas.drawPath(path, arrow)
        }

        override fun setPressed(pressed: Boolean) {
            super.setPressed(pressed)
            bg.color = if (pressed) CORAL else Color.argb(200, 11, 11, 12)
            arrow.color = if (pressed) INK else PAPER
            invalidate()
        }
    }
}
