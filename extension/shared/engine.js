// Ortak İzle — senkron motoru. Dizi/film sitesinin sayfasında çalışır
// (Android uygulamasındaki oynatıcı ve tarayıcı eklentisi ortak kullanır).
//
// - Sayfadaki asıl <video>'yu bulur (gölge DOM'lar dahil; fragman/önizlemeleri eler)
// - Oynat / durdur / sar hareketlerini odaya bildirir, gelenleri uygular
// - Biri yüklenirken (buffer) diğerlerini bekletir, 3-2-1 geri sayımı yürütür
// - Videonun üstünde tepkileri ve geri sayımı gösteren dokunulmaz bir katman çizer
//
// Taşıma katmanı dışarıdan verilir: create({ post(msg) }) ve engine.receive(msg).

(function () {
  'use strict';
  if (globalThis.OrtakIzleEngine) return;

  const HOST = location.hostname;
  const PLATFORMS = [
    [/disneyplus\.com$/, 'Disney+'],
    [/(^|\.)(hbo)?max\.com$/, 'HBO Max'],
    [/^tv\.apple\.com$/, 'Apple TV+'],
    [/netflix\.com$/, 'Netflix'],
    [/primevideo\.com$|(^|\.)amazon\./, 'Prime Video'],
    [/youtube\.com$/, 'YouTube'],
  ];
  const KNOWN = PLATFORMS.find(([r]) => r.test(HOST));
  const PLATFORM = (KNOWN || [null, HOST.replace(/^www\./, '')])[1];

  // Oynatıcı (izleme) sayfası adresleri
  const WATCH_PATTERNS = [
    /disneyplus\.com\/.*(play|video)\//,
    /(hbo)?max\.com\/.*(video\/watch|player)/,
    /tv\.apple\.com\/.*(episode|movie|show)/,
    /netflix\.com\/watch\//,
    /(primevideo|amazon)\.[^/]+\/.*(detail|watch|gp\/video)/,
    /youtube\.com\/watch/,
  ];
  const isWatchUrl = (u) => WATCH_PATTERNS.some((r) => r.test(u || ''));

  function sameContent(a, b) {
    if (!a || !b) return false;
    try {
      const x = new URL(a);
      const y = new URL(b);
      if (x.hostname.replace(/^www\./, '') !== y.hostname.replace(/^www\./, '')) return false;
      if (/youtube/.test(x.hostname)) return x.searchParams.get('v') === y.searchParams.get('v');
      // Dil öneki farklı olabilir (/tr-tr/play/abc ile /play/abc)
      const norm = (p) => p.replace(/\/$/, '').replace(/^\/[a-z]{2}(-[a-z]{2})?(?=\/)/i, '');
      return norm(x.pathname) === norm(y.pathname);
    } catch {
      return false;
    }
  }

  function cleanTitle() {
    const og = document.querySelector('meta[property="og:title"]')?.content;
    const t = (document.title || og || '').trim();
    return t
      .replace(/^(Watch|İzle|Izle)\s+/i, '')
      .replace(/\s*[|•·\-–—]\s*(Disney\+|HBO Max|Max|Apple TV\+?|Netflix|Prime Video|Amazon.*|YouTube)\s*$/i, '')
      .replace(/^(Disney\+|HBO Max|Max|Apple TV\+?|Netflix|Prime Video|YouTube)$/i, '')
      .trim()
      .slice(0, 200);
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  // ------------------------------------------------------------------ video bulma
  function* allVideos(rootNode) {
    const stack = [rootNode];
    while (stack.length) {
      const node = stack.pop();
      if (!node || !node.querySelectorAll) continue;
      for (const v of node.querySelectorAll('video')) yield v;
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }

  function pickVideo() {
    const vpArea = Math.max(1, innerWidth * innerHeight);
    const watchPage = isWatchUrl(location.href);
    let best = null;
    let bestScore = 0;
    for (const v of allVideos(document)) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < vpArea * 0.2) continue; // küçük önizleme kutuları
      const dur = v.duration;
      // Fragman/önizleme eleme: izleme sayfası değilse en az 10 dk'lık video şart
      if (!watchPage && !(Number.isFinite(dur) && dur >= 600)) continue;
      let score = area;
      if (Number.isFinite(dur) && dur < 45) score *= 0.05; // reklam/jenerik parçası
      if (v.readyState === 0 && !v.currentSrc) score *= 0.05;
      if (!v.paused) score *= 2;
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ içerik saati
  // Bazı platformlarda (ör. Disney+) <video>'nun zamanı bölümün gerçek dakikası değildir: oynatıcı
  // videoyu kendi iç zaman çizelgesiyle oynatır ve bu sayı her cihazda farklı başlar. Gerçek dakikayı
  // oynatıcının kendi ilerleme çubuğundan / zaman yazısından okuruz.
  function* deepElements(rootNode, selector) {
    const stack = [rootNode];
    while (stack.length) {
      const node = stack.pop();
      if (!node || !node.querySelectorAll) continue;
      for (const el of node.querySelectorAll(selector)) yield el;
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }

  // "1:02:03", "45:00", "-9:25" → saniye
  function parseClock(text) {
    const m = String(text || '').trim().match(/^(-)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const [h, mi, se] = m[4] != null ? [+m[2], +m[3], +m[4]] : [0, +m[2], +m[3]];
    if (mi > 59 || se > 59) return null;
    return { sec: h * 3600 + mi * 60 + se, neg: !!m[1] };
  }
  function clocksIn(text) {
    return (String(text || '').match(/-?\d{1,2}:\d{2}(?::\d{2})?/g) || []).map(parseClock).filter(Boolean);
  }

  const MAX_LEN = 6 * 3600;

  // Oynatıcı arayüzünden {now, max} (sn) okumaya çalışır; bulamazsa null
  function readUiClock(video) {
    let pct = null;
    let pctEl = null;
    for (const el of deepElements(document, '[role="slider"],[role="progressbar"],input[type="range"],progress,[aria-valuenow]')) {
      if (el.closest && el.closest('[data-ortak-izle]')) continue;
      const vt = el.getAttribute('aria-valuetext') || '';
      const ts = clocksIn(vt);
      if (ts.length >= 2 && ts[1].sec > ts[0].sec && ts[1].sec <= MAX_LEN) return { now: ts[0].sec, max: ts[1].sec, how: 'valuetext' };
      const max = parseFloat(el.getAttribute('aria-valuemax') ?? el.max);
      const now = parseFloat(el.getAttribute('aria-valuenow') ?? el.value);
      if (!Number.isFinite(max) || !Number.isFinite(now) || now < 0 || now > max) continue;
      const min = parseFloat(el.getAttribute('aria-valuemin') ?? el.min) || 0;
      if (max >= 120 && max <= MAX_LEN && max !== 100 && max !== 1000 && min === 0) return { now, max, how: 'slider' };
      if ((max === 100 || max === 1) && pct === null) {
        pct = now / max;
        pctEl = el;
      }
    }
    if (pct === null) return null;
    // Yüzdelik çubuk + zaman yazıları: "geçen / toplam" ya da "kalan"
    const labels = [];
    for (const el of deepElements(document, 'span,div,time,p,label')) {
      if (el.children.length) continue;
      const c = parseClock(el.textContent);
      if (c) labels.push({ c, el });
      if (labels.length > 12) break;
    }
    const near = (a, b) => Math.abs(a - b) < 0.03;
    for (const a of labels) {
      for (const b of labels) {
        if (a === b || a.c.neg || b.c.neg || b.c.sec <= a.c.sec) continue;
        if (near(a.c.sec / b.c.sec, pct)) return { now: a.c.sec, max: b.c.sec, how: 'labels' };
      }
    }
    if (labels.length === 1 && pct > 0.01 && pct < 0.99) {
      const { c, el } = labels[0];
      // Çubuğun sağındaki tek yazı genelde "kalan süre"dir
      let remaining = c.neg;
      try {
        const lr = el.getBoundingClientRect();
        const br = pctEl.getBoundingClientRect();
        if (lr.left > br.left + br.width / 2) remaining = true;
      } catch {}
      const max = remaining ? c.sec / (1 - pct) : c.sec / pct;
      if (max > 60 && max <= MAX_LEN) return { now: remaining ? max - c.sec : c.sec, max, how: remaining ? 'remaining' : 'elapsed' };
    }
    return null;
  }

  // ------------------------------------------------------------------ sahne katmanı
  // Videonun üstünde: tepkiler, geri sayım, "bekleniyor" notu, "başlat" düğmesi.
  function createStage(fontFamily) {
    const host = document.createElement('div');
    host.setAttribute('data-ortak-izle', 'stage');
    host.style.cssText = 'all:initial;position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483646;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    const display = `${fontFamily ? `'${fontFamily}',` : ''}system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`;
    root.innerHTML = `
      <style>
        :host { --paper:#ffffff; --ink:#160803; --brass:#ff6b3d; }
        .center { position:absolute; top:0; right:0; bottom:0; left:0; display:grid; place-items:center; }
        .count { font:800 clamp(120px, 28vmin, 260px)/1 ${display}; color:var(--paper);
          text-shadow:0 4px 24px rgba(0,0,0,.7); font-variant-numeric:tabular-nums; letter-spacing:.02em;
          width:1.6em; height:1.6em; display:grid; place-items:center; border-radius:50%;
          background:radial-gradient(circle, rgba(11,11,12,.62) 0 58%, rgba(11,11,12,0) 71%); }
        .count.pop { animation:pop .9s ease-out both; }
        .note { font:600 15px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--paper);
          background:rgba(11,11,12,.88); border:2px solid #ff6b3d; padding:10px 16px; border-radius:999px;
          display:flex; align-items:center; gap:10px; box-shadow:0 8px 30px rgba(0,0,0,.4); }
        .spin { width:14px; height:14px; border-radius:50%; border:2px solid rgba(243,231,218,.25);
          border-top-color:var(--brass); animation:spin 1s linear infinite; }
        .tap { pointer-events:auto; cursor:pointer; font:700 17px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
          color:var(--ink); background:var(--brass); border:0; padding:16px 26px; border-radius:999px;
          box-shadow:0 10px 40px rgba(0,0,0,.5); }
        .reacts { position:absolute; right:7%; bottom:16%; width:120px; height:60vh; }
        .r { position:absolute; bottom:0; display:flex; flex-direction:column; align-items:center; gap:2px;
          animation:rise 3.2s cubic-bezier(.2,.7,.3,1) forwards; }
        .r .e { font-size:44px; line-height:1; filter:drop-shadow(0 4px 10px rgba(0,0,0,.45)); }
        .r .n { font:600 11px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--paper);
          background:rgba(11,11,12,.8); padding:3px 7px; border-radius:999px; }
        [hidden] { display:none !important; }
        @keyframes pop { 0% { transform:scale(.7); opacity:0 } 20% { transform:scale(1); opacity:1 } 100% { opacity:.7; transform:scale(1.03) } }
        @keyframes spin { to { transform:rotate(360deg) } }
        @keyframes rise { 0% { transform:translateY(0) scale(.6); opacity:0 } 12% { opacity:1; transform:translateY(-20px) scale(1) }
          100% { transform:translateY(-55vh) translateX(var(--dx, 0px)); opacity:0 } }
        @media (prefers-reduced-motion: reduce) { .r, .count.pop { animation-duration:.01s } .spin { animation:none } }
      </style>
      <div class="center"><div class="count" hidden></div></div>
      <div class="center"><div class="note" hidden><span class="spin"></span><span class="txt"></span></div></div>
      <div class="center"><button class="tap" hidden>Oynatmak için dokun</button></div>
      <div class="reacts"></div>`;
    const q = (s) => root.querySelector(s);
    const els = { count: q('.count'), note: q('.note'), noteTxt: q('.txt'), tap: q('.tap'), reacts: q('.reacts') };

    function mount() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
      if (parent && host.parentNode !== parent) parent.appendChild(host);
    }
    document.addEventListener('fullscreenchange', mount);
    document.addEventListener('webkitfullscreenchange', mount);
    mount();
    setInterval(mount, 2000); // SPA'lar <html> içeriğini değiştirebiliyor

    let tapAction = null;
    els.tap.addEventListener('click', () => {
      els.tap.hidden = true;
      const a = tapAction;
      tapAction = null;
      if (a) a();
    });

    return {
      host,
      mount,
      count(n) {
        if (n == null) {
          els.count.hidden = true;
          return;
        }
        els.count.hidden = false;
        if (els.count.textContent !== String(n)) {
          els.count.textContent = String(n);
          els.count.classList.remove('pop');
          void els.count.offsetWidth;
          els.count.classList.add('pop');
        }
      },
      note(text) {
        els.note.hidden = !text;
        if (text) els.noteTxt.textContent = text;
      },
      tap(text, action) {
        tapAction = action;
        els.tap.textContent = text;
        els.tap.hidden = false;
      },
      clearTap() {
        tapAction = null;
        els.tap.hidden = true;
      },
      react(emoji, name) {
        const r = document.createElement('div');
        r.className = 'r';
        r.style.left = `${10 + Math.random() * 50}px`;
        r.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 60)}px`);
        const e = document.createElement('span');
        e.className = 'e';
        e.textContent = emoji;
        r.appendChild(e);
        if (name) {
          const n = document.createElement('span');
          n.className = 'n';
          n.textContent = name;
          r.appendChild(n);
        }
        els.reacts.appendChild(r);
        setTimeout(() => r.remove(), 3400);
      },
    };
  }

  // ------------------------------------------------------------------ motor
  function create(opts) {
    const post = (m) => {
      try {
        opts.post(m);
      } catch {}
    };
    const notify = opts.onNotice || (() => {});

    let wsState = 'kapalı';
    let me = null;
    let members = [];
    let roomState = null;
    let clockOffset = 0;
    let video = null;
    let suppressUntil = 0; // uzaktan bir şey uyguladıktan hemen sonra konum bildirimi gönderme
    // Kendi yaptığımız (programatik) hareketlerin yankısını tanımak için beklenen olaylar.
    // Yalnızca bunlar yok sayılır; kullanıcının aynı anda yaptığı hareket her zaman geçer.
    const expect = { seek: null, paused: null, until: 0 };
    let pending = null;
    let lastUrl = '';
    let navTimer = null;
    let holding = false; // başkası yüklenirken beklemedeyiz
    let bufferTimer = null;
    let bufferingSent = false;
    let countdown = null; // {at, time, timer}
    let lastEngineStatus = '';
    let lastLocal = 0; // en son kendi hareketimizi gönderdiğimiz an
    let lastRemote = 0; // en son başkasının hareketini aldığımız an
    // Uzaktan gelen bir durumu uyguladıktan sonra oynatıcı onu geri alırsa (ör. Disney+ kendiliğinden
    // yeniden oynatırsa) bunu kullanıcı hareketi sanıp odaya yaymamak için kısa bir koruma süresi
    let applied = null; // {paused, until, tries}
    let verifyTimer = null;
    let holdSince = 0;
    let holdExpired = false;
    // İçerik saati: içerik dakikası = video.currentTime + uiOffset
    let uiOffset = null;
    let uiDuration = 0;
    let lastUi = null; // {now, at}
    let lastPlayhead = 0; // sarmadan önceki konum (sarma miktarını bulmak için)
    let seekFrom = null;
    let relWarned = false;
    let lastSeekAt = 0;
    let lastChangeAt = 0; // son durum değişikliği: hemen sonrasında durum daha sık bildirilir
    let lastTickAt = 0;
    let lastTickPaused = null;
    let offsetCandidate = null; // yeni ofset iki ardışık okumada doğrulanınca kabul edilir

    const stage = createStage(opts.displayFont);
    const serverNow = () => Date.now() + clockOffset;
    const expectedTime = (st) => (st.paused ? st.time : st.time + Math.max(0, serverNow() - st.at) / 1000);
    const connected = () => wsState === 'bağlı' && !!me;
    const nameOf = (id) => members.find((m) => m.id === id)?.name || 'Diğeri';

    function timelineOk() {
      const d = video && video.duration;
      return Number.isFinite(d) && d > 1 && d < MAX_LEN;
    }
    // Bölümün gerçek dakikası (sn); bilinmiyorsa null
    function contentTime() {
      if (!video) return null;
      if (uiOffset !== null) return Math.max(0, video.currentTime + uiOffset);
      return timelineOk() ? video.currentTime : null;
    }
    function contentDuration() {
      return uiDuration || (timelineOk() ? video.duration : 0);
    }
    const exact = () => contentTime() !== null;
    const toVideoTime = (t) => (uiOffset !== null ? t - uiOffset : t);
    // Oynatıcı arayüzünden içerik saatini ayarla (arayüz gerçekten güncelleniyorsa)
    function calibrate() {
      if (!video) return;
      // Sarma sırasında çubuk henüz güncellenmemiş olabilir: oturana kadar bekle
      if (video.seeking || Date.now() - lastSeekAt < 1500) return;
      let ui = null;
      try {
        ui = readUiClock(video);
      } catch {}
      if (!ui) return;
      const now = Date.now();
      // Kontroller gizliyken değer donabilir: oynarken değişmiyorsa güvenme
      if (!video.paused && lastUi && lastUi.now === ui.now && now - lastUi.at > 2500) return;
      if (!lastUi || lastUi.now !== ui.now) lastUi = { now: ui.now, at: now };
      uiDuration = ui.max;
      const off = ui.now - video.currentTime;
      if (uiOffset === null) {
        uiOffset = off;
      } else if (Math.abs(off - uiOffset) > 1.5) {
        // Büyük değişim: iki ardışık okumada aynıysa kabul et (tek seferlik okuma hatasına kanma)
        if (offsetCandidate !== null && Math.abs(off - offsetCandidate) < 1.5) {
          uiOffset = off;
          offsetCandidate = null;
        } else offsetCandidate = off;
      } else {
        // Çubuk saniyeyi aşağı yuvarlar: (gösterilen − video zamanı) gerçek ofsetin en fazla 1 sn altındadır.
        // Okumaların en büyüğü gerçek ofsete yaklaşır.
        offsetCandidate = null;
        uiOffset = Math.max(uiOffset, off);
      }
    }

    // Bu adres bizim açtığımızla aynı içerik sayılır mı? Aynı platformda ikimiz de izleme
    // sayfasındaysak evet: aynı bölüm farklı adreslerle açılabiliyor (yönlendirme, dil öneki…)
    function relatedContent(url) {
      if (!url) return true;
      if (sameContent(url, location.href) || !isWatchUrl(url)) return true;
      try {
        const host = (u) => new URL(u).hostname.replace(/^www\./, '');
        return host(url) === host(location.href) && watchingNow();
      } catch {
        return false;
      }
    }

    // Uzaktan gelen hareket bu sayfaya uygulanmalı mı?
    function applyable(url) {
      return !!video && relatedContent(url);
    }

    // ---------------------------------------------------------------- video olayları
    const EVENTS = ['play', 'playing', 'pause', 'seeked', 'seeking', 'timeupdate', 'waiting', 'canplay', 'ended'];

    function attach(v) {
      if (video === v) return;
      if (video) for (const e of EVENTS) video.removeEventListener(e, onVideoEvent);
      video = v;
      setBuffering(false);
      if (!video) return;
      for (const e of EVENTS) video.addEventListener(e, onVideoEvent);
      // Tanınmayan sitelerde (Exxen, TOD…) "izliyor" bilgisi videonun bulunmasına bağlı: yeniden bildir
      if (!KNOWN) lastUrl = '';
      setTimeout(joinRoomPosition, 1200);
    }

    function onVideoEvent(e) {
      const t = e.type;
      if (t === 'timeupdate') {
        if (!video.seeking) lastPlayhead = video.currentTime;
        return;
      }
      if (t === 'seeking') {
        lastSeekAt = Date.now();
        // Kendi uyguladığımız sarmalar sayılmaz
        if (isExpectedSeek()) seekFrom = null;
        else if (seekFrom === null) seekFrom = lastPlayhead;
        return;
      }
      if (t === 'waiting') {
        // 1.2 sn'den uzun süren yükleme diğerlerini bekletir
        clearTimeout(bufferTimer);
        bufferTimer = setTimeout(() => {
          if (video && !video.paused && video.readyState < 3) setBuffering(true);
        }, 1200);
        return;
      }
      if (t === 'playing' || t === 'canplay' || t === 'pause' || t === 'ended') {
        clearTimeout(bufferTimer);
        if (t !== 'canplay' || (video && video.readyState >= 3)) setBuffering(false);
        if (t === 'canplay') return;
      }
      if (t === 'ended') return;
      if (!connected() || countdown) return;
      if (t === 'seeked' && isExpectedSeek()) {
        expect.seek = null;
        return;
      }
      if ((t === 'play' || t === 'playing' || t === 'pause') && expect.paused !== null && Date.now() < expect.until && video.paused === expect.paused) {
        return; // kendi oynat/durdur'umuzun yankısı
      }
      // Sarma sırasında art arda gelen olayları birleştir, son durumu gönder
      pending = pending || { seek: false };
      if (t === 'seeked') pending.seek = true;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(flushLocal, 300);
    }

    function setBuffering(on) {
      if (on === bufferingSent) return;
      bufferingSent = on;
      if (connected()) post({ t: 'buffer', on });
    }

    function flushLocal() {
      const p = pending;
      pending = null;
      if (!p || !video || countdown) return;
      if (holding && video.paused) return;
      const paused = video.paused;
      const ct = contentTime();
      const rel = ct === null;
      const time = rel ? video.currentTime : ct;
      const delta = seekFrom !== null ? video.currentTime - seekFrom : null;
      seekFrom = null;
      lastPlayhead = video.currentTime;
      // Az önce uzaktan uyguladığımız durumu oynatıcı kendisi geri aldıysa: yayma, yeniden uygula
      if (applied && Date.now() < applied.until && !p.seek && paused !== applied.paused) {
        reassert();
        return;
      }
      if (roomState && roomState.paused === paused && applyable(roomState.url)) {
        if (!p.seek) return; // yankı
        if (!rel && !roomState.rel && Math.abs(time - expectedTime(roomState)) < 1) return;
        if (rel && (delta === null || Math.abs(delta) < 1)) return;
      }
      if (holding && !paused) holding = false; // kullanıcı beklemeyi kendisi bozdu
      // Güvenli modda, durmuşken yapılan sarma paylaşılmaz: ikiniz de durdurup kendi videonuzu
      // aynı sahneye getirebilin diye (dakika bilinmediği için başka hizalama yolu yok)
      if (rel && paused && p.seek) return;
      const action = p.seek ? 'seek' : paused ? 'pause' : 'play';
      const msg = { t: 'sync', action, time, paused };
      if (rel) msg.rel = true;
      if (action === 'seek' && delta !== null && Number.isFinite(delta)) msg.delta = Math.round(delta * 100) / 100;
      post(msg);
      lastLocal = Date.now();
      lastChangeAt = lastLocal;
      applied = null;
      roomState = { paused, time, at: serverNow(), url: location.href, by: me?.id, rel };
      updateHold();
    }

    // Uygulanan durum tuttu mu? Tutmadıysa (en fazla 3 kez) yeniden uygula
    function reassert() {
      if (!applied || !video || !roomState) return;
      if (applied.tries >= 3) return;
      applied.tries++;
      applied.until = Date.now() + 2500;
      suppressUntil = Date.now() + 600;
      if (applied.paused && !video.paused) progPause();
      else if (!applied.paused && video.paused) progPlay(() => {});
      // Oynatıcı bu arada ilerlediyse odanın konumuna geri getir (yalnızca gerçek dakika biliniyorsa)
      const ct = contentTime();
      if (ct !== null && !roomState.rel && Math.abs(ct - expectedTime(roomState)) > (applied.paused ? 0.25 : 1.5)) {
        progSeek(toVideoTime(expectedTime(roomState)));
      } else if (applied.at != null && (ct === null || roomState.rel) && Math.abs(video.currentTime - applied.at) > 0.5 && applied.paused) {
        progSeek(applied.at);
      }
    }

    function scheduleVerify() {
      clearTimeout(verifyTimer);
      verifyTimer = setTimeout(function check() {
        if (!applied || !video || countdown || holding) return;
        if (Date.now() - lastLocal < 1500) return; // kullanıcı bu arada kendisi bir şey yaptı
        if (video.paused !== applied.paused) {
          reassert();
          if (applied && applied.tries < 3) verifyTimer = setTimeout(check, 1200);
        }
      }, 1200);
    }

    // ---------------------------------------------------------------- uygulama
    function isExpectedSeek() {
      return expect.seek !== null && Date.now() < expect.until && Math.abs(video.currentTime - expect.seek) < 1.5;
    }
    // Programatik hareketler: yankıları tanınır
    function progSeek(t) {
      expect.seek = t;
      expect.until = Date.now() + 2500;
      seekTo(t);
    }
    function progPause() {
      expect.paused = true;
      expect.until = Date.now() + 2500;
      video.pause();
    }
    function progPlay(onBlocked) {
      expect.paused = false;
      expect.until = Date.now() + 2500;
      playVideo(onBlocked);
    }

    function seekTo(t) {
      if (PLATFORM === 'Netflix') {
        window.dispatchEvent(new CustomEvent('ortak-izle-netflix-seek', { detail: Math.round(t * 1000) }));
        return;
      }
      try {
        video.currentTime = t;
      } catch {}
    }

    function playVideo(onBlocked) {
      const pr = video.play();
      if (pr && pr.catch) {
        pr.catch((err) => {
          if (err && err.name === 'NotAllowedError') onBlocked();
        });
      }
    }

    function applyState(st, explicit) {
      if (!video || !st || countdown) return;
      if (holding && !st.paused) return; // önce bekleme bitsin
      const target = expectedTime(st);
      const ct = contentTime();
      // Güvenli mod: gerçek dakikayı bilmiyoruz ya da gönderen bilmiyor → yalnızca oynat/durdur
      const canSeek = ct !== null && !st.rel;
      const drift = canSeek ? Math.abs(ct - target) : 0;
      const limit = explicit ? (st.paused ? 0.25 : 0.75) : 2;
      const needSeek = canSeek && drift > limit;
      const needPlay = !st.paused && video.paused;
      const needPause = st.paused && !video.paused;
      if (!needSeek && !needPlay && !needPause) return;
      suppressUntil = Date.now() + 600;
      applied = { paused: !!st.paused, until: Date.now() + 2500, tries: 0, at: needSeek ? null : video.currentTime };
      scheduleVerify();
      if (needSeek) progSeek(toVideoTime(target));
      if (needPause) progPause();
      if (needPlay) {
        progPlay(() =>
          stage.tap('Oynatmak için dokun', () => {
            suppressUntil = Date.now() + 600;
            if (roomState && exact() && !roomState.rel) progSeek(toVideoTime(expectedTime(roomState)));
            progPlay(() => {});
          })
        );
      }
    }

    // Oynatıcı yeni açıldığında, oda aynı içerikteyse kaldığı yere atla
    function joinRoomPosition() {
      if (!video || !roomState || !connected()) return;
      if (roomState.by === me.id) return;
      if (!roomState.by || !roomState.url || !relatedContent(roomState.url)) return;
      if ((roomState.rel || !exact()) && !relWarned) {
        relWarned = true;
        notify('Bu platformda dakika okunamıyor. Hizalamak için: durdurun, ikiniz de aynı sahneye gelin, sonra oynatın. Sonrasında oynat/durdur/sar ikinizde birden olur.');
      }
      applyState(roomState, true);
    }

    // Başkası yükleniyorsa bekle, bitince devam et
    function updateHold() {
      const waitingFor = members.filter(
        (m) => m.id !== me?.id && m.buffering && m.url && relatedContent(m.url)
      );
      if (!waitingFor.length) holdExpired = false;
      // En fazla 12 sn bekle: "yükleme bitti" mesajı kaybolsa bile sonsuza kadar takılmayalım
      if (holding && Date.now() - holdSince > 12000) {
        holdExpired = true;
        notify(`${waitingFor.map((m) => m.name).join(', ') || 'Diğeri'} hâlâ yükleniyor; beklemeden devam ediliyor`);
      }
      const shouldHold = waitingFor.length > 0 && !holdExpired && !!video && !!roomState && !roomState.paused && !countdown;
      if (shouldHold) {
        stage.note(`${waitingFor.map((m) => m.name).join(', ')} yükleniyor, bekleniyor…`);
        if (!holding) {
          holding = true;
          holdSince = Date.now();
          if (!video.paused) {
            suppressUntil = Date.now() + 600;
            progPause();
          }
        }
      } else {
        stage.note(null);
        if (holding) {
          holding = false;
          // Kaldığımız yerden devam; ufak fark düzenli konum bildirimiyle düzelir
          if (video && roomState && !roomState.paused && video.paused) {
            suppressUntil = Date.now() + 600;
            progPlay(() => stage.tap('Devam etmek için dokun', () => progPlay(() => {})));
          }
        }
      }
    }

    function startCountdown(m) {
      if (!applyable(m.url)) return;
      if (countdown) clearInterval(countdown.timer);
      stage.clearTap();
      holding = false;
      stage.note(null);
      suppressUntil = Date.now() + 600;
      if (!video.paused) progPause();
      const absolute = !m.rel && exact();
      if (absolute) progSeek(toVideoTime(m.time));
      countdown = { at: m.at, time: m.time };
      const tickFn = () => {
        const left = countdown.at - serverNow();
        if (left <= 0) {
          clearInterval(countdown.timer);
          countdown = null;
          stage.count(null);
          suppressUntil = Date.now() + 600;
          if (absolute) progSeek(toVideoTime(m.time + Math.min(1, -left / 1000)));
          progPlay(() => stage.tap('Oynatmak için dokun', () => progPlay(() => {})));
          return;
        }
        stage.count(Math.ceil(left / 1000));
      };
      countdown.timer = setInterval(tickFn, 50);
      tickFn();
    }

    // ---------------------------------------------------------------- gelen mesajlar
    function receive(m) {
      if (!m || typeof m !== 'object') return;
      switch (m.t) {
        case 'status': {
          const was = connected();
          wsState = m.wsState;
          clockOffset = m.clockOffset || 0;
          me = m.room?.me || null;
          members = m.room?.members || [];
          roomState = m.room?.state || null;
          if (connected() && !was) {
            lastUrl = '';
            bufferingSent = !bufferingSent; // yeniden bağlanınca durumu tekrar gönder
            setBuffering(!bufferingSent);
            // Bağlantı koptuğu sırada son hareketi biz yaptıysak (gitmemiş olabilir) yeniden bildir
            if (video && lastLocal > lastRemote && Date.now() - lastLocal < 120000 && !countdown) {
              post({ t: 'sync', action: video.paused ? 'pause' : 'play', time: video.currentTime, paused: video.paused });
              lastLocal = Date.now();
            } else {
              joinRoomPosition();
            }
          }
          updateHold();
          break;
        }
        case 'clock':
          clockOffset = m.offset;
          break;
        case 'welcome':
          wsState = 'bağlı';
          me = m.you;
          members = m.members || [];
          roomState = m.state || null;
          lastUrl = '';
          joinRoomPosition();
          break;
        case 'member-join':
          members = members.filter((x) => x.id !== m.member.id).concat(m.member);
          break;
        case 'member-leave':
          members = members.filter((x) => x.id !== m.member.id);
          updateHold();
          break;
        case 'nav':
        case 'buffer':
          members = members.filter((x) => x.id !== m.member.id).concat(m.member);
          updateHold();
          break;
        case 'state':
          roomState = m.state;
          break;
        case 'sync':
          roomState = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by };
          lastRemote = Date.now();
          if (applyable(m.url)) {
            stage.clearTap();
            roomState.rel = !!m.rel;
            // Güvenli mod sarma: karşı taraf kaç sn sardıysa biz de o kadar sararız
            if (m.action === 'seek' && (m.rel || !exact()) && typeof m.delta === 'number' && Math.abs(m.delta) >= 1) {
              suppressUntil = Date.now() + 800;
              const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 1) : Infinity;
              progSeek(Math.min(max, Math.max(0, video.currentTime + m.delta)));
            }
            applyState(roomState, true);
            notify(
              m.action === 'play'
                ? `${m.name} oynattı`
                : m.action === 'pause'
                  ? `${m.name} durdurdu`
                  : `${m.name} ${fmt(m.time)} konumuna sardı`
            );
          }
          break;
        case 'tick':
          // Biz az önce bir şey yaptıysak (ya da şu an sarıyorsak), yolda kalmış eski bildirim
          // bizim hareketimizi ezmesin
          if (Date.now() - lastLocal < 2500 || pending) break;
          if (video && (video.seeking || Date.now() - lastSeekAt < 2000)) break;
          roomState = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by, rel: !!m.rel };
          if (applyable(m.url) && !holding) applyState(roomState, false);
          break;
        case 'countdown':
          lastRemote = Date.now();
          roomState = { paused: false, time: m.time, at: m.at, url: m.url, by: m.from, rel: !!m.rel };
          startCountdown(m);
          break;
        case 'react':
          if (video) stage.react(m.emoji, m.name);
          break;
        case 'cmd':
          command(m.cmd, m);
          break;
      }
    }

    // Arayüzden gelen komutlar
    function command(cmd, arg) {
      if (cmd === 'resync') {
        if (!video) return notify('Bu sayfada oynayan bir video yok.');
        if (!roomState || !roomState.by) return notify('Odada henüz bir oynatma yok.');
        stage.clearTap();
        applyState(roomState, true);
        if (roomState.rel || !exact()) notify('Bu platformda dakika okunamıyor. Hizalamak için durdurun, ikiniz de aynı sahneye gelin, sonra oynatın.');
        else notify(`${nameOf(roomState.by)} ile senkronlandı: ${fmt(expectedTime(roomState))}`);
      } else if (cmd === 'toggle') {
        // Paneldeki oynat/durdur: video olayı tetiklenir, oda da senkronlanır
        if (!video) return notify('Bu sayfada oynayan bir video yok.');
        stage.clearTap();
        expect.paused = null;
        if (video.paused) playVideo(() => stage.tap('Oynatmak için dokun', () => video.play()));
        else video.pause();
      } else if (cmd === 'seekBy') {
        if (!video) return;
        const d = Number(arg && arg.delta) || 0;
        const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 1) : Infinity;
        expect.seek = null;
        seekTo(Math.min(max, Math.max(0, video.currentTime + d)));
      } else if (cmd === 'countdown') {
        if (!video) return notify('Önce bir bölüm aç.');
        const ct = contentTime();
        post(ct === null ? { t: 'countdown', time: video.currentTime, rel: true } : { t: 'countdown', time: ct });
      } else if (cmd === 'react' && arg?.emoji) {
        post({ t: 'react', emoji: arg.emoji });
        if (video) stage.react(arg.emoji, null);
      }
    }

    // Bilinen platformlarda adrese, diğer sitelerde sayfada oynatılabilir video olmasına bakılır
    function watchingNow() {
      return isWatchUrl(location.href) || (!KNOWN && !!video);
    }

    // ---------------------------------------------------------------- düzenli işler
    setInterval(() => {
      const v = pickVideo();
      if (v !== video) {
        attach(v);
        uiOffset = null;
        uiDuration = 0;
        lastUi = null;
      }
      calibrate();
      if (holding) updateHold();

      if (connected() && location.href !== lastUrl) {
        lastUrl = location.href;
        clearTimeout(navTimer);
        navTimer = setTimeout(() => {
          if (lastUrl !== location.href) return;
          post({
            t: 'nav',
            url: location.href,
            title: cleanTitle(),
            platform: PLATFORM,
            watching: watchingNow(),
          });
        }, 1500);
      }

      const st = {
        t: 'engine',
        hasVideo: !!video,
        time: video ? contentTime() : 0, // null: gerçek dakika bilinmiyor
        exact: exact(),
        duration: video ? contentDuration() : 0,
        paused: video ? video.paused : true,
        holding,
        buffering: bufferingSent,
        platform: PLATFORM,
        title: cleanTitle(),
        url: location.href,
        watching: watchingNow(),
      };
      const key = JSON.stringify({ ...st, time: st.time === null ? null : Math.floor(st.time) });
      if (key !== lastEngineStatus) {
        lastEngineStatus = key;
        post(st);
      }
    }, 1000);

    // Son kumandayı veren biz isek durumumuzu (oynuyor/durdu + konum) düzenli duyur: bir değişiklikten
    // sonraki 10 sn boyunca her saniye, sonra 3 sn'de bir. Bir mesaj yolda kaybolsa bile diğerleri
    // en geç birkaç saniyede eşitlenir.
    setInterval(() => {
      if (!video || !connected() || !roomState || countdown || holding) return;
      if (roomState.by !== me.id || pending || bufferingSent) return;
      if (Date.now() < suppressUntil) return;
      const paused = video.paused;
      const now = Date.now();
      if (lastTickPaused !== paused) lastChangeAt = now;
      const every = now - lastChangeAt < 10000 ? 1000 : 3000;
      if (now - lastTickAt < every - 100) return;
      lastTickAt = now;
      lastTickPaused = paused;
      const ct = contentTime();
      const tick = { t: 'tick', time: ct === null ? video.currentTime : ct, paused };
      if (ct === null) tick.rel = true;
      post(tick);
      roomState = { ...roomState, paused, time: tick.time, at: serverNow(), rel: ct === null };
    }, 1000);

    post({ t: 'hello' });

    return { receive, command, stage, platform: PLATFORM, isWatchUrl, sameContent, fmt, cleanTitle, contentTime };
  }

  globalThis.OrtakIzleEngine = { create, isWatchUrl, sameContent, fmt, PLATFORM, readUiClock, parseClock };
})();
