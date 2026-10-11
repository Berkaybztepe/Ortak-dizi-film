// Ortak İzle — arayüz mantığı.
// Üç ortamda çalışır:
//   app  : Android uygulaması (window.OrtakNative köprüsü var, oynatıcı ayrı bir WebView'da)
//   web  : sunucunun kendi sayfası (tarayıcıdan sohbet + kim ne izliyor)
//   demo : ?demo=... ile sahte verili önizleme (tasarım ve test için)

(function () {
  'use strict';

  // Eski Android WebView'lar (Chrome 86 öncesi) için
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function (...nodes) {
      while (this.firstChild) this.removeChild(this.firstChild);
      this.append(...nodes);
    };
  }

  const { RoomClient, displayAddress, isCode, normalizeCode, formatCode, newCode } = window.OrtakIzleRoom;
  const params = new URLSearchParams(location.search);
  const DEMO = params.get('demo');
  const N = window.OrtakNative || null;
  const ENV = N ? 'app' : DEMO ? 'demo' : 'web';

  // ---------------------------------------------------------------- yardımcılar
  const $ = (id) => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'i');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }
  // Türkçe iyelik eki: Berkay'ın, Ayşe'nin, Umut'un, Gönül'ün
  function possessive(name) {
    const n = String(name).trim();
    const vowels = n.toLocaleLowerCase('tr-TR').match(/[aeıioöuü]/g);
    const v = vowels ? vowels[vowels.length - 1] : 'e';
    const suf = { a: 'ın', ı: 'ın', e: 'in', i: 'in', o: 'un', u: 'un', ö: 'ün', ü: 'ün' }[v];
    const endsVowel = /[aeıioöuü]$/i.test(n.toLocaleLowerCase('tr-TR'));
    return `${n}'${endsVowel ? 'n' : ''}${suf}`;
  }
  const clock = (ms) => new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const initial = (name) => (name || '?').trim().charAt(0).toLocaleUpperCase('tr-TR') || '?';
  function sameContent(a, b) {
    if (!a || !b) return false;
    try {
      const x = new URL(a);
      const y = new URL(b);
      if (x.hostname.replace(/^www\./, '') !== y.hostname.replace(/^www\./, '')) return false;
      if (/youtube/.test(x.hostname)) return x.searchParams.get('v') === y.searchParams.get('v');
      const norm = (p) => p.replace(/\/$/, '').replace(/^\/[a-z]{2}(-[a-z]{2})?(?=\/)/i, '');
      return norm(x.pathname) === norm(y.pathname);
    } catch {
      return false;
    }
  }

  // Yerel ayarlar
  // lastCode: en son katılınan oda kodu, hostCode: bu cihazda açılan odanın kalıcı kodu
  const DEFAULTS = { name: '', lastServer: '', lastCode: '', hostCode: '', room: 'salon', password: '', autoFollow: false, desktop: true, awake: true };
  const settings = (() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ortak-izle') || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  })();
  function save() {
    try {
      localStorage.setItem('ortak-izle', JSON.stringify(settings));
    } catch {}
  }

  // Yerel (Android) köprü — tüm çağrılar güvenli
  const native = {
    call(fn, ...args) {
      if (!N || typeof N[fn] !== 'function') return null;
      try {
        return N[fn](...args.map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a)));
      } catch (e) {
        console.warn('OrtakNative.' + fn, e);
        return null;
      }
    },
    json(fn, ...args) {
      const r = this.call(fn, ...args);
      try {
        return r ? JSON.parse(r) : null;
      } catch {
        return null;
      }
    },
  };

  const PLATFORMS = [
    { id: 'disney', name: 'Disney+', url: 'https://www.disneyplus.com/', sub: 'Disney, Marvel, Star Wars' },
    { id: 'hbo', name: 'HBO Max', url: 'https://play.hbomax.com/', sub: 'HBO, Warner Bros.' },
    { id: 'apple', name: 'Apple TV+', url: 'https://tv.apple.com/', sub: 'Apple Originals' },
    { id: 'prime', name: 'Prime Video', url: 'https://www.primevideo.com/', sub: 'Amazon' },
    { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', sub: 'Denemek için ideal' },
    { id: 'netflix', name: 'Netflix', url: 'https://www.netflix.com/', sub: 'Yalnızca bilgisayar eklentisiyle', appOff: true },
  ];
  const REACTIONS = ['😂', '😮', '😱', '❤️', '👏', '🔥', '😢', '👀'];

  // ---------------------------------------------------------------- durum
  const ui = {
    view: 'welcome', // welcome | lobby | watch
    layout: 'full', // full | side | bottom | float
    tab: 'room',
    showSettings: false,
    unread: 0,
    engine: null, // oynatıcıdan gelen son durum
    playerOpen: false,
    found: [],
    host: null, // {hosting, port, addresses:[{label,address}]}
    joinedAt: null,
    rtt: null,
    lastNav: {}, // üye id -> zaman
    watching: {}, // üye id -> izleme sayfasında mı (sitenin bildirdiği)
    connecting: false,
  };

  const client = new RoomClient({ kind: ENV === 'app' ? 'app' : 'web', onEvent: onRoomEvent });

  // ---------------------------------------------------------------- sohbet bileşeni
  const chat = (() => {
    const node = $('chatTpl').content.firstElementChild.cloneNode(true);
    const q = (s) => node.querySelector(`[data-${s}]`);
    const els = { people: q('people'), msgs: q('msgs'), typing: q('typing'), reacts: q('reacts'), form: q('form'), input: q('input') };
    for (const e of REACTIONS) {
      els.reacts.append(
        h('button', { type: 'button', title: 'Tepki gönder', 'aria-label': `Tepki: ${e}`, onclick: () => react(e) }, e)
      );
    }
    let typingSent = 0;
    els.input.addEventListener('input', () => {
      if (Date.now() - typingSent > 3000 && els.input.value.trim()) {
        typingSent = Date.now();
        client.send({ t: 'typing', on: true });
      }
    });
    els.input.addEventListener('blur', () => {
      if (typingSent) {
        typingSent = 0;
        client.send({ t: 'typing', on: false });
      }
    });
    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = els.input.value.trim();
      if (!text) return;
      if (!client.send({ t: 'chat', text })) return toast('Mesaj gönderilemedi: bağlantı yok.');
      els.input.value = '';
      typingSent = 0;
    });
    return { node, els };
  })();

  function react(emoji) {
    if (ui.playerOpen) native.call('toPlayer', { t: 'cmd', cmd: 'react', emoji });
    else client.send({ t: 'react', emoji });
  }

  function colorOf(id) {
    if (client.me && id === client.me.id) return 'var(--p0)';
    const others = client.members.filter((m) => !client.me || m.id !== client.me.id);
    const i = others.findIndex((m) => m.id === id);
    return `var(--p${(i < 0 ? 0 : i % 3) + 1})`;
  }

  function avatar(member, cls = '', badge) {
    return h(
      'span',
      { class: `avatar ${cls}`, style: `--pc:${colorOf(member.id)}`, title: member.name },
      initial(member.name),
      badge ? h('span', { class: `badge ${badge}` }) : null
    );
  }

  function renderPeople(container, cls = 'sm') {
    container.replaceChildren(...client.members.map((m) => avatar(m, cls)));
  }

  let renderedHistory = 0;
  let renderedFirst = null;
  function renderMessages() {
    const box = chat.els.msgs;
    const list = client.history;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    // Geçmiş başından kırpıldıysa ya da yeni oda: tamamen yeniden çiz
    if (renderedFirst !== list[0] || renderedHistory > list.length) {
      box.replaceChildren();
      renderedHistory = 0;
      renderedFirst = list[0] || null;
    }
    if (!list.length) {
      box.replaceChildren(
        h(
          'div',
          { class: 'empty-chat' },
          h('b', null, 'Henüz mesaj yok'),
          client.me ? 'İlk mesajı sen yaz. Tepkiler videonun üstünde uçuşur.' : 'Bir odaya girince mesajlar burada görünür.'
        )
      );
      return;
    }
    if (renderedHistory === 0) box.replaceChildren();
    for (let i = renderedHistory; i < list.length; i++) {
      const m = list[i];
      const prev = list[i - 1];
      if (m.system) {
        box.append(h('div', { class: 'sys' }, h('span', { class: 'mono' }, clock(m.at)), ' · ', m.text));
        continue;
      }
      const mine = client.me && m.from === client.me.id;
      const cont = prev && !prev.system && prev.from === m.from && m.at - prev.at < 120000;
      box.append(
        h(
          'div',
          { class: `msg${mine ? ' mine' : ''}${cont ? ' cont' : ''}`, style: `--pc:${colorOf(m.from)}` },
          h('div', { class: 'meta' }, h('b', null, mine ? 'Sen' : m.name), h('span', { class: 'mono' }, clock(m.at))),
          h('div', { class: 'bubble' }, m.text)
        )
      );
    }
    renderedHistory = list.length;
    if (atBottom || list[list.length - 1]?.from === client.me?.id) box.scrollTop = box.scrollHeight;
  }

  function renderTyping() {
    const names = client.typingNames();
    chat.els.typing.textContent = names.length ? `${names.join(', ')} yazıyor…` : '';
  }
  setInterval(renderTyping, 1500);

  function chatVisible() {
    if (ui.view === 'watch') return ui.layout === 'side' || ui.layout === 'bottom';
    if (ui.view !== 'lobby') return false;
    return !window.matchMedia('(max-width: 820px)').matches || ui.tab === 'chat';
  }

  // ---------------------------------------------------------------- bildirimler
  function toast(content, opts = {}) {
    const box = ui.layout === 'float' ? $('fToasts') : $('toasts');
    const t = h('div', { class: `toast${opts.action ? ' offer' : ''}`, role: 'status' });
    if (opts.url) t.dataset.url = opts.url;
    const body = h('div', { class: 't' });
    if (typeof content === 'string') body.textContent = content;
    else body.append(...content);
    t.append(body);
    const close = () => {
      t.remove();
      reportFloatSize();
    };
    if (opts.action) {
      t.append(
        h('button', { class: 'btn primary sm', onclick: () => (close(), opts.action.run()) }, opts.action.label),
        h('button', { class: 'btn quiet icon sm', 'aria-label': 'Kapat', onclick: close }, icon('close'))
      );
    }
    while (box.children.length >= 3) box.firstElementChild.remove();
    box.append(t);
    setTimeout(close, opts.ms || (opts.action ? 20000 : 3500));
    reportFloatSize();
  }

  // ---------------------------------------------------------------- oda olayları
  // Oynatıcı sayfası güvenilmez (dizi sitesinin kodu da orada çalışıyor): yalnızca
  // senkron için gereken bilgiyi gönder, sohbet metinlerini gönderme.
  const PLAYER_EVENTS = new Set(['status', 'clock', 'welcome', 'member-join', 'member-leave', 'nav', 'buffer', 'state', 'sync', 'tick', 'countdown', 'react']);
  function forPlayer(m) {
    if (m.t !== 'status' && m.t !== 'welcome') return m;
    const room = m.t === 'status' ? m.room : null;
    if (m.t === 'welcome') return { ...m, history: [] };
    return { ...m, room: { ...room, history: [] } };
  }

  function onRoomEvent(m) {
    if (ui.playerOpen && PLAYER_EVENTS.has(m.t)) native.call('toPlayer', forPlayer(m));
    const meId = client.me?.id;
    switch (m.t) {
      case 'status':
        if (m.wsState === 'bağlı' && !ui.joinedAt) ui.joinedAt = Date.now();
        if (m.wsState !== 'bağlı' && !client.config) ui.joinedAt = null;
        render();
        break;
      case 'clock':
        ui.rtt = m.rtt;
        renderTicket();
        break;
      case 'welcome':
        ui.joinedAt = ui.joinedAt || Date.now();
        native.call('stopDiscovery');
        render();
        break;
      case 'error':
        if (m.code === 'password') {
          showJoinError('Şifre yanlış. Ayarlardan oda şifresini gir.');
          settings.lastServer = '';
          save();
        }
        render();
        break;
      case 'chat':
        renderMessages();
        if (m.from && m.from !== meId && !m.system) {
          if (!chatVisible()) {
            ui.unread++;
            renderBadges();
            toast([h('b', null, m.name), ': ', m.text]);
          }
        }
        break;
      case 'typing':
        renderTyping();
        break;
      case 'member-join':
        toast(`${m.member.name} odaya katıldı.`);
        render();
        break;
      case 'member-leave':
        toast(`${m.member.name} odadan çıktı.`);
        render();
        break;
      case 'nav':
        ui.lastNav[m.member.id] = Date.now();
        ui.watching[m.member.id] = !!m.watching;
        render();
        if (m.watching && m.member.url) offerFollow(m.member);
        break;
      case 'invite':
        if (!(ui.playerOpen && ui.engine && sameContent(ui.engine.url, m.url))) {
          toast([h('b', null, m.name), ' seni çağırıyor', h('span', { class: 'q' }, m.title || m.url)], {
            action: { label: 'Aç', run: () => openUrl(m.url) },
            url: m.url,
          });
        }
        break;
      case 'sync':
        if (ui.view === 'watch') {
          const verb = m.action === 'play' ? 'oynattı' : m.action === 'pause' ? 'durdurdu' : `${fmt(m.time)} konumuna sardı`;
          toast(`${m.name} ${verb}.`);
        }
        renderNow();
        renderWatch();
        break;
      case 'tick':
        renderNow();
        break;
      case 'countdown':
        toast(`${m.name} geri sayım başlattı.`);
        break;
      case 'buffer':
        renderWatch();
        break;
    }
  }

  function offerFollow(member) {
    if (client.me && member.id === client.me.id) return;
    if (ui.playerOpen && ui.engine && sameContent(ui.engine.url, member.url)) return;
    const what = member.title || member.platform || 'bir şey';
    if (settings.autoFollow && ENV === 'app') {
      toast(`${member.name} ${what} açtı. Sen de geçiyorsun…`);
      setTimeout(() => openUrl(member.url), 1200);
      return;
    }
    toast([h('b', null, member.name), ` ${member.platform || ''} açtı`, h('span', { class: 'q' }, what)], {
      action: { label: 'Sen de aç', run: () => openUrl(member.url) },
      url: member.url,
    });
  }

  // ---------------------------------------------------------------- oynatıcı
  // Açılan içerikle ilgili eski "Sen de aç" önerilerini kaldır
  function dropOffers(url) {
    for (const t of document.querySelectorAll('.toast[data-url]')) if (sameContent(t.dataset.url, url)) t.remove();
    reportFloatSize();
  }

  function openUrl(url) {
    dropOffers(url);
    if (ENV === 'app') {
      native.call('setDesktopMode', !!settings.desktop);
      native.call('openPlayer', url);
      ui.playerOpen = true;
      ui.engine = null;
      ui.view = 'watch';
      native.call('keepScreenOn', !!settings.awake);
      render();
    } else if (ENV === 'web') {
      window.open(url, '_blank', 'noopener');
    } else {
      ui.view = 'watch';
      render();
    }
  }

  function closePlayer() {
    native.call('closePlayer');
    native.call('keepScreenOn', false);
    ui.playerOpen = false;
    ui.engine = null;
    ui.view = 'lobby';
    render();
  }

  // Oynatıcıdaki motordan gelenler
  function fromPlayer(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hello':
        native.call('toPlayer', forPlayer(client.status()));
        break;
      case 'engine':
        if (m.url && m.url !== ui.engine?.url) dropOffers(m.url);
        ui.engine = m;
        renderWatch();
        break;
      case 'sync':
      case 'tick':
      case 'nav':
      case 'buffer':
      case 'countdown':
      case 'react':
      case 'invite':
      case 'chat':
      case 'typing':
        client.send(m);
        if (m.t === 'nav') renderNow();
        break;
    }
  }

  // ---------------------------------------------------------------- bağlantı
  // Oda koduyla (internet) ya da adresle (aynı ağ) bağlan
  function connectTo(target) {
    hideJoinError();
    const base = { name: settings.name, room: settings.room, password: settings.password };
    if (isCode(target)) {
      settings.lastCode = normalizeCode(target);
      settings.lastServer = '';
      save();
      client.connect({ ...base, code: settings.lastCode });
    } else {
      settings.lastServer = target;
      settings.lastCode = '';
      save();
      client.connect({ ...base, server: target });
    }
    render();
  }

  function startHost() {
    if (!settings.hostCode) {
      settings.hostCode = newCode();
      save();
    }
    const r = native.json('startHost', settings.password || '', settings.name || '', settings.hostCode);
    if (!r || !r.ok) {
      showJoinError(r?.error || 'Oda açılamadı.');
      return;
    }
    ui.host = r;
    // Odayı açan cihaz kendi sunucusuna doğrudan bağlanır
    hideJoinError();
    settings.lastServer = `127.0.0.1:${r.port}`;
    settings.lastCode = '';
    save();
    client.connect({ server: settings.lastServer, name: settings.name, room: settings.room, password: settings.password });
    render();
  }

  // Oda açıkken aracı bağlantısının durumunu (internetten ulaşılabilir mi) yokla
  setInterval(() => {
    if (ENV !== 'app' || !ui.host?.hosting) return;
    const info = native.json('getInfo');
    if (!info) return;
    if (!info.hosting) return window.OI.onHostState(info);
    if (info.online !== ui.host.online || info.addresses?.length !== ui.host.addresses?.length) {
      ui.host = info;
      renderTicket();
    }
  }, 4000);

  function leave() {
    if (ui.playerOpen) closePlayer();
    client.disconnect();
    if (ui.host?.hosting) {
      native.call('stopHost');
      ui.host = null;
    }
    settings.lastServer = '';
    settings.lastCode = '';
    save();
    ui.joinedAt = null;
    render();
    if (ENV === 'app') native.call('startDiscovery');
  }

  function showJoinError(text) {
    $('joinErr').textContent = text;
    $('joinErr').hidden = false;
  }
  function hideJoinError() {
    $('joinErr').hidden = true;
  }

  function currentCode() {
    if (ui.host?.hosting) return ui.host.code || settings.hostCode;
    return client.config?.code || '';
  }

  function inviteText() {
    const code = currentCode();
    if (code) {
      return `Ortak İzle odama gel 🍿\nOda kodu: ${formatCode(code)}\nUygulamada "Oda kodunu yaz" kısmına gir, birlikte izleyelim.`;
    }
    const addrs = (ui.host?.addresses || []).map((a) => `${a.label}: ${a.address}`);
    const server = addrs.length ? addrs.join('\n') : displayAddress(settings.lastServer || location.host);
    return `Ortak İzle odama gel.\nŞu adresle bağlan:\n${server}`;
  }

  async function share() {
    const text = inviteText();
    if (ENV === 'app' && native.call('share', text) !== null) return;
    try {
      if (navigator.share) return await navigator.share({ text });
    } catch {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Adres kopyalandı.');
    } catch {
      toast('Adresi elle kopyala: ' + text.split('\n').pop());
    }
  }

  // ---------------------------------------------------------------- çizim
  function render() {
    const connected = client.state === 'bağlı' && !!client.me;
    if (!settings.name) ui.view = 'welcome';
    else if (ui.view === 'welcome') ui.view = 'lobby';
    if (ui.view === 'watch' && !ui.playerOpen && ENV === 'app') ui.view = 'lobby';

    document.body.className = ui.view === 'watch' ? ui.layout : '';
    const watch = ui.view === 'watch';
    const float = watch && ui.layout === 'float';
    $('vWelcome').hidden = ui.view !== 'welcome';
    $('topbar').hidden = ui.view !== 'lobby';
    $('vLobby').hidden = ui.view !== 'lobby';
    $('tabs').hidden = ui.view !== 'lobby';
    $('vWatch').hidden = !watch || float;
    $('vFloat').hidden = !float;
    $('toasts').hidden = float;

    // Sohbeti doğru yere taşı
    const slot = watch ? $('watchChatSlot') : $('lobbySide');
    if (chat.node.parentNode !== slot) slot.replaceChildren(chat.node);
    chat.els.reacts.hidden = !(watch || ENV === 'web' || ENV === 'demo');

    $('vLobby').dataset.tab = ui.tab;
    for (const b of $('tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));

    // Bağlantı çipi
    const chip = $('connChip');
    chip.className = 'chip ' + (connected ? 'ok' : client.state === 'bağlanıyor' || (client.state === 'hata' && client.config) ? 'warn' : client.state === 'hata' ? 'bad' : '');
    $('connText').textContent = connected
      ? `Bağlı · ${client.members.length} kişi`
      : client.state === 'bağlanıyor'
        ? 'Bağlanıyor…'
        : client.state === 'hata'
          ? client.config
            ? 'Yeniden bağlanıyor…'
            : 'Bağlanamadı'
          : 'Bağlı değil';
    if (client.state === 'hata' && client.error && !connected) {
      showJoinError(client.error);
    }

    $('connectSec').hidden = connected || !!client.config || ENV === 'web';
    $('hostChoice').hidden = ENV !== 'app';
    $('ticketSec').hidden = !connected && !client.config;
    $('settingsSec').hidden = !ui.showSettings;
    for (const el of document.querySelectorAll('[data-app-only]')) el.hidden = ENV !== 'app';

    renderTicket();
    renderNow();
    renderPlatforms();
    renderPeople(chat.els.people);
    renderMessages();
    renderTyping();
    renderBadges();
    renderWatch();
    renderFloat();
  }

  function renderBadges() {
    if (chatVisible()) ui.unread = 0;
    const b = $('tabBadge');
    b.hidden = !ui.unread;
    b.textContent = ui.unread > 9 ? '9+' : String(ui.unread);
    $('fUnread').hidden = !ui.unread;
    $('fUnread').textContent = b.textContent;
  }

  function renderTicket() {
    if ($('ticketSec').hidden) return;
    const connected = client.state === 'bağlı' && !!client.me;
    const owner = ui.host?.hosting ? settings.name : (client.serverName || '').split(' · ')[0];
    $('tkRoom').textContent = owner ? `${possessive(owner)} odası` : 'Ortak oda';
    const tk = $('tkServer');
    tk.className = 'eyebrow';
    if (ui.host?.hosting) {
      tk.replaceChildren(
        h('span', { class: `online${ui.host.online ? ' on' : ''}` }, ui.host.online ? 'Oda açık · internetten ulaşılabilir' : 'Oda açık · internete bağlanıyor…')
      );
    } else tk.textContent = connected ? 'Odadasın' : 'Bağlanıyor…';
    $('tkTime').textContent = ui.joinedAt ? clock(ui.joinedAt) : '—';
    $('tkSeatCount').textContent = connected ? String(client.members.length) : '—';
    $('tkPing').textContent = connected && ui.rtt != null ? `${Math.round(ui.rtt)} ms` : '—';
    $('tkSeats').replaceChildren(
      ...(connected
        ? client.members.map((m) => {
            const where = m.id === client.me.id ? 'sen' : m.buffering ? 'yükleniyor' : m.title ? 'izliyor' : m.kind === 'web' ? 'panelde' : 'odada';
            return h('span', { class: 'seat' }, avatar(m, m.id === client.me.id ? 'sm me' : 'sm'), m.name, h('small', null, where));
          })
        : [h('span', { class: 'seat' }, client.state === 'hata' ? 'Bağlantı bekleniyor…' : 'Bağlanıyor…')])
    );
    const code = currentCode();
    const rows = [];
    if (code) rows.push({ label: 'Oda kodu', address: formatCode(code), cls: 'big' });
    if (ui.host?.hosting) {
      const wifi = (ui.host.addresses || []).find((a) => a.label === 'Wi-Fi');
      if (wifi) rows.push({ label: 'Aynı Wi-Fi için adres', address: wifi.address, cls: 'small' });
    } else if (!code) {
      rows.push({ label: 'Oda adresi', address: displayAddress(settings.lastServer || location.host) });
    }
    $('tkAddrs').replaceChildren(
      ...rows.map((a) => h('div', { class: `addr ${a.cls || ''}` }, h('span', { class: 'k' }, a.label), h('span', { class: 'v' }, a.address)))
    );
    $('shareBtn').hidden = !code && ENV !== 'web';
    $('leaveTxt').textContent = ui.host?.hosting ? 'Odayı kapat' : 'Ayrıl';
    $('leaveBtn').hidden = ENV === 'web';
  }

  // "Şu an izlenen": başka biri izleme sayfasındaysa
  function renderNow() {
    const card = $('nowCard');
    const meId = client.me?.id;
    const watching = client.members
      .filter((m) => m.id !== meId && m.url && m.title !== undefined && isWatchish(m))
      .sort((a, b) => (ui.lastNav[b.id] || 0) - (ui.lastNav[a.id] || 0))[0];
    if (!watching || ui.view !== 'lobby') {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const av = $('nowAvatar');
    av.textContent = initial(watching.name);
    av.style.setProperty('--pc', colorOf(watching.id));
    $('nowWho').textContent = `${watching.name} izliyor${watching.platform ? ' · ' + watching.platform : ''}`;
    $('nowWhat').textContent = watching.title || 'Bir bölüm açık';
    const st = client.roomState;
    $('nowTc').textContent =
      st && st.url && sameContent(st.url, watching.url)
        ? `${fmt(client.expectedTime(st))} · ${st.paused ? 'duraklatıldı' : 'oynuyor'}`
        : watching.buffering
          ? 'yükleniyor'
          : 'henüz başlamadı';
    $('nowBtn').textContent = ENV === 'web' ? 'Sitede aç' : 'Sen de aç';
    $('nowBtn').onclick = () => openUrl(watching.url);
  }
  const WATCH_RE = [/disneyplus\.com\/.*(play|video)\//, /(hbo)?max\.com\/.*(video\/watch|player)/, /tv\.apple\.com\/.*(episode|movie|show)/, /netflix\.com\/watch\//, /(primevideo|amazon)\.[^/]+\/.*(detail|watch|gp\/video)/, /youtube\.com\/watch/];
  const isWatchish = (m) => (m.id in ui.watching ? ui.watching[m.id] : WATCH_RE.some((r) => r.test(m.url)));
  setInterval(() => ui.view === 'lobby' && !$('nowCard').hidden && renderNow(), 1000);

  let platformsBuilt = false;
  function renderPlatforms() {
    if (platformsBuilt) return;
    platformsBuilt = true;
    const grid = $('platforms');
    for (const p of PLATFORMS) {
      const off = ENV === 'app' && p.appOff;
      grid.append(
        h(
          'button',
          {
            class: `pf${off ? ' off' : ''}`,
            'data-p': p.id,
            type: 'button',
            'aria-disabled': off ? 'true' : null,
            onclick: () => (off ? toast('Netflix uygulama içinde oynatmaya izin vermiyor. Bilgisayarda Ortak İzle eklentisiyle kullan.') : openUrl(p.url)),
          },
          h('span', { class: 'nm', lang: 'en' }, p.name),
          h('span', { class: 'sub' }, p.sub)
        )
      );
    }
    // Listede olmayan siteler (Exxen, TOD, Gain, tabii …)
    const form = h('form', { class: 'pf', 'data-p': 'custom', autocomplete: 'off' });
    const input = h('input', {
      class: 'input mono',
      id: 'customUrl',
      placeholder: 'site adresi',
      'aria-label': 'Başka bir site adresi',
      inputmode: 'url',
      autocapitalize: 'off',
      spellcheck: 'false',
      style: 'min-height:38px;background:var(--velvet-2)',
    });
    form.append(h('span', { class: 'nm' }, 'Başka site'), input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let v = input.value.trim();
      if (!v) return input.focus();
      if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
      try {
        openUrl(new URL(v).href);
      } catch {
        toast('Adres geçersiz. Örnek: exxen.com');
      }
    });
    grid.append(form);
    if (ENV === 'web') $('pfHint').textContent = 'Senkron için uygulama ya da bilgisayar eklentisi gerekir.';
  }

  function renderWatch() {
    if (ui.view !== 'watch') return;
    const e = ui.engine;
    const meId = client.me?.id;
    $('wPlatform').textContent = e?.platform || 'Oynatıcı';
    $('wTitle').textContent = e?.title || (e?.watching ? 'Bölüm' : 'Bir bölüm seç');
    const st = client.roomState;
    const tc = e?.hasVideo ? e.time : st ? client.expectedTime(st) : 0;
    $('wTc').firstChild.textContent = fmt(tc);
    $('wDur').textContent = e?.hasVideo && e.duration ? `/ ${fmt(e.duration)}` : '';

    const others = client.members.filter((m) => m.id !== meId);
    const waiting = others.filter((m) => m.buffering);
    let cls = '';
    let txt = 'Video bekleniyor';
    if (client.state !== 'bağlı') {
      cls = 'bad';
      txt = 'Bağlantı yok';
    } else if (!e?.hasVideo) {
      cls = '';
      txt = e?.watching ? 'Video yükleniyor' : 'Bölüm seç';
    } else if (e.buffering) {
      cls = 'warn';
      txt = 'Sen yükleniyorsun';
    } else if (waiting.length) {
      cls = 'warn';
      txt = `${waiting[0].name} yükleniyor`;
    } else if (!others.length) {
      cls = '';
      txt = 'Odada yalnızsın';
    } else if (st && st.url && e.url && !sameContent(st.url, e.url)) {
      cls = 'warn';
      txt = 'Farklı bölümdesiniz';
    } else {
      const drift = st ? Math.abs(client.expectedTime(st) - e.time) : 0;
      cls = drift > 2.5 && !e.paused ? 'warn' : 'ok';
      txt = cls === 'warn' ? `${drift.toFixed(0)} sn fark` : e.paused ? 'Senkron · duraklatıldı' : 'Senkron';
    }
    $('wChip').className = 'chip ' + cls;
    $('wChipTxt').textContent = txt;

    $('wWho').replaceChildren(
      ...client.members.map((m) => {
        const mine = m.id === meId;
        const same = mine ? !!e?.hasVideo : m.url && e?.url && sameContent(m.url, e.url);
        const where = m.buffering ? 'yükleniyor' : same ? 'burada' : m.title ? m.title : m.kind === 'web' ? 'panelde' : 'odada';
        return h('span', { style: `--pc:${colorOf(m.id)}` }, h('i'), `${mine ? 'Sen' : m.name} · ${where}`);
      })
    );
    $('tCount').disabled = !e?.hasVideo || client.state !== 'bağlı';
    $('tResync').disabled = !e?.hasVideo;
    $('tCall').disabled = !e?.url || client.state !== 'bağlı';
  }
  setInterval(() => ui.view === 'watch' && renderWatch(), 1000);

  function renderFloat() {
    if (ui.layout !== 'float' || ui.view !== 'watch') return;
    renderPeople($('fPeople'));
    reportFloatSize();
  }

  let lastFloat = '';
  function reportFloatSize() {
    if (ENV !== 'app' || ui.layout !== 'float' || ui.view !== 'watch') return;
    requestAnimationFrame(() => {
      const r = $('vFloat').getBoundingClientRect();
      const w = Math.ceil(r.width + 24);
      const hgt = Math.ceil(r.height + 24);
      const key = `${w}x${hgt}`;
      if (key === lastFloat) return;
      lastFloat = key;
      native.call('setFloatSize', w, hgt);
    });
  }

  // ---------------------------------------------------------------- olay bağlama
  $('nameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('nameInput').value.trim();
    if (!v) return;
    settings.name = v.slice(0, 30);
    save();
    ui.view = 'lobby';
    boot();
  });
  $('codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('codeInput').value;
    if (!isCode(v)) {
      showJoinError('Oda kodu 6 harf/rakamdan oluşur, örneğin K7M-4QX.');
      return $('codeInput').focus();
    }
    connectTo(normalizeCode(v));
  });
  $('codeInput').addEventListener('input', (e) => {
    const n = normalizeCode(e.target.value).slice(0, 6);
    const f = n.length > 3 ? `${n.slice(0, 3)}-${n.slice(3)}` : n;
    if (e.target.value !== f) e.target.value = f;
  });
  $('newCodeBtn').addEventListener('click', () => {
    settings.hostCode = newCode();
    save();
    if (ui.host?.hosting) {
      const r = native.json('startHost', settings.password || '', settings.name || '', settings.hostCode);
      if (r?.ok) ui.host = r;
    }
    renderTicket();
    $('codeHint').textContent = `Yeni kod: ${formatCode(settings.hostCode)}. Kardeşine yeniden göndermeyi unutma.`;
  });
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('addrInput').value.trim();
    if (!v) return $('addrInput').focus();
    connectTo(v);
  });
  $('hostBtn').addEventListener('click', startHost);
  $('leaveBtn').addEventListener('click', leave);
  $('shareBtn').addEventListener('click', share);
  $('settingsBtn').addEventListener('click', () => {
    ui.showSettings = !ui.showSettings;
    ui.tab = 'room';
    render();
    if (ui.showSettings) $('settingsSec').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('settingsClose').addEventListener('click', () => {
    ui.showSettings = false;
    render();
  });
  $('setFollow').checked = settings.autoFollow;
  $('setDesktop').checked = settings.desktop;
  $('setAwake').checked = settings.awake;
  $('setFollow').addEventListener('change', (e) => ((settings.autoFollow = e.target.checked), save()));
  $('setDesktop').addEventListener('change', (e) => {
    settings.desktop = e.target.checked;
    save();
    native.call('setDesktopMode', settings.desktop);
  });
  $('setAwake').addEventListener('change', (e) => ((settings.awake = e.target.checked), save()));
  $('renameInput').value = settings.name;
  $('renameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('renameInput').value.trim();
    if (!v) return;
    settings.name = v.slice(0, 30);
    save();
    if (client.config) client.connect({ ...client.config, name: settings.name });
    toast('Adın kaydedildi.');
  });
  $('passInput').value = settings.password;
  $('passForm').addEventListener('submit', (e) => {
    e.preventDefault();
    settings.password = $('passInput').value;
    save();
    if (client.config && !ui.host?.hosting) client.connect({ ...client.config, password: settings.password });
    toast(settings.password ? 'Şifre kaydedildi.' : 'Şifre kaldırıldı.');
  });
  for (const b of $('tabs').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      ui.tab = b.dataset.tab;
      render();
      if (ui.tab === 'chat') chat.els.msgs.scrollTop = chat.els.msgs.scrollHeight;
    });
  }
  $('homeBtn').addEventListener('click', closePlayer);
  $('collapseBtn').addEventListener('click', () => native.call('setPanel', 'closed'));
  $('fOpen').addEventListener('click', () => native.call('setPanel', 'open'));
  $('tResync').addEventListener('click', () => native.call('toPlayer', { t: 'cmd', cmd: 'resync' }));
  $('tCount').addEventListener('click', () => native.call('toPlayer', { t: 'cmd', cmd: 'countdown' }));
  $('tCall').addEventListener('click', () => {
    if (!ui.engine?.url) return;
    client.send({ t: 'invite', url: ui.engine.url, title: ui.engine.title });
    toast('Davet gönderildi.');
  });
  window.addEventListener('resize', () => render());

  // ---------------------------------------------------------------- yerel köprü girişleri
  window.OI = {
    fromPlayer(m) {
      fromPlayer(typeof m === 'string' ? JSON.parse(m) : m);
    },
    setLayout(l) {
      const o = typeof l === 'string' ? JSON.parse(l) : l;
      ui.layout = o.mode || 'full';
      lastFloat = '';
      render();
    },
    onDiscovered(list) {
      ui.found = (typeof list === 'string' ? JSON.parse(list) : list) || [];
      renderFound();
    },
    onHostState(s) {
      const was = ui.host?.hosting;
      ui.host = typeof s === 'string' ? JSON.parse(s) : s;
      // Oda bildirimden kapatıldıysa kapalı sunucuya bağlanmaya çalışmayı bırak
      if (was && !ui.host?.hosting) {
        leave();
        toast('Oda kapatıldı.');
        return;
      }
      render();
    },
    onPlayerClosed() {
      ui.playerOpen = false;
      ui.engine = null;
      ui.view = 'lobby';
      native.call('keepScreenOn', false);
      render();
    },
    onResume() {
      // Uygulama arka plandan dönünce bağlantıyı tazele, gerekirse ağ taramasını sürdür
      if (client.config && client.state !== 'bağlı') client.connect(client.config);
      if (ENV === 'app' && !client.config) native.call('startDiscovery');
    },
  };

  function renderFound() {
    const list = $('foundList');
    const items = ui.found.filter((f) => !(ui.host?.hosting && f.self));
    list.replaceChildren(
      ...items.map((f) =>
        h(
          'button',
          { type: 'button', onclick: () => connectTo(`${f.host}:${f.port}`) },
          h('span', { class: 'avatar sm', style: '--pc:var(--p1)' }, initial(f.name)),
          h('span', null, h('span', { class: 'nm' }, f.name), h('br'), h('span', { class: 'ad' }, `${f.host}:${f.port}`)),
          h('span', { class: 'go' }, 'Katıl')
        )
      )
    );
    $('scanNote').hidden = ENV !== 'app';
    $('scanNote').lastElementChild.textContent = items.length ? 'Aramaya devam ediliyor…' : 'Aynı ağdaki odalar aranıyor…';
  }

  // ---------------------------------------------------------------- açılış
  function boot() {
    if (ENV === 'demo') return demo(DEMO);
    if (!settings.name) {
      ui.view = 'welcome';
      render();
      setTimeout(() => $('nameInput').focus(), 100);
      return;
    }
    ui.view = 'lobby';
    if (ENV === 'web') {
      connectTo(location.host);
      return;
    }
    // Sistem tarayıcısı (Android System WebView) çok eskiyse uyar: dizi siteleri açılmayabilir
    const chromeMajor = +((navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || 0);
    if (chromeMajor && chromeMajor < 100) {
      toast(
        [h('b', null, 'Android System WebView eski'), h('span', { class: 'q' }, `Sürüm ${chromeMajor}. Play Store'dan güncelle, yoksa diziler açılmayabilir.`)],
        { action: { label: 'Tamam', run: () => {} }, ms: 30000 }
      );
    }
    // Android: oda bu cihazda açıksa ona, değilse son sunucuya bağlan
    const info = native.json('getInfo');
    if (info?.hosting) {
      ui.host = info;
      connectTo(`127.0.0.1:${info.port}`);
    } else if (settings.lastCode) {
      connectTo(settings.lastCode);
    } else if (settings.lastServer && !/^127\.0\.0\.1|^localhost/.test(settings.lastServer)) {
      connectTo(settings.lastServer);
    } else {
      render();
      native.call('startDiscovery');
      renderFound();
    }
    if (settings.lastServer) $('addrInput').value = displayAddress(settings.lastServer);
    if (settings.lastCode) $('codeInput').value = formatCode(settings.lastCode);
  }

  // ---------------------------------------------------------------- önizleme verisi
  function demo(kind) {
    settings.name = settings.name || 'Berkay';
    const now = Date.now();
    const me = { id: 'me', name: 'Berkay', kind: 'app', url: null, title: '', platform: '' };
    const sis = {
      id: 'k1',
      name: 'Kardeş',
      kind: 'app',
      url: 'https://play.hbomax.com/video/watch/1/2',
      title: 'The Last of Us · 2. Sezon 3. Bölüm',
      platform: 'HBO Max',
    };
    const fake = () => {
      client.state = 'bağlı';
      client.me = me;
      client.roomName = 'salon';
      client.serverName = 'Berkay-Tablet';
      client.members = [me, sis];
      client.roomState = { paused: false, time: 2537, at: now - 3000, url: sis.url, by: 'k1' };
      client.history = [
        { t: 'chat', system: true, text: 'Kardeş odaya katıldı.', at: now - 600000 },
        { t: 'chat', from: 'k1', name: 'Kardeş', text: 'Hazır mısın? Ben açtım bölümü', at: now - 420000 },
        { t: 'chat', from: 'me', name: 'Berkay', text: 'Geliyorum, çay koyuyorum', at: now - 400000 },
        { t: 'chat', from: 'me', name: 'Berkay', text: '2 dk', at: now - 390000 },
        { t: 'chat', from: 'k1', name: 'Kardeş', text: 'Bu sahne efsane, geri sarayım mı?', at: now - 60000 },
        { t: 'chat', system: true, text: 'Kardeş geri sayım başlattı.', at: now - 50000 },
      ];
      client.typing = { k1: { name: 'Kardeş', until: now + 1e9 } };
      ui.joinedAt = now - 1800000;
      ui.rtt = 23;
      ui.host = { hosting: true, port: 8787, code: 'K7M4QX', online: true, addresses: [{ label: 'Wi-Fi', address: '192.168.1.20:8787' }] };
      ui.lastNav.k1 = now;
    };
    if (kind === 'welcome') {
      settings.name = '';
      return render();
    }
    if (kind === 'connect') {
      ui.view = 'lobby';
      ui.found = [{ name: 'Kardeş-Telefon', host: '192.168.1.34', port: 8787 }];
      render();
      $('hostChoice').hidden = false;
      $('scanNote').hidden = false;
      renderFound();
      $('scanNote').hidden = false;
      return;
    }
    fake();
    if (kind === 'lobby') {
      ui.view = 'lobby';
      if (params.get('tab')) ui.tab = params.get('tab');
      render();
      for (const el of document.querySelectorAll('[data-app-only]')) el.hidden = false;
      return;
    }
    ui.view = 'watch';
    ui.playerOpen = true;
    ui.layout = kind === 'float' ? 'float' : kind === 'bottom' ? 'bottom' : 'side';
    ui.engine = { hasVideo: true, time: 2540, duration: 3480, paused: false, platform: 'HBO Max', title: sis.title, url: sis.url, watching: true };
    render();
    if (kind === 'float') {
      ui.unread = 2;
      renderBadges();
      toast([h('b', null, 'Kardeş'), ': Bu sahne efsane, geri sarayım mı?']);
      toast([h('b', null, 'Kardeş'), ' seni çağırıyor', h('span', { class: 'q' }, 'The Last of Us · 2. Sezon 4. Bölüm')], {
        action: { label: 'Aç', run: () => {} },
      });
    }
  }

  boot();
})();
