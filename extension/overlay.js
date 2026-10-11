// Ortak İzle — eklentinin sayfa içi paneli (bilgisayarda izlerken sohbet ve kumanda).
// Android uygulamasındaki izleme paneliyle aynı tasarım dilini kullanır.

(function () {
  'use strict';
  if (globalThis.OrtakIzleOverlay) return;

  const REACTIONS = ['😂', '😮', '😱', '❤️', '👏', '🔥', '😢', '👀'];
  const ICONS = {
    chat: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 21v-5h-5"/>',
    count: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9.5 2h5"/>',
    call: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>',
    send: '<path d="M4 12 20 4l-4 16-4-7-8-1Z"/><path d="m12 13 8-9"/>',
  };
  const svg = (n) =>
    `<svg viewBox="0 0 24 24" class="i" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root { --velvet-0:#140e10; --velvet-1:#1c1417; --velvet-2:#261b1f; --velvet-3:#33252a; --line:#3b2b30;
      --paper:#f3e7da; --paper-dim:#c4b0a5; --paper-mute:#8f7c75; --ink:#1a1214; --brass:#d6a75b; --brass-hi:#e8be78;
      --ok:#8cc79c; --warn:#e8936a; --bad:#e2606f; --p0:#d6a75b; --p1:#8db8d8; --p2:#9cc59a; --p3:#e39aa8;
      --display:'OI Display','Arial Narrow',sans-serif; --body:'OI Body',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
      --mono:'OI Mono',ui-monospace,Menlo,Consolas,monospace;
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; font: 400 14px/1.45 var(--body); color: var(--paper);
      display: flex; flex-direction: column; align-items: flex-end; gap: 10px; -webkit-font-smoothing: antialiased; }
    button, input { font: inherit; color: inherit; }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
    [hidden] { display: none !important; }
    .i { width: 18px; height: 18px; flex: none; }
    .fab { position: relative; width: 52px; height: 52px; border-radius: 50%; border: 1px solid var(--line);
      background: var(--velvet-1); color: var(--brass); display: grid; place-items: center; box-shadow: 0 8px 24px rgba(0,0,0,.45);
      opacity: .9; transition: opacity .15s, transform .15s; }
    .fab:hover { opacity: 1; transform: translateY(-1px); }
    .fab .i { width: 22px; height: 22px; }
    .fab .st { position: absolute; right: 3px; bottom: 3px; width: 11px; height: 11px; border-radius: 50%;
      background: var(--bad); border: 2px solid var(--velvet-1); }
    .fab .st.ok { background: var(--ok); } .fab .st.warn { background: var(--warn); }
    .fab .n { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
      background: var(--brass); color: var(--ink); font: 700 11px/20px var(--body); text-align: center; }
    .panel { width: 340px; height: min(560px, calc(100vh - 110px)); background: var(--velvet-1); border: 1px solid var(--line);
      border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 50px rgba(0,0,0,.55); }
    .bar { display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 14px; border-bottom: 1px solid var(--line); }
    .bar .t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .bar small { font: 600 11px/1.2 var(--body); letter-spacing: .1em; text-transform: uppercase; color: var(--paper-mute); }
    .bar b { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .x { width: 36px; height: 36px; border-radius: 10px; border: 0; background: transparent; color: var(--paper-dim);
      display: grid; place-items: center; }
    .x:hover { background: var(--velvet-2); color: var(--paper); }
    .sync { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 6px 10px; padding: 12px 14px;
      border-bottom: 1px solid var(--line); }
    .tc { font: 500 26px/1 var(--mono); font-variant-numeric: tabular-nums; }
    .tc span { font-size: 12px; color: var(--paper-mute); margin-left: 4px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 999px;
      font: 600 11px/1 var(--body); background: var(--velvet-2); color: var(--paper-dim); border: 1px solid var(--line); white-space: nowrap; }
    .chip::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .chip.ok { color: var(--ok); } .chip.warn { color: var(--warn); } .chip.bad { color: var(--bad); }
    .who { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--paper-dim); }
    .who span { display: inline-flex; align-items: center; gap: 6px; }
    .who i { width: 8px; height: 8px; border-radius: 50%; background: var(--pc); }
    .tools { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
    .tool { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; border-radius: 10px;
      border: 1px solid var(--line); background: transparent; font: 600 12px/1.1 var(--body); padding: 0 6px; }
    .tool .i { color: var(--brass); width: 16px; height: 16px; }
    .tool:hover { background: var(--velvet-2); }
    .tool[disabled] { opacity: .4; pointer-events: none; }
    .msgs { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 3px;
      overscroll-behavior: contain; }
    .m { display: flex; flex-direction: column; max-width: 86%; align-self: flex-start; }
    .m .meta { display: flex; gap: 8px; align-items: baseline; font-size: 11px; color: var(--paper-mute); margin: 8px 0 2px 2px; }
    .m .meta b { color: var(--pc); font-size: 12px; }
    .m .bb { padding: 7px 11px; border-radius: 4px 14px 14px 14px; background: var(--velvet-2); overflow-wrap: anywhere; white-space: pre-wrap; }
    .m.me { align-self: flex-end; } .m.me .meta { justify-content: flex-end; }
    .m.me .bb { background: var(--brass); color: var(--ink); border-radius: 14px 4px 14px 14px; }
    .m.c .meta { display: none; } .m.c .bb { border-radius: 14px; }
    .sys { align-self: center; font-size: 11px; color: var(--paper-mute); padding: 8px 0 2px; text-align: center; }
    .empty { margin: auto; text-align: center; color: var(--paper-mute); font-size: 12px; max-width: 24ch; }
    .empty b { display: block; font: 800 20px/1.1 var(--display); text-transform: uppercase; letter-spacing: .04em; color: var(--paper-dim); margin-bottom: 4px; }
    .typing { min-height: 18px; padding: 0 14px; font-size: 11px; color: var(--paper-mute); }
    .reacts { display: flex; padding: 4px 8px; border-top: 1px solid var(--line); }
    .reacts button { flex: 1; height: 36px; border: 0; background: transparent; border-radius: 8px; font-size: 19px; line-height: 1; }
    .reacts button:hover { background: var(--velvet-2); }
    form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--line); }
    input { flex: 1; min-width: 0; height: 40px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line);
      background: var(--velvet-2); }
    input::placeholder { color: var(--paper-mute); }
    input:focus { outline: none; border-color: var(--brass); }
    .send { width: 40px; height: 40px; border-radius: 10px; border: 0; background: var(--brass); color: var(--ink); display: grid; place-items: center; }
    .toasts { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: 340px; }
    .root.open .toasts { position: absolute; right: 356px; bottom: 62px; width: 300px; }
    .toast { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; border-radius: 14px; background: var(--velvet-2);
      border: 1px solid var(--line); box-shadow: 0 10px 30px rgba(0,0,0,.45); animation: in .2s ease-out; font-size: 13px; }
    .toast.offer { border-color: rgba(214,167,91,.5); }
    .toast .tt { flex: 1; min-width: 0; }
    .toast .q { display: block; color: var(--paper-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .go { height: 32px; padding: 0 12px; border-radius: 9px; border: 0; background: var(--brass); color: var(--ink); font-weight: 700; white-space: nowrap; }
    .off { padding: 14px; font-size: 13px; color: var(--paper-dim); border-bottom: 1px solid var(--line); }
    .off b { color: var(--paper); }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } }
    @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
  `;

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }
  const clock = (ms) => new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

  function create(opts) {
    const send = opts.send;
    const command = opts.command;
    const sameContent = opts.sameContent;

    let status = null; // arka plandan gelen son durum
    let engine = null; // motorun son durumu
    let open = false;
    let unread = 0;
    let typing = {};

    const host = document.createElement('div');
    host.setAttribute('data-ortak-izle', 'overlay');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="root">
        <div class="toasts"></div>
        <section class="panel" hidden>
          <div class="bar"><div class="t"><small class="pf"></small><b class="title"></b></div>
            <button class="x close" title="Paneli kapat" aria-label="Paneli kapat">${svg('close')}</button></div>
          <div class="off" hidden></div>
          <div class="sync"><div class="tc">0:00<span></span></div><span class="chip"></span><div class="who"></div></div>
          <div class="tools">
            <button class="tool t-sync">${svg('sync')}Senkronla</button>
            <button class="tool t-count">${svg('count')}3-2-1</button>
            <button class="tool t-call">${svg('call')}Çağır</button>
          </div>
          <div class="msgs" role="log" aria-live="polite"></div>
          <div class="typing"></div>
          <div class="reacts"></div>
          <form autocomplete="off"><input maxlength="1000" placeholder="Mesaj yaz" aria-label="Mesaj"><button class="send" aria-label="Gönder">${svg('send')}</button></form>
        </section>
        <button class="fab" title="Ortak İzle" aria-label="Ortak İzle panelini aç">${svg('chat')}<span class="st"></span><span class="n" hidden></span></button>
      </div>`;
    const q = (s) => root.querySelector(s);
    const els = {
      panel: q('.panel'), pf: q('.pf'), title: q('.title'), off: q('.off'), tc: q('.tc'), chip: q('.chip'), who: q('.who'),
      msgs: q('.msgs'), typing: q('.typing'), reacts: q('.reacts'), form: q('form'), input: q('input'), toasts: q('.toasts'),
      fab: q('.fab'), st: q('.st'), n: q('.n'), sync: q('.sync'), tools: q('.tools'),
    };
    for (const e of REACTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.setAttribute('aria-label', 'Tepki: ' + e);
      b.onclick = () => command('react', { emoji: e });
      els.reacts.appendChild(b);
    }

    els.fab.onclick = () => toggle();
    q('.close').onclick = () => toggle(false);
    q('.t-sync').onclick = () => command('resync');
    q('.t-count').onclick = () => command('countdown');
    q('.t-call').onclick = () => {
      send({ t: 'invite', url: location.href, title: engine?.title || document.title });
      toast('Davet gönderildi.');
    };
    let typingSent = 0;
    els.input.addEventListener('input', () => {
      if (Date.now() - typingSent > 3000 && els.input.value.trim()) {
        typingSent = Date.now();
        send({ t: 'typing', on: true });
      }
    });
    els.form.onsubmit = (e) => {
      e.preventDefault();
      const text = els.input.value.trim();
      if (!text) return;
      send({ t: 'chat', text });
      els.input.value = '';
      typingSent = 0;
    };

    // Sohbete yazarken sayfanın kısayolları (boşluk = durdur gibi) çalışmasın
    for (const type of ['keydown', 'keyup', 'keypress']) {
      window.addEventListener(type, (e) => {
        if (e.composedPath().includes(host)) e.stopImmediatePropagation();
      }, true);
    }

    function mount() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
      if (parent && host.parentNode !== parent) parent.appendChild(host);
    }
    document.addEventListener('fullscreenchange', mount);
    document.addEventListener('webkitfullscreenchange', mount);
    setInterval(mount, 2000);
    mount();

    const me = () => status?.room?.me;
    const members = () => status?.room?.members || [];
    const connected = () => status?.wsState === 'bağlı' && !!me();
    function colorOf(id) {
      if (me() && id === me().id) return 'var(--p0)';
      const others = members().filter((m) => !me() || m.id !== me().id);
      const i = others.findIndex((m) => m.id === id);
      return `var(--p${(i < 0 ? 0 : i % 3) + 1})`;
    }

    function toggle(v = !open) {
      open = v;
      els.panel.hidden = !open;
      root.querySelector('.root').classList.toggle('open', open);
      if (open) {
        unread = 0;
        renderBadge();
        els.msgs.scrollTop = els.msgs.scrollHeight;
        setTimeout(() => els.input.focus(), 30);
      }
    }

    function renderBadge() {
      els.n.hidden = !unread;
      els.n.textContent = unread > 9 ? '9+' : String(unread);
    }

    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }

    function renderHistory() {
      const list = status?.room?.history || [];
      const box = els.msgs;
      box.replaceChildren();
      if (!list.length) {
        const e = el('div', 'empty');
        e.append(el('b', null, 'Sessiz salon'), connected() ? 'İlk mesajı sen yaz.' : 'Eklenti simgesinden odaya bağlan.');
        box.append(e);
        return;
      }
      list.forEach((m, i) => appendMsg(m, list[i - 1]));
      box.scrollTop = box.scrollHeight;
    }

    function appendMsg(m, prev) {
      const box = els.msgs;
      box.querySelector('.empty')?.remove();
      if (m.system) {
        box.append(el('div', 'sys', `${clock(m.at)} · ${m.text}`));
        return;
      }
      const mine = me() && m.from === me().id;
      const cont = prev && !prev.system && prev.from === m.from && m.at - prev.at < 120000;
      const d = el('div', `m${mine ? ' me' : ''}${cont ? ' c' : ''}`);
      d.style.setProperty('--pc', colorOf(m.from));
      const meta = el('div', 'meta');
      meta.append(el('b', null, mine ? 'Sen' : m.name), el('span', null, clock(m.at)));
      d.append(meta, el('div', 'bb', m.text));
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      box.append(d);
      if (atBottom || mine) box.scrollTop = box.scrollHeight;
    }

    function render() {
      const ok = connected();
      els.st.className = 'st ' + (ok ? 'ok' : status?.wsState === 'bağlanıyor' || (status?.wsState === 'hata' && status?.lastError) ? 'warn' : '');
      els.off.hidden = ok;
      els.sync.hidden = !ok;
      els.tools.hidden = !ok;
      if (!ok) {
        els.off.replaceChildren();
        const b = el('b', null, status?.wsState === 'bağlanıyor' ? 'Bağlanıyor… ' : 'Odaya bağlı değilsin. ');
        els.off.append(b, status?.lastError || 'Tarayıcının üst çubuğundaki Ortak İzle simgesine tıklayıp sunucu adresini yaz.');
      }
      els.pf.textContent = engine?.platform || '';
      els.title.textContent = engine?.title || 'Ortak İzle';
      renderSync();
    }

    function renderSync() {
      if (!connected()) return;
      const st = status.room.state;
      const offset = status.clockOffset || 0;
      const exp = st ? (st.paused ? st.time : st.time + Math.max(0, Date.now() + offset - st.at) / 1000) : 0;
      els.tc.firstChild.textContent = fmt(engine?.hasVideo ? engine.time : exp);
      els.tc.lastChild.textContent = engine?.hasVideo && engine.duration ? `/ ${fmt(engine.duration)}` : '';
      const others = members().filter((m) => m.id !== me().id);
      const waiting = others.find((m) => m.buffering);
      let cls = 'ok';
      let txt = 'Senkron';
      if (!engine?.hasVideo) [cls, txt] = ['', engine?.watching ? 'Video yükleniyor' : 'Bölüm seç'];
      else if (engine.buffering) [cls, txt] = ['warn', 'Sen yükleniyorsun'];
      else if (waiting) [cls, txt] = ['warn', `${waiting.name} yükleniyor`];
      else if (!others.length) [cls, txt] = ['', 'Salonda yalnızsın'];
      else if (st && st.url && !sameContent(st.url, location.href)) [cls, txt] = ['warn', 'Farklı bölümdesiniz'];
      else {
        const drift = st ? Math.abs(exp - engine.time) : 0;
        if (drift > 2.5 && !engine.paused) [cls, txt] = ['warn', `${drift.toFixed(0)} sn fark`];
        else txt = engine.paused ? 'Senkron · duraklatıldı' : 'Senkron';
      }
      els.chip.className = 'chip ' + cls;
      els.chip.textContent = txt;
      els.who.replaceChildren(
        ...members().map((m) => {
          const mine = m.id === me().id;
          const same = mine ? !!engine?.hasVideo : m.url && sameContent(m.url, location.href);
          const s = el('span', null);
          s.style.setProperty('--pc', colorOf(m.id));
          s.append(el('i'), `${mine ? 'Sen' : m.name} · ${m.buffering ? 'yükleniyor' : same ? 'burada' : m.title || 'salonda'}`);
          return s;
        })
      );
      q('.t-count').disabled = !engine?.hasVideo;
      q('.t-sync').disabled = !engine?.hasVideo;
      const names = Object.values(typing).filter((v) => v.until > Date.now()).map((v) => v.name);
      els.typing.textContent = names.length ? `${names.join(', ')} yazıyor…` : '';
    }
    setInterval(renderSync, 1000);

    function toast(content, action) {
      const t = el('div', `toast${action ? ' offer' : ''}`);
      const body = el('div', 'tt');
      if (typeof content === 'string') body.textContent = content;
      else body.append(...content);
      t.append(body);
      const close = () => t.remove();
      if (action) {
        const go = el('button', 'go', action.label);
        go.onclick = () => (close(), action.run());
        const x = el('button', 'x');
        x.innerHTML = svg('close');
        x.setAttribute('aria-label', 'Kapat');
        x.onclick = close;
        t.append(go, x);
      }
      while (els.toasts.children.length >= 3) els.toasts.firstElementChild.remove();
      els.toasts.append(t);
      setTimeout(close, action ? 20000 : 3500);
    }

    function offer(member) {
      if (!member.url || (me() && member.id === me().id) || sameContent(member.url, location.href)) return;
      const what = member.title || member.platform || member.url;
      if (status?.autoFollow) {
        toast(`${member.name} ${what} açtı. Sen de geçiyorsun…`);
        setTimeout(() => (location.href = member.url), 1200);
        return;
      }
      const b = el('b', null, member.name);
      toast([b, ` ${member.platform || ''} açtı`, el('span', 'q', what)], { label: 'Sen de aç', run: () => (location.href = member.url) });
    }

    function receive(m) {
      switch (m.t) {
        case 'status':
          status = m;
          typing = {};
          render();
          renderHistory();
          break;
        case 'welcome':
          break; // ardından gelen status her şeyi çizer
        case 'member-join':
        case 'member-leave':
        case 'buffer':
          if (status) {
            const list = members().filter((x) => x.id !== m.member.id);
            if (m.t !== 'member-leave') list.push(m.member);
            status.room.members = list;
          }
          if (m.t === 'member-join') toast(`${m.member.name} salona girdi.`);
          if (m.t === 'member-leave') toast(`${m.member.name} salondan çıktı.`);
          render();
          break;
        case 'nav':
          if (status) status.room.members = members().map((x) => (x.id === m.member.id ? m.member : x));
          if (m.watching) offer(m.member);
          render();
          break;
        case 'invite':
          if (!sameContent(m.url, location.href)) {
            toast([el('b', null, m.name), ' seni çağırıyor', el('span', 'q', m.title || m.url)], {
              label: 'Aç',
              run: () => (location.href = m.url),
            });
          }
          break;
        case 'chat': {
          if (status) {
            const h = status.room.history;
            const prev = h[h.length - 1];
            h.push(m);
            if (h.length > 100) h.shift();
            appendMsg(m, prev);
          }
          if (m.from) delete typing[m.from];
          if (!open && m.from && m.from !== me()?.id) {
            unread++;
            renderBadge();
            toast([el('b', null, m.name), ': ' + m.text]);
          }
          break;
        }
        case 'typing':
          if (m.on) typing[m.from] = { name: m.name, until: Date.now() + 6000 };
          else delete typing[m.from];
          renderSync();
          break;
        case 'sync':
        case 'tick':
        case 'countdown':
          if (status) status.room.state = { paused: m.t === 'countdown' ? false : m.paused, time: m.time, at: m.at, url: m.url, by: m.by || m.from };
          if (m.t === 'countdown') toast(`${m.name} geri sayım başlattı.`);
          renderSync();
          break;
        case 'clock':
          if (status) status.clockOffset = m.offset;
          break;
      }
    }

    return {
      receive,
      toast,
      engine(e) {
        engine = e;
        render();
      },
      localState(st) {
        if (status) status.room.state = st;
      },
    };
  }

  globalThis.OrtakIzleOverlay = { create };
})();
