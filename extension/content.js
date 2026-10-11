// Ortak İzle — platform sayfasında çalışır (Disney+, HBO Max, Apple TV+ ...).
// 1) Sayfadaki <video> öğesini bulur (gölge DOM'ların içi dahil),
// 2) oynat / durdur / sar hareketlerini odaya gönderir, gelenleri uygular,
// 3) sayfanın üstüne sohbet paneli ve bildirimler ekler,
// 4) hangi dizi/filmin açıldığını diğerine bildirir.

(() => {
  if (window.top !== window || window.__ortakIzle) return;
  window.__ortakIzle = true;

  const api = globalThis.browser ?? globalThis.chrome;

  // ------------------------------------------------------------------ platform
  const HOST = location.hostname;
  const PLATFORM = /disneyplus/.test(HOST)
    ? 'Disney+'
    : /hbomax|max\.com/.test(HOST)
      ? 'HBO Max'
      : /tv\.apple\.com/.test(HOST)
        ? 'Apple TV+'
        : /netflix/.test(HOST)
          ? 'Netflix'
          : /primevideo|amazon\./.test(HOST)
            ? 'Prime Video'
            : /youtube/.test(HOST)
              ? 'YouTube'
              : HOST;

  // İzleme (oynatıcı) sayfası mı? Bunlar "X şunu açtı" bildirimi için kullanılır.
  const WATCH_PATTERNS = [
    /disneyplus\.com\/.*(play|video)\//,
    /(hbo)?max\.com\/.*(video\/watch|player)/,
    /tv\.apple\.com\/.*(episode|movie|show).*/,
    /netflix\.com\/watch\//,
    /(primevideo|amazon)\..*\/(detail|watch|gp\/video)/,
    /youtube\.com\/watch/,
  ];
  const isWatchUrl = (u) => WATCH_PATTERNS.some((r) => r.test(u));

  const sameContent = (a, b) => {
    if (!a || !b) return false;
    try {
      const x = new URL(a);
      const y = new URL(b);
      if (x.host !== y.host) return false;
      if (/youtube/.test(x.host)) return x.searchParams.get('v') === y.searchParams.get('v');
      return x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
    } catch {
      return false;
    }
  };

  // ------------------------------------------------------------------ durum
  let port = null;
  let wsState = 'kapalı';
  let me = null;
  let members = [];
  let roomState = null; // {paused, time, at(sunucu ms), url, by}
  let clockOffset = 0;
  let autoFollow = false;
  let video = null;
  // Uzaktan gelen bir hareketi uyguladıktan hemen sonraki video olayları bizim yankımızdır.
  // Geç gelen yankılar ayrıca flushLocal'da oda durumuyla karşılaştırılarak elenir.
  let suppressUntil = 0;
  let pending = null; // biriktirilen yerel olaylar
  let lastUrl = '';
  let unread = 0;
  let panelOpen = false;

  const serverNow = () => Date.now() + clockOffset;

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };

  // ------------------------------------------------------------------ köprü
  function connectPort() {
    try {
      port = api.runtime.connect({ name: 'ortak-izle' });
    } catch {
      return; // eklenti güncellendi/kaldırıldı
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // Servis çalışanı uyutulduysa yeniden bağlan
      setTimeout(connectPort, 1000);
    });
    port.postMessage({ t: 'hello' });
  }

  function post(m) {
    if (!port) return;
    try {
      port.postMessage(m);
    } catch {}
  }

  function onMessage(m) {
    switch (m.t) {
      case 'status': {
        const wasConnected = wsState === 'bağlı';
        wsState = m.wsState;
        clockOffset = m.clockOffset || 0;
        autoFollow = !!m.settings?.autoFollow;
        me = m.room.me;
        members = m.room.members || [];
        roomState = m.room.state;
        ui.setStatus();
        ui.renderHistory(m.room.history || []);
        if (wsState === 'bağlı' && !wasConnected) {
          lastUrl = ''; // bağlanınca bulunduğumuz sayfayı hemen bildir
          maybeJoinRoomState();
        }
        break;
      }
      case 'clock':
        clockOffset = m.offset;
        break;
      case 'welcome':
        me = m.you;
        members = m.members;
        roomState = m.state;
        wsState = 'bağlı';
        lastUrl = '';
        ui.setStatus();
        ui.renderHistory(m.history);
        maybeJoinRoomState();
        break;
      case 'member-join':
        members = members.filter((x) => x.id !== m.member.id).concat(m.member);
        ui.setStatus();
        break;
      case 'member-leave':
        members = members.filter((x) => x.id !== m.member.id);
        ui.setStatus();
        break;
      case 'chat':
        ui.addMsg(m);
        break;
      case 'state':
        roomState = m.state;
        break;
      case 'sync':
        roomState = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by };
        if (applyable(m)) applyState(roomState, true);
        ui.toast(
          `${m.name} ${m.action === 'play' ? '▶ oynattı' : m.action === 'pause' ? '⏸ durdurdu' : `⏩ ${fmt(m.time)}'e sardı`}`
        );
        break;
      case 'tick':
        roomState = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by };
        if (applyable(m)) applyState(roomState, false);
        break;
      case 'nav': {
        members = members.map((x) => (x.id === m.member.id ? m.member : x));
        ui.setStatus();
        const u = m.member.url;
        if (m.watching && u && !sameContent(u, location.href)) {
          if (autoFollow) {
            ui.toast(`${m.member.name} ${m.member.title || 'bir şey'} açtı — geçiliyor…`);
            setTimeout(() => (location.href = u), 1200);
          } else {
            ui.offer(`${m.member.name} şunu açtı: ${m.member.title || m.member.platform || u}`, u);
          }
        }
        break;
      }
      case 'invite':
        if (!sameContent(m.url, location.href)) {
          ui.offer(`${m.name} seni çağırıyor: ${m.title || m.url}`, m.url);
        }
        break;
    }
  }

  // Gelen senkron mesajı bu sekmeye uygulanmalı mı?
  // Oynatıcı açıksa ve (karşı taraf aynı içerikteyse ya da içerik bilgisi yoksa) evet.
  function applyable(m) {
    if (!video) return false;
    if (!m.url) return true;
    return sameContent(m.url, location.href) || !isWatchUrl(m.url);
  }

  // ------------------------------------------------------------------ video bulma
  function* allVideos(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (node.querySelectorAll) {
        for (const v of node.querySelectorAll('video')) yield v;
        // Açık gölge DOM'lar (Disney+ ve Apple TV+ oynatıcıları bunları kullanır)
        for (const el of node.querySelectorAll('*')) if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
  }

  function pickVideo() {
    let best = null;
    let bestScore = 0;
    for (const v of allVideos(document)) {
      const r = v.getBoundingClientRect();
      let score = r.width * r.height;
      if (!v.src && !v.currentSrc && v.readyState === 0) score *= 0.01;
      if (!v.paused) score *= 2;
      if (Number.isFinite(v.duration) && v.duration < 45) score *= 0.1; // reklam/önizleme
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  const VIDEO_EVENTS = ['play', 'playing', 'pause', 'seeked'];

  function attach(v) {
    if (video === v) return;
    if (video) for (const e of VIDEO_EVENTS) video.removeEventListener(e, onVideoEvent);
    video = v;
    if (!video) return;
    for (const e of VIDEO_EVENTS) video.addEventListener(e, onVideoEvent);
    // Yeni video çıktı: oda bu içerikteyse yakala
    setTimeout(maybeJoinRoomState, 1500);
    ui.setStatus();
  }

  // ------------------------------------------------------------------ yerel olaylar
  function onVideoEvent(e) {
    if (Date.now() < suppressUntil) return;
    if (wsState !== 'bağlı') return;
    // Oynatıcılar sarma sırasında art arda pause/play/seeked atar; kısa süre
    // biriktirip tek, son durumu gönderiyoruz.
    pending = pending || { seek: false };
    if (e.type === 'seeked') pending.seek = true;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(flushLocal, 300);
  }

  function flushLocal() {
    const p = pending;
    pending = null;
    if (!p || !video || Date.now() < suppressUntil) return;
    const paused = video.paused;
    const time = video.currentTime;
    // Zaten odanın durumuyla aynıysa (ör. bizim uygulamamızın geç gelen yankısı) gönderme
    if (roomState && roomState.paused === paused) {
      if (!p.seek) return;
      if (Math.abs(time - expectedTime(roomState)) < 1) return;
    }
    const action = p.seek ? 'seek' : paused ? 'pause' : 'play';
    post({ t: 'sync', action, time, paused });
    roomState = { paused, time, at: serverNow(), url: location.href, by: me?.id };
  }

  // ------------------------------------------------------------------ uzaktan uygulama
  function expectedTime(st) {
    return st.paused ? st.time : st.time + Math.max(0, serverNow() - st.at) / 1000;
  }

  function seekTo(t) {
    if (PLATFORM === 'Netflix') {
      // Netflix currentTime'ı doğrudan değiştirince hata veriyor; kendi API'sini kullan
      window.dispatchEvent(new CustomEvent('ortak-izle-netflix-seek', { detail: Math.round(t * 1000) }));
      return;
    }
    try {
      video.currentTime = t;
    } catch {}
  }

  function applyState(st, explicit) {
    if (!video || !st) return;
    const target = expectedTime(st);
    const drift = Math.abs(video.currentTime - target);
    // Elle yapılan hareketlerde küçük farkı da düzelt (durunca tam aynı kare);
    // düzenli bildirimde sadece belirgin kaymayı
    const limit = explicit ? (st.paused ? 0.25 : 0.75) : 2;
    const needSeek = drift > limit;
    const needPlay = !st.paused && video.paused;
    const needPause = st.paused && !video.paused;
    if (!needSeek && !needPlay && !needPause) return;

    suppressUntil = Date.now() + 500;
    if (needSeek) seekTo(target);
    if (needPause) video.pause();
    if (needPlay) {
      const pr = video.play();
      if (pr && pr.catch) {
        pr.catch(() => {
          // Tarayıcı otomatik oynatmayı engelledi: kullanıcıdan bir tık iste
          ui.offer('Karşı taraf oynattı. Başlatmak için dokun.', null, () => {
            suppressUntil = Date.now() + 500;
            seekTo(expectedTime(roomState));
            video.play();
          });
        });
      }
    }
  }

  // Oynatıcı yeni açıldığında odanın konumuna atla
  function maybeJoinRoomState() {
    if (!video || !roomState || wsState !== 'bağlı') return;
    if (roomState.by === me?.id) return;
    // Sadece karşı taraf şu an aynı içeriği oynatıyorsa (yeni/boş oda durumunu uygulama)
    if (!roomState.by || !roomState.url || !sameContent(roomState.url, location.href)) return;
    applyState(roomState, true);
  }

  // ------------------------------------------------------------------ düzenli işler
  setInterval(() => {
    // Video öğesini takip et (SPA'larda sayfa yenilenmeden değişir)
    const v = pickVideo();
    if (v !== video) attach(v);

    // Sayfa değiştiyse bildir
    if (wsState === 'bağlı' && location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => {
        if (lastUrl !== location.href) return;
        post({
          t: 'nav',
          url: location.href,
          title: cleanTitle(document.title),
          platform: PLATFORM,
          watching: isWatchUrl(location.href),
        });
      }, 1500); // başlığın yüklenmesi için kısa bekleme
    }
  }, 1000);

  // Son kumandayı veren biz isek, oynarken konumumuzu duyur (kayma düzeltmesi)
  setInterval(() => {
    if (!video || wsState !== 'bağlı' || !me || !roomState) return;
    if (roomState.by !== me.id || video.paused || pending) return;
    if (Date.now() < suppressUntil) return;
    post({ t: 'tick', time: video.currentTime, paused: video.paused });
  }, 4000);

  function cleanTitle(t) {
    return (t || '')
      .replace(/\s*[|\-–]\s*(Disney\+|HBO Max|Max|Apple TV\+?|Netflix|Prime Video|YouTube).*$/i, '')
      .trim()
      .slice(0, 200);
  }

  // Sohbet kutusuna yazarken boşluk/ok tuşları oynatıcıyı tetiklemesin.
  // document_start'ta, sayfanın kendi dinleyicilerinden önce kaydediliyor.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(
      type,
      (e) => {
        if (ui.host && e.composedPath().includes(ui.host)) e.stopImmediatePropagation();
      },
      true
    );
  }

  // ------------------------------------------------------------------ arayüz
  const ui = {
    host: null,
    root: null,
    els: {},

    init() {
      const host = document.createElement('div');
      host.id = 'ortak-izle-root';
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #eef0f5; }
          * { box-sizing: border-box; }
          .fab { width: 48px; height: 48px; border-radius: 50%; border: 0; cursor: pointer; position: relative;
            background: #7c5cff; color: #fff; font-size: 22px; box-shadow: 0 4px 16px rgba(0,0,0,.5); opacity: .85; }
          .fab:hover { opacity: 1; }
          .fab .badge { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px;
            border-radius: 10px; background: #e5484d; font-size: 12px; line-height: 20px; display: none; }
          .fab .st { position: absolute; bottom: 2px; right: 2px; width: 11px; height: 11px; border-radius: 50%;
            background: #e5484d; border: 2px solid #7c5cff; }
          .fab .st.on { background: #22c39a; }
          .panel { position: absolute; right: 0; bottom: 60px; width: 320px; height: 420px; max-height: 70vh;
            background: rgba(18,20,26,.96); border: 1px solid #2c313d; border-radius: 14px; display: none;
            flex-direction: column; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,.6); }
          .panel.open { display: flex; }
          .head { padding: 10px 12px; border-bottom: 1px solid #2c313d; display: flex; flex-direction: column; gap: 6px; }
          .title { font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
          .who { font-size: 12px; color: #a3abbb; }
          .btns { display: flex; gap: 6px; }
          .btn { flex: 1; border: 1px solid #3a4050; background: #232836; color: #eef0f5; border-radius: 8px;
            padding: 6px; font: inherit; font-size: 12px; cursor: pointer; }
          .btn:hover { background: #2d3344; }
          .x { background: none; border: 0; color: #a3abbb; font-size: 18px; cursor: pointer; }
          .msgs { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
          .m { max-width: 88%; padding: 6px 10px; border-radius: 10px; background: #252a37; word-wrap: break-word; }
          .m.me { align-self: flex-end; background: #3a2f7a; }
          .m.sys { align-self: center; background: none; color: #8d95a5; font-size: 12px; padding: 0; }
          .m b { display: block; font-size: 11px; color: #a995ff; }
          form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #2c313d; }
          input { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid #3a4050; background: #0f1218;
            color: #eef0f5; font: inherit; }
          .send { border: 0; border-radius: 8px; background: #7c5cff; color: #fff; padding: 0 12px; font: inherit; cursor: pointer; }
          .toasts { position: absolute; right: 0; bottom: 60px; display: flex; flex-direction: column; gap: 6px;
            align-items: flex-end; pointer-events: none; }
          .panel.open ~ .toasts { bottom: 490px; }
          .toast { background: rgba(18,20,26,.95); border: 1px solid #2c313d; border-radius: 10px; padding: 8px 12px;
            max-width: 320px; box-shadow: 0 4px 16px rgba(0,0,0,.5); pointer-events: auto; animation: in .2s ease-out; }
          .toast .row { display: flex; gap: 6px; margin-top: 6px; }
          .toast .btn { flex: none; padding: 4px 10px; }
          .toast .btn.go { background: #7c5cff; border-color: #7c5cff; }
          @keyframes in { from { opacity: 0; transform: translateY(6px); } }
        </style>
        <div class="panel">
          <div class="head">
            <div class="title"><span>🎬 Ortak İzle</span><button class="x" title="Kapat">×</button></div>
            <div class="who"></div>
            <div class="btns">
              <button class="btn sync" title="Odanın kaldığı yere atla">⟲ Senkronla</button>
              <button class="btn invite" title="Diğerlerine bu sayfayı aç">📣 Buraya çağır</button>
            </div>
          </div>
          <div class="msgs"></div>
          <form><input maxlength="1000" placeholder="Mesaj yaz…" autocomplete="off"><button class="send">➤</button></form>
        </div>
        <div class="toasts"></div>
        <button class="fab" title="Ortak İzle">💬<span class="badge"></span><span class="st"></span></button>
      `;
      const q = (s) => root.querySelector(s);
      this.els = {
        panel: q('.panel'),
        who: q('.who'),
        msgs: q('.msgs'),
        form: q('form'),
        input: q('input'),
        toasts: q('.toasts'),
        fab: q('.fab'),
        badge: q('.badge'),
        st: q('.st'),
      };
      this.host = host;
      this.root = root;

      this.els.fab.onclick = () => this.toggle();
      q('.x').onclick = () => this.toggle(false);
      q('.sync').onclick = () => {
        if (!roomState) return this.toast('Odada henüz bir oynatma yok.');
        if (!video) return this.toast('Bu sayfada video bulunamadı.');
        applyState(roomState, true);
        this.toast(`Senkronlandı: ${fmt(expectedTime(roomState))}`);
      };
      q('.invite').onclick = () => {
        post({ t: 'invite', url: location.href, title: cleanTitle(document.title) });
        this.toast('Davet gönderildi.');
      };
      this.els.form.onsubmit = (e) => {
        e.preventDefault();
        const text = this.els.input.value.trim();
        if (!text) return;
        post({ t: 'chat', text });
        this.els.input.value = '';
      };

      this.mount();
      document.addEventListener('fullscreenchange', () => this.mount());
      document.addEventListener('webkitfullscreenchange', () => this.mount());
      this.setStatus();
    },

    // Tam ekranda sadece tam ekran öğesinin içi görünür; arayüzü oraya taşı.
    mount() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
      if (this.host.parentNode !== parent) parent.appendChild(this.host);
    },

    toggle(open = !panelOpen) {
      panelOpen = open;
      this.els.panel.classList.toggle('open', open);
      if (open) {
        unread = 0;
        this.updateBadge();
        this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
        setTimeout(() => this.els.input.focus(), 50);
      }
    },

    updateBadge() {
      this.els.badge.style.display = unread ? 'block' : 'none';
      this.els.badge.textContent = unread > 9 ? '9+' : String(unread);
    },

    setStatus() {
      if (!this.host) return;
      const on = wsState === 'bağlı';
      this.els.st.classList.toggle('on', on);
      if (!on) {
        this.els.who.textContent =
          wsState === 'bağlanıyor' ? 'Bağlanıyor…' : 'Bağlı değil — eklenti simgesinden ayarları yap.';
        return;
      }
      const others = members.filter((m) => m.id !== me?.id);
      this.els.who.textContent = others.length
        ? 'Odada: ' +
          others
            .map((m) => m.name + (m.url && sameContent(m.url, location.href) ? ' ✓ (burada)' : m.title ? ` (${m.title})` : ''))
            .join(', ')
        : 'Odada şimdilik sadece sen varsın.';
    },

    renderHistory(list) {
      if (!this.host) return;
      this.els.msgs.textContent = '';
      for (const m of list) this.addMsg(m, true);
    },

    addMsg(m, silent = false) {
      const d = document.createElement('div');
      if (m.system) {
        d.className = 'm sys';
        d.textContent = m.text;
      } else {
        d.className = 'm' + (m.from === me?.id ? ' me' : '');
        const b = document.createElement('b');
        b.textContent = m.name;
        d.append(b, document.createTextNode(m.text));
      }
      this.els.msgs.appendChild(d);
      this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
      if (silent || m.from === me?.id) return;
      if (!panelOpen) {
        unread++;
        this.updateBadge();
        if (!m.system) this.toast(`💬 ${m.name}: ${m.text}`, 6000);
      }
    },

    toast(text, ms = 3500) {
      if (!this.host) return;
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = text;
      this.els.toasts.appendChild(t);
      setTimeout(() => t.remove(), ms);
    },

    // Butonlu bildirim: "Ben de aç" / "Başlat"
    offer(text, url, action) {
      if (!this.host) return;
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = text;
      const row = document.createElement('div');
      row.className = 'row';
      const go = document.createElement('button');
      go.className = 'btn go';
      go.textContent = url ? 'Ben de aç' : 'Başlat';
      go.onclick = () => {
        t.remove();
        if (action) action();
        else if (url) location.href = url;
      };
      const no = document.createElement('button');
      no.className = 'btn';
      no.textContent = 'Kapat';
      no.onclick = () => t.remove();
      row.append(go, no);
      t.appendChild(row);
      this.els.toasts.appendChild(t);
      setTimeout(() => t.remove(), 30000);
    },
  };

  function start() {
    ui.init();
    connectPort();
  }

  if (document.documentElement && document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
