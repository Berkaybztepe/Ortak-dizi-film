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
  const PLATFORM = (PLATFORMS.find(([r]) => r.test(HOST)) || [null, HOST])[1];

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
    let suppressUntil = 0; // kendi uyguladığımız hareketlerin yankısını yut
    let pending = null;
    let lastUrl = '';
    let navTimer = null;
    let holding = false; // başkası yüklenirken beklemedeyiz
    let bufferTimer = null;
    let bufferingSent = false;
    let countdown = null; // {at, time, timer}
    let lastEngineStatus = '';

    const stage = createStage(opts.displayFont);
    const serverNow = () => Date.now() + clockOffset;
    const expectedTime = (st) => (st.paused ? st.time : st.time + Math.max(0, serverNow() - st.at) / 1000);
    const connected = () => wsState === 'bağlı' && !!me;
    const nameOf = (id) => members.find((m) => m.id === id)?.name || 'Diğeri';

    // Uzaktan gelen hareket bu sayfaya uygulanmalı mı?
    function applyable(url) {
      if (!video) return false;
      if (!url) return true;
      return sameContent(url, location.href) || !isWatchUrl(url);
    }

    // ---------------------------------------------------------------- video olayları
    const EVENTS = ['play', 'playing', 'pause', 'seeked', 'waiting', 'canplay', 'ended'];

    function attach(v) {
      if (video === v) return;
      if (video) for (const e of EVENTS) video.removeEventListener(e, onVideoEvent);
      video = v;
      setBuffering(false);
      if (!video) return;
      for (const e of EVENTS) video.addEventListener(e, onVideoEvent);
      setTimeout(joinRoomPosition, 1200);
    }

    function onVideoEvent(e) {
      const t = e.type;
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
      if (Date.now() < suppressUntil || !connected()) return;
      if (countdown) return;
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
      if (!p || !video || Date.now() < suppressUntil || countdown) return;
      if (holding && video.paused) return;
      const paused = video.paused;
      const time = video.currentTime;
      if (roomState && roomState.paused === paused && applyable(roomState.url)) {
        if (!p.seek) return; // yankı
        if (Math.abs(time - expectedTime(roomState)) < 1) return;
      }
      if (holding && !paused) holding = false; // kullanıcı beklemeyi kendisi bozdu
      const action = p.seek ? 'seek' : paused ? 'pause' : 'play';
      post({ t: 'sync', action, time, paused });
      roomState = { paused, time, at: serverNow(), url: location.href, by: me?.id };
      updateHold();
    }

    // ---------------------------------------------------------------- uygulama
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
      const drift = Math.abs(video.currentTime - target);
      const limit = explicit ? (st.paused ? 0.25 : 0.75) : 2;
      const needSeek = drift > limit;
      const needPlay = !st.paused && video.paused;
      const needPause = st.paused && !video.paused;
      if (!needSeek && !needPlay && !needPause) return;
      suppressUntil = Date.now() + 600;
      if (needSeek) seekTo(target);
      if (needPause) video.pause();
      if (needPlay) {
        playVideo(() =>
          stage.tap('Oynatmak için dokun', () => {
            suppressUntil = Date.now() + 600;
            if (roomState) seekTo(expectedTime(roomState));
            video.play();
          })
        );
      }
    }

    // Oynatıcı yeni açıldığında, oda aynı içerikteyse kaldığı yere atla
    function joinRoomPosition() {
      if (!video || !roomState || !connected()) return;
      if (roomState.by === me.id) return;
      if (!roomState.by || !roomState.url || !sameContent(roomState.url, location.href)) return;
      applyState(roomState, true);
    }

    // Başkası yükleniyorsa bekle, bitince devam et
    function updateHold() {
      const waitingFor = members.filter(
        (m) => m.id !== me?.id && m.buffering && m.url && sameContent(m.url, location.href)
      );
      const shouldHold = waitingFor.length > 0 && !!video && !!roomState && !roomState.paused && !countdown;
      if (shouldHold) {
        stage.note(`${waitingFor.map((m) => m.name).join(', ')} yükleniyor, bekleniyor…`);
        if (!holding) {
          holding = true;
          if (!video.paused) {
            suppressUntil = Date.now() + 600;
            video.pause();
          }
        }
      } else {
        stage.note(null);
        if (holding) {
          holding = false;
          // Kaldığımız yerden devam; ufak fark düzenli konum bildirimiyle düzelir
          if (video && roomState && !roomState.paused && video.paused) {
            suppressUntil = Date.now() + 600;
            playVideo(() => stage.tap('Devam etmek için dokun', () => video.play()));
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
      if (!video.paused) video.pause();
      seekTo(m.time);
      countdown = { at: m.at, time: m.time };
      const tickFn = () => {
        const left = countdown.at - serverNow();
        if (left <= 0) {
          clearInterval(countdown.timer);
          countdown = null;
          stage.count(null);
          suppressUntil = Date.now() + 600;
          seekTo(m.time + Math.min(1, -left / 1000));
          playVideo(() => stage.tap('Oynatmak için dokun', () => video.play()));
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
            joinRoomPosition();
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
          if (applyable(m.url)) {
            stage.clearTap();
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
          roomState = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by };
          if (applyable(m.url) && !holding) applyState(roomState, false);
          break;
        case 'countdown':
          roomState = { paused: false, time: m.time, at: m.at, url: m.url, by: m.from };
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
        notify(`${nameOf(roomState.by)} ile senkronlandı: ${fmt(expectedTime(roomState))}`);
      } else if (cmd === 'countdown') {
        if (!video) return notify('Önce bir bölüm aç.');
        post({ t: 'countdown', time: video.currentTime });
      } else if (cmd === 'react' && arg?.emoji) {
        post({ t: 'react', emoji: arg.emoji });
        if (video) stage.react(arg.emoji, null);
      }
    }

    // ---------------------------------------------------------------- düzenli işler
    setInterval(() => {
      const v = pickVideo();
      if (v !== video) attach(v);

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
            watching: isWatchUrl(location.href),
          });
        }, 1500);
      }

      const st = {
        t: 'engine',
        hasVideo: !!video,
        time: video ? video.currentTime : 0,
        duration: video && Number.isFinite(video.duration) ? video.duration : 0,
        paused: video ? video.paused : true,
        holding,
        buffering: bufferingSent,
        platform: PLATFORM,
        title: cleanTitle(),
        url: location.href,
        watching: isWatchUrl(location.href),
      };
      const key = JSON.stringify({ ...st, time: Math.floor(st.time) });
      if (key !== lastEngineStatus) {
        lastEngineStatus = key;
        post(st);
      }
    }, 1000);

    // Son kumandayı veren biz isek, oynarken konumumuzu duyur
    setInterval(() => {
      if (!video || !connected() || !roomState || countdown || holding) return;
      if (roomState.by !== me.id || video.paused || pending || bufferingSent) return;
      if (Date.now() < suppressUntil) return;
      post({ t: 'tick', time: video.currentTime, paused: false });
      roomState = { ...roomState, paused: false, time: video.currentTime, at: serverNow() };
    }, 4000);

    post({ t: 'hello' });

    return { receive, command, stage, platform: PLATFORM, isWatchUrl, sameContent, fmt, cleanTitle };
  }

  globalThis.OrtakIzleEngine = { create, isWatchUrl, sameContent, fmt, PLATFORM };
})();
