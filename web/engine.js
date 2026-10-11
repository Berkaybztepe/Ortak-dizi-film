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
  // Uyguladığımız durumu oynatıcı bu süre içinde geri alırsa "oynatıcı direndi" sayılır (yeniden
  // uygulanır); daha sonraki değişiklik kullanıcınındır ve odaya yayılır
  const RESIST_MS = 2500;

  // Oynatıcı arayüzünden {now, max} (sn) okumaya çalışır; bulamazsa null
  function readUiClock(video) {
    let pct = null;
    let pctEl = null;
    for (const el of deepElements(document, '[role="slider"],[role="progressbar"],input[type="range"],progress,[aria-valuenow]')) {
      if (el.closest && el.closest('[data-ortak-izle]')) continue;
      const vt = el.getAttribute('aria-valuetext') || '';
      const ts = clocksIn(vt);
      if (ts.length >= 2 && ts[1].sec > ts[0].sec && ts[1].sec <= MAX_LEN) return { now: ts[0].sec, max: ts[1].sec, how: 'valuetext', el };
      const max = parseFloat(el.getAttribute('aria-valuemax') ?? el.max);
      const now = parseFloat(el.getAttribute('aria-valuenow') ?? el.value);
      if (!Number.isFinite(max) || !Number.isFinite(now) || now < 0 || now > max) continue;
      const min = parseFloat(el.getAttribute('aria-valuemin') ?? el.min) || 0;
      if (max >= 120 && max <= MAX_LEN && max !== 100 && max !== 1000 && min === 0) return { now, max, how: 'slider', el };
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

  // Bilinen çubuk öğesinden hızlı okuma (her güncellemede çağrılır; tüm sayfayı taramaz)
  function readUiElement(el, how) {
    if (!el || !el.isConnected) return null;
    if (how === 'valuetext') {
      const ts = clocksIn(el.getAttribute('aria-valuetext') || '');
      return ts.length >= 2 && ts[1].sec > ts[0].sec ? { now: ts[0].sec, max: ts[1].sec } : null;
    }
    const max = parseFloat(el.getAttribute('aria-valuemax') ?? el.max);
    const now = parseFloat(el.getAttribute('aria-valuenow') ?? el.value);
    return Number.isFinite(max) && Number.isFinite(now) && now >= 0 && now <= max ? { now, max } : null;
  }

  // ------------------------------------------------------------------ sahne katmanı
  // Videonun üstünde: tepkiler, geri sayım, "bekleniyor" notu, "başlat" düğmesi.
  // visual=false: tepki/geri sayım/not çizilmez (uygulamada bunları Android katmanı gösterir);
  // "oynatmak için dokun" düğmesi yine sayfada kalır (dokunuş sayfaya ait olmalı)
  function createStage(fontFamily, visual = true) {
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
        if (!visual) return;
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
        if (!visual) return;
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
        if (!visual) return;
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
    // Bildirim: eklentide sayfadaki panele, uygulamada arayüze gider
    const notify = opts.onNotice || ((text) => post({ t: 'notice', text }));
    // Uygulamada tepki ve geri sayım Android'in kendi katmanında çizilir (site ne yaparsa yapsın görünür)
    const visual = opts.stage !== false;

    let wsState = 'kapalı';
    let me = null;
    let members = [];
    let roomState = null;
    let clockOffset = 0;
    let rtt = 200; // sunucuya gidiş-dönüş (ms)
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
    // Planlı başlatma: herkes aynı sunucu anında oynatmaya başlar {at, timer, count}
    let starting = null;
    let lastEngineStatus = '';
    let lastLocal = 0; // en son kendi hareketimizi gönderdiğimiz an
    let lastRemote = 0; // en son başkasının hareketini aldığımız an
    // Uzaktan gelen bir durumu uyguladıktan sonra oynatıcı onu geri alırsa (ör. Disney+ kendiliğinden
    // yeniden oynatırsa) bunu kullanıcı hareketi sanıp odaya yaymamak için kısa bir koruma süresi
    let applied = null; // {paused, until, tries, at}
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
    // Güvenli mod (dakika okunamıyor): iki videonun zaman çizelgeleri arasındaki fark, birlikte
    // başladığımız anda ölçülür. üye id -> { v: benim video zamanım − onun bildirdiği zaman, rel }
    const offsets = {};
    // İnce ayar: küçük farkı videoyu belli belirsiz hızlandırıp/yavaşlatarak kapatırız (sarma
    // takılma yaratır). Oynatıcı hızı geri alıyorsa sarmaya döneriz.
    let rateSet = null;
    let correcting = false;
    let rateFights = 0;
    let rateBroken = false;
    let lastSteerSeek = 0;
    // Oynarken sarınca yüklenme yüzünden geride kalınan süre: öğrenilir ve bu sitede hatırlanır
    const LEAD_KEY = 'ortak-izle-sarma-payi';
    let seekLead = (() => {
      try {
        const v = parseFloat(localStorage.getItem(LEAD_KEY));
        return Number.isFinite(v) ? Math.min(2.5, Math.max(0, v)) : 0.3;
      } catch {
        return 0.3;
      }
    })();
    let leadCheck = 0;
    let lastErr = null; // son ölçülen fark (sn, + ise gerideyiz)
    let lastDriftSent = 0;
    let lastDriftVal = undefined;
    let lastPausedSeek = null;
    let blockedWarned = false;
    let userPlay = 0; // kullanıcı oynat'a bastı, oynatma başlayınca birlikte başlatma planlanacak

    const stage = createStage(opts.displayFont, visual);
    const serverNow = () => Date.now() + clockOffset;
    const expectedTime = (st) => (st.paused ? st.time : st.time + Math.max(0, serverNow() - st.at) / 1000);
    const connected = () => wsState === 'bağlı' && !!me;
    const nameOf = (id) => members.find((m) => m.id === id)?.name || 'Diğeri';
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

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
    // Çubuk saniyeyi gösterir; değeri değiştiği anda okursak (gözlemci) ofset en isabetli ölçülür.
    // Saniyede bir yapılan tam taramaya ek olarak çubuğun kendisini izleriz.
    let barObserver = null;
    let barEl = null;
    function watchBar(ui) {
      if (!ui.el || (ui.how !== 'slider' && ui.how !== 'valuetext') || ui.el === barEl) return;
      if (barObserver) barObserver.disconnect();
      barEl = ui.el;
      barObserver = new MutationObserver(() => {
        if (!video || video.paused) return;
        const r = readUiElement(barEl, ui.how);
        if (r) calibrateWith(r);
      });
      barObserver.observe(barEl, { attributes: true, attributeFilter: ['aria-valuenow', 'aria-valuetext', 'value'] });
    }
    function calibrate() {
      if (!video) return;
      let ui = null;
      try {
        ui = readUiClock(video);
      } catch {}
      if (!ui) return;
      try {
        watchBar(ui);
      } catch {}
      calibrateWith(ui);
    }
    function calibrateWith(ui) {
      // Sarma sırasında çubuk henüz güncellenmemiş olabilir: oturana kadar bekle
      if (video.seeking || Date.now() - lastSeekAt < 1500) return;
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

    // Oda durumuna göre olmamız gereken yer ve şu an olduğumuz yer (aynı ölçekte).
    // Dakika iki tarafta da biliniyorsa bölüm dakikasıyla, bilinmiyorsa birlikte başladığımız
    // andaki eşlemeyle karşılaştırılır. Hiçbiri yoksa null (yalnızca oynat/durdur eşlenir).
    function measure(st) {
      if (!video || !st) return null;
      const want = expectedTime(st);
      if (!st.rel && exact()) return { mine: contentTime(), want, abs: true };
      const k = st.by && offsets[st.by];
      if (k && k.rel === !!st.rel) return { mine: video.currentTime, want: want + k.v, abs: false };
      return null;
    }
    const toVideo = (ms, want = ms.want) => (ms.abs ? toVideoTime(want) : want);
    const syncMode = () => {
      if (!roomState || !roomState.by) return exact() ? 'exact' : 'safe';
      const ms = roomState.by === me?.id ? (exact() && !roomState.rel ? { abs: true } : null) : measure(roomState);
      return ms ? (ms.abs ? 'exact' : 'mapped') : 'safe';
    };

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

    // Odada bizimle aynı bölümü izleyen başka biri var mı?
    function othersHere() {
      return members.some(
        (m) => m.id !== me?.id && m.url && (m.watching ?? isWatchUrl(m.url)) && relatedContent(m.url)
      );
    }

    // Kullanıcı ekrana dokundu / tuşa bastı mı? Uyguladığımız durum kısa süre içinde değişirse ve
    // bu arada kullanıcı bir şeye dokunmadıysa, değişikliği oynatıcı kendisi yapmıştır (direnç).
    let lastInput = 0;
    for (const ev of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
      addEventListener(ev, () => (lastInput = Date.now()), { capture: true, passive: true });
    }
    const resisting = () => !!applied && Date.now() < applied.until && Date.now() - lastInput > 1200;

    // ---------------------------------------------------------------- video olayları
    const EVENTS = ['play', 'playing', 'pause', 'seeked', 'seeking', 'timeupdate', 'waiting', 'canplay', 'ended'];

    function attach(v) {
      if (video === v) return;
      if (video) for (const e of EVENTS) video.removeEventListener(e, onVideoEvent);
      if (video && rateSet !== null) restoreRate();
      video = v;
      rateSet = null;
      rateFights = 0;
      rateBroken = false;
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
      if (!connected()) return;
      const expectedPlayState = expect.paused !== null && Date.now() < expect.until && video.paused === expect.paused;
      if (starting) {
        // Planlı başlangıcı bekliyoruz: oynatıcı kendiliğinden oynarsa (ya da kullanıcı erken basarsa) beklet
        if (t === 'play' && !video.paused && !expectedPlayState) progPause();
        return;
      }
      if (t === 'seeked' && isExpectedSeek()) {
        expect.seek = null;
        return;
      }
      if ((t === 'play' || t === 'playing' || t === 'pause') && expectedPlayState) return; // kendi hareketimizin yankısı
      // Kullanıcı oynattı ve aynı bölümde başkası da var: herkes aynı anda başlasın diye kısa bir
      // süre sonrasına planla (oynatıcıyı hemen durdurup o anda birlikte başlatırız)
      if (t === 'play' && !video.paused && !pending && !holding && othersHere()) {
        if (resisting() && applied.paused) {
          reassert(); // oynatıcı az önceki durdurmayı geri aldı; kullanıcı değil
          return;
        }
        // Sitenin play() isteği tamamlansın ("playing"), sonra durdurup planla: aksi halde sitenin
        // play() sözü "durdurma ile kesildi" hatasıyla düşer
        clearTimeout(userPlay);
        userPlay = setTimeout(() => {
          userPlay = 0;
          if (video && !video.paused && !starting) startTogether();
        }, 600);
        return;
      }
      if (t === 'playing' && userPlay) {
        clearTimeout(userPlay);
        userPlay = 0;
        if (!video.paused && !starting) startTogether();
        return;
      }
      if (userPlay && (t === 'pause' || t === 'seeked')) {
        clearTimeout(userPlay);
        userPlay = 0;
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

    // Şu anki konum (dakika biliniyorsa bölüm dakikası, yoksa videonun kendi zamanı)
    function position() {
      const ct = contentTime();
      return ct === null ? { time: video.currentTime, rel: true } : { time: ct, rel: false };
    }

    function flushLocal() {
      const p = pending;
      pending = null;
      if (!p || !video || starting) return;
      if (holding && video.paused) return;
      const paused = video.paused;
      const { time, rel } = position();
      const delta = seekFrom !== null ? video.currentTime - seekFrom : null;
      seekFrom = null;
      lastPlayhead = video.currentTime;
      // Az önce uzaktan uyguladığımız durumu oynatıcı kendisi geri aldıysa: yayma, yeniden uygula
      if (resisting() && !p.seek && paused !== applied.paused) {
        reassert();
        return;
      }
      if (roomState && roomState.paused === paused && applyable(roomState.url)) {
        if (!p.seek) return; // yankı
        if (!rel && !roomState.rel && Math.abs(time - expectedTime(roomState)) < 0.5) return;
        if (rel && (delta === null || Math.abs(delta) < 1)) {
          // Güvenli modda durmuşken elle yapılan küçük ayar paylaşılmaz; eşleme artık geçersiz
          clearOffsets();
          return;
        }
      }
      if (holding && !paused) holding = false; // kullanıcı beklemeyi kendisi bozdu
      // Güvenli modda, durmuşken yapılan sarma paylaşılmaz: ikiniz de durdurup kendi videonuzu
      // aynı sahneye getirebilin diye (dakika bilinmediği için başka hizalama yolu yok)
      if (rel && paused && p.seek) {
        clearOffsets();
        return;
      }
      const action = p.seek ? 'seek' : paused ? 'pause' : 'play';
      const msg = { t: 'sync', action, time, paused, at: serverNow() };
      if (rel) msg.rel = true;
      if (action === 'seek' && delta !== null && Number.isFinite(delta)) msg.delta = Math.round(delta * 100) / 100;
      post(msg);
      lastLocal = Date.now();
      lastChangeAt = lastLocal;
      applied = null;
      roomState = { paused, time, at: msg.at, url: location.href, by: me?.id, rel };
      updateHold();
    }

    function clearOffsets() {
      for (const k of Object.keys(offsets)) delete offsets[k];
    }

    // Uygulanan durum tuttu mu? Tutmadıysa (en fazla 3 kez) yeniden uygula
    function reassert() {
      if (!applied || !video || !roomState) return;
      if (applied.tries >= 3) return;
      applied.tries++;
      applied.until = Date.now() + RESIST_MS;
      suppressUntil = Date.now() + 600;
      if (applied.paused && !video.paused) progPause();
      else if (!applied.paused && video.paused) progPlay(() => {});
      // Oynatıcı bu arada ilerlediyse odanın konumuna geri getir
      const ms = measure(roomState);
      if (ms && Math.abs(ms.want - ms.mine) > (applied.paused ? 0.25 : 1.5)) {
        progSeek(toVideo(ms));
      } else if (!ms && applied.at != null && applied.paused && Math.abs(video.currentTime - applied.at) > 0.5) {
        progSeek(applied.at);
      }
    }

    function scheduleVerify() {
      clearTimeout(verifyTimer);
      verifyTimer = setTimeout(function check() {
        if (!applied || !video || starting || holding) return;
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
      if (!Number.isFinite(t)) return;
      const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.5) : Infinity;
      t = Math.min(max, Math.max(0, t));
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

    const tapToPlay = () =>
      stage.tap('Oynatmak için dokun', () => {
        suppressUntil = Date.now() + 600;
        const ms = roomState && measure(roomState);
        if (ms && !roomState.paused && Math.abs(ms.want - ms.mine) > 1) progSeek(toVideo(ms, ms.want + seekLead));
        progPlay(() => {});
      });

    function applyState(st, explicit) {
      if (!video || !st || starting) return;
      if (holding && !st.paused) return; // önce bekleme bitsin
      const ms = measure(st);
      const needPlay = !st.paused && video.paused;
      const needPause = st.paused && !video.paused;
      let target = null;
      if (ms) {
        const d = ms.want - ms.mine;
        if (st.paused) {
          // Durmuşken aynı kareye getir (durmuşken sarma takılma yaratmaz). Oynatıcı tam o kareye
          // gidemiyorsa aynı hedefe tekrar tekrar sarmayalım.
          const same = lastPausedSeek && Math.abs(lastPausedSeek.want - ms.want) < 0.05 && Date.now() - lastPausedSeek.at < 30000;
          if (Math.abs(d) > 0.04 && !same) {
            target = toVideo(ms);
            lastPausedSeek = { want: ms.want, at: Date.now() };
          }
        } else if (Math.abs(d) > (explicit ? 1 : 1.5)) {
          // Büyük fark: sar (oynarken sarınca yüklenme süresi kadar ileriyi hedefle). Küçük farkı
          // ince ayar (hız) kapatır.
          target = toVideo(ms, ms.want + seekLead);
          leadCheck = Date.now() + 2500;
        }
      }
      if (target === null && !needPlay && !needPause) return;
      suppressUntil = Date.now() + 600;
      applied = { paused: !!st.paused, until: Date.now() + RESIST_MS, tries: 0, at: target === null ? video.currentTime : null };
      scheduleVerify();
      if (target !== null) progSeek(target);
      if (needPause) progPause();
      if (needPlay) progPlay(tapToPlay);
    }

    // Oynatıcı yeni açıldığında, oda aynı içerikteyse kaldığı yere atla
    function joinRoomPosition() {
      if (!video || !roomState || !connected()) return;
      if (roomState.by === me.id) return;
      if (!roomState.url || !relatedContent(roomState.url)) return;
      if ((roomState.rel || !exact()) && !relWarned) {
        relWarned = true;
        notify('Bu platformda dakika okunamıyor (güvenli mod). Hizalamak için: durdurun, ikiniz de aynı sahneye gelin, sonra biriniz oynatsın. Sonrasında oynat/durdur/sar ikinizde birden olur.');
      }
      if (!roomState.by) return;
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
      const shouldHold = waitingFor.length > 0 && !holdExpired && !!video && !!roomState && !roomState.paused && !starting;
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
          // Kaldığımız yerden devam; ufak fark ince ayarla kapanır
          if (video && roomState && !roomState.paused && video.paused) {
            suppressUntil = Date.now() + 600;
            progPlay(() => stage.tap('Devam etmek için dokun', () => progPlay(() => {})));
          }
        }
      }
    }

    // ---------------------------------------------------------------- birlikte başlatma
    // Herkes aynı sunucu anında başlar: başlatan da dahil, önce durur, sonra o anda oynatır.
    const startLead = () => Math.round(clamp(rtt * 1.5 + 150, 350, 1200));

    function clearStart() {
      if (!starting) return;
      clearTimeout(starting.timer);
      starting = null;
      stage.count(null);
    }

    function beginStart(at, showCount) {
      clearStart();
      stage.clearTap();
      holding = false;
      stage.note(null);
      if (video && !video.paused) progPause();
      restoreRate();
      starting = { at, count: showCount };
      const step = () => {
        if (!starting || !video) return;
        const left = starting.at - serverNow();
        if (starting.count) stage.count(left > 0 ? Math.ceil(left / 1000) : null);
        if (left > 6) {
          starting.timer = setTimeout(step, Math.min(left - 3, starting.count ? 100 : 250));
          return;
        }
        starting = null;
        stage.count(null);
        suppressUntil = Date.now() + 600;
        lastChangeAt = Date.now();
        applied = { paused: false, until: Date.now() + RESIST_MS, tries: 0, at: null };
        scheduleVerify();
        progPlay(tapToPlay);
      };
      step();
    }

    // Biz başlatıyoruz (oynat'a basıldı ya da paneldeki düğme)
    function startTogether() {
      if (!video.paused) progPause();
      const { time, rel } = position();
      const at = serverNow() + startLead();
      const msg = { t: 'sync', action: 'play', time, paused: false, at };
      if (rel) msg.rel = true;
      post(msg);
      lastLocal = Date.now();
      lastChangeAt = lastLocal;
      applied = null;
      roomState = { paused: false, time, at, url: location.href, by: me?.id, rel };
      // Güvenli modda karşı taraf eşlemeyi bu başlangıçla yeniden kurar; bizdeki eski sayılır
      if (rel) clearOffsets();
      beginStart(at, false);
    }

    // Başkası başlatıyor: önce onunla aynı kareye gel, sonra aynı anda başla
    function joinStart(m, showCount) {
      if (!video) return;
      const by = m.by || m.from;
      if (!video.paused) progPause();
      const st = { paused: true, time: m.time, at: m.at, by, rel: !!m.rel };
      if (!st.rel && exact()) {
        const d = m.time - contentTime();
        if (Math.abs(d) > 0.04) progSeek(toVideoTime(m.time));
      } else if (by && by !== me?.id) {
        // Dakika bilinmiyor: bulunduğumuz yer başlatanın yeri sayılır (elle hizaladığınız yer)
        offsets[by] = { v: video.currentTime - m.time, rel: st.rel };
      }
      lastPausedSeek = null;
      beginStart(m.at, showCount);
    }

    // ---------------------------------------------------------------- ince ayar (hız)
    function restoreRate() {
      if (rateSet !== null && video) {
        try {
          if (Math.abs(video.playbackRate - rateSet) < 0.001) video.playbackRate = 1;
        } catch {}
      }
      rateSet = null;
      correcting = false;
    }

    function steer() {
      lastErr = null;
      if (!video || !connected() || !roomState || starting || holding || pending) return restoreRate();
      if (!roomState.by || roomState.by === me.id) return restoreRate();
      if (roomState.paused || video.paused || video.seeking || video.readyState < 3) return restoreRate();
      if (!applyable(roomState.url)) return restoreRate();
      const now = Date.now();
      if (now - lastLocal < 1500 || now - lastSeekAt < 800) return restoreRate();
      const ms = measure(roomState);
      if (!ms) return restoreRate();
      const err = ms.want - ms.mine; // + : gerideyiz
      lastErr = err;
      // Son sarmadan sonra ne kadar geride/ileride kaldık: bir dahakine o kadar ileriyi hedefle
      if (leadCheck && now > leadCheck) {
        seekLead = clamp(seekLead + err * 0.8, 0, 2.5);
        leadCheck = 0;
        try {
          localStorage.setItem(LEAD_KEY, seekLead.toFixed(2));
        } catch {}
      }
      const a = Math.abs(err);
      if (a > (rateBroken ? 0.4 : 1)) {
        if (now - lastSteerSeek > 4000) {
          lastSteerSeek = now;
          restoreRate();
          suppressUntil = now + 600;
          progSeek(toVideo(ms, ms.want + seekLead));
          leadCheck = now + 2500;
        }
        return;
      }
      if (rateBroken) return;
      if ((!correcting && a < 0.08) || (correcting && a < 0.03)) return restoreRate();
      const cur = video.playbackRate;
      if (rateSet === null && Math.abs(cur - 1) > 0.001) return; // kullanıcının seçtiği hız: dokunma
      if (rateSet !== null && Math.abs(cur - rateSet) > 0.001) {
        // Oynatıcı hızı geri aldı: birkaç kez olursa hızla ayarı bırak, sarmaya dön
        if (++rateFights >= 4) rateBroken = true;
        rateSet = null;
        correcting = false;
        return;
      }
      correcting = true;
      const r = Math.round((1 + clamp(err * 0.6, -0.1, 0.1)) * 1000) / 1000;
      if (r !== rateSet) {
        try {
          video.playbackRate = r;
          rateSet = r;
        } catch {
          rateBroken = true;
        }
      }
    }
    setInterval(() => {
      steer();
      // Diğerleri farkımızı görsün (panelde "Senkron" ancak gerçekten öyleyse yazsın)
      const now = Date.now();
      const val = lastErr === null ? null : Math.round(lastErr * 100) / 100;
      const changed = (val === null) !== (lastDriftVal === null) || (val !== null && Math.abs(val - lastDriftVal) > 0.1);
      if (connected() && video && (changed ? now - lastDriftSent > 700 : now - lastDriftSent > 4000)) {
        if (val !== null || lastDriftVal !== null) post({ t: 'drift', err: val });
        lastDriftSent = now;
        lastDriftVal = val;
      }
    }, 250);

    // ---------------------------------------------------------------- gelen mesajlar
    function receive(m) {
      if (!m || typeof m !== 'object') return;
      switch (m.t) {
        case 'status': {
          const was = connected();
          wsState = m.wsState;
          clockOffset = m.clockOffset || 0;
          if (typeof m.rtt === 'number') rtt = m.rtt;
          me = m.room?.me || null;
          members = m.room?.members || [];
          roomState = m.room?.state || null;
          if (connected() && !was) {
            lastUrl = '';
            bufferingSent = !bufferingSent; // yeniden bağlanınca durumu tekrar gönder
            setBuffering(!bufferingSent);
            // Bağlantı koptuğu sırada son hareketi biz yaptıysak (gitmemiş olabilir) yeniden bildir
            if (video && lastLocal > lastRemote && Date.now() - lastLocal < 120000 && !starting) {
              const { time, rel } = position();
              const msg = { t: 'sync', action: video.paused ? 'pause' : 'play', time, paused: video.paused, at: serverNow() };
              if (rel) msg.rel = true;
              post(msg);
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
          if (typeof m.rtt === 'number') rtt = m.rtt;
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
          delete offsets[m.member.id];
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
        case 'sync': {
          roomState = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by, rel: !!m.rel };
          lastRemote = Date.now();
          if (!applyable(m.url)) break;
          stage.clearTap();
          if (m.reason) {
            // Biri bölümden/odadan çıktı: sadece dur, konuma dokunma
            clearStart();
            if (!video.paused) {
              suppressUntil = Date.now() + 600;
              applied = { paused: true, until: Date.now() + RESIST_MS, tries: 0, at: video.currentTime };
              scheduleVerify();
              progPause();
            }
            break;
          }
          // Planlı başlatma: aynı anda başla
          if (m.action === 'play' && typeof m.at === 'number' && m.at > serverNow() - 120) {
            joinStart(m, false);
            notify(`${m.name} oynattı`);
            break;
          }
          clearStart();
          // Güvenli mod sarma: karşı taraf kaç sn sardıysa biz de o kadar sararız (eşleme korunur)
          if (m.action === 'seek' && (m.rel || !exact()) && typeof m.delta === 'number' && Math.abs(m.delta) >= 1) {
            suppressUntil = Date.now() + 800;
            if (m.by && offsets[m.by]) {
              // Eşleme biliniyor: applyState zaten doğru yere götürür
            } else {
              progSeek(video.currentTime + m.delta);
            }
          }
          applyState(roomState, true);
          notify(
            m.action === 'play'
              ? `${m.name} oynattı`
              : m.action === 'pause'
                ? `${m.name} durdurdu`
                : `${m.name} ${fmt(m.time)} konumuna sardı`
          );
          break;
        }
        case 'tick':
          // Biz az önce bir şey yaptıysak (ya da şu an sarıyorsak), yolda kalmış eski bildirim
          // bizim hareketimizi ezmesin
          if (Date.now() - lastLocal < 2500 || pending || starting) break;
          if (video && (video.seeking || Date.now() - lastSeekAt < 2000)) break;
          roomState = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by, rel: !!m.rel };
          if (applyable(m.url) && !holding) applyState(roomState, false);
          break;
        case 'countdown':
          lastRemote = Date.now();
          roomState = { paused: false, time: m.time, at: m.at, url: m.url, by: m.from, rel: !!m.rel };
          if (!applyable(m.url)) break;
          if (m.from === me?.id) beginStart(m.at, true);
          else joinStart({ ...m, by: m.from }, true);
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
        if (roomState.by === me?.id) return notify('Kumanda sende; diğerleri sana göre eşitleniyor.');
        stage.clearTap();
        lastPausedSeek = null;
        lastSteerSeek = 0;
        applyState(roomState, true);
        const ms = measure(roomState);
        if (!ms) notify('Dakika okunamıyor (güvenli mod). Hizalamak için durdurun, ikiniz de aynı sahneye gelin, sonra oynatın.');
        else notify(`${nameOf(roomState.by)} ile eşitlendi`);
      } else if (cmd === 'toggle') {
        // Paneldeki oynat/durdur
        if (!video) return notify('Bu sayfada oynayan bir video yok.');
        stage.clearTap();
        expect.paused = null;
        applied = null; // kullanıcının kendi hareketi: "oynatıcı direndi" sanılmasın
        if (starting) {
          clearStart();
          pending = { seek: false };
          flushLocal();
          return;
        }
        if (video.paused) {
          if (connected() && othersHere() && !holding) startTogether();
          else playVideo(() => stage.tap('Oynatmak için dokun', () => video.play()));
        } else video.pause();
      } else if (cmd === 'pauseAll') {
        // Bölümden çıkılıyor: hemen herkeste durdur (sayfa kapanmadan önce)
        if (!video || video.paused || !connected()) return;
        clearStart();
        progPause();
        const { time, rel } = position();
        const msg = { t: 'sync', action: 'pause', time, paused: true, at: serverNow() };
        if (rel) msg.rel = true;
        post(msg);
        lastLocal = Date.now();
        roomState = { paused: true, time, at: msg.at, url: location.href, by: me?.id, rel };
      } else if (cmd === 'seekBy') {
        if (!video) return;
        const d = Number(arg && arg.delta) || 0;
        const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 1) : Infinity;
        expect.seek = null;
        applied = null;
        seekTo(Math.min(max, Math.max(0, video.currentTime + d)));
      } else if (cmd === 'countdown') {
        if (!video) return notify('Önce bir bölüm aç.');
        clearStart();
        if (!video.paused) progPause();
        const { time, rel } = position();
        if (rel) clearOffsets();
        post(rel ? { t: 'countdown', time, rel: true } : { t: 'countdown', time });
        lastLocal = Date.now();
      } else if (cmd === 'react' && arg?.emoji) {
        post({ t: 'react', emoji: arg.emoji });
        if (video) stage.react(arg.emoji, null);
      }
    }

    // Bilinen platformlarda adrese, diğer sitelerde sayfada oynatılabilir video olmasına bakılır
    function watchingNow() {
      return isWatchUrl(location.href) || (!KNOWN && !!video);
    }

    // Site oynatmayı engelliyor mu (ör. Netflix telefonda web oynatıcıyı kapatıyor)?
    const BLOCK_RE = /\bM7\d{3}-\d{4}\b|desteklenmeyen tarayıcı|tarayıcı(nız)? desteklenmiyor|unsupported browser|browser (is )?not supported|isn't supported on this browser/i;
    function checkBlocked() {
      if (blockedWarned || video || !document.body) return;
      const txt = (document.body.innerText || '').slice(0, 20000);
      if (BLOCK_RE.test(txt)) {
        blockedWarned = true;
        post({ t: 'notice', blocked: true, platform: PLATFORM, text: `${PLATFORM} bu cihazda web oynatıcıyı engelliyor.` });
      }
    }

    // ---------------------------------------------------------------- düzenli işler
    let blockCheckAt = 0;
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
      if (Date.now() - blockCheckAt > 3000) {
        blockCheckAt = Date.now();
        checkBlocked();
      }

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
        starting: !!starting,
        buffering: bufferingSent,
        platform: PLATFORM,
        title: cleanTitle(),
        url: location.href,
        watching: watchingNow(),
        leader: !!(roomState && me && roomState.by === me.id),
        mode: video ? syncMode() : null,
        err: lastErr === null ? null : Math.round(lastErr * 100) / 100,
      };
      const key = JSON.stringify({ ...st, time: st.time === null ? null : Math.floor(st.time), err: st.err === null ? null : Math.round(st.err * 10) });
      if (key !== lastEngineStatus) {
        lastEngineStatus = key;
        post(st);
      }
    }, 1000);

    // Son kumandayı veren biz isek durumumuzu (oynuyor/durdu + konum + ölçüm anı) düzenli duyur:
    // oynarken her saniye, durmuşken değişiklikten sonraki 10 sn boyunca her saniye, sonra 3 sn'de
    // bir. Bir mesaj yolda kaybolsa bile diğerleri en geç birkaç saniyede eşitlenir.
    setInterval(() => {
      if (!video || !connected() || !roomState || starting || holding) return;
      if (roomState.by !== me.id || pending || bufferingSent) return;
      if (Date.now() < suppressUntil) return;
      const paused = video.paused;
      const now = Date.now();
      if (lastTickPaused !== paused) lastChangeAt = now;
      const every = !paused || now - lastChangeAt < 10000 ? 1000 : 3000;
      if (now - lastTickAt < every - 150) return;
      lastTickAt = now;
      lastTickPaused = paused;
      const { time, rel } = position();
      const tick = { t: 'tick', time, paused, at: serverNow() };
      if (rel) tick.rel = true;
      post(tick);
      roomState = { ...roomState, paused, time, at: tick.at, rel };
    }, 250);

    addEventListener('pagehide', () => setBuffering(false));

    post({ t: 'hello' });

    return { receive, command, stage, platform: PLATFORM, isWatchUrl, sameContent, fmt, cleanTitle, contentTime };
  }


  globalThis.OrtakIzleEngine = { create, isWatchUrl, sameContent, fmt, PLATFORM, readUiClock, parseClock };
})();
