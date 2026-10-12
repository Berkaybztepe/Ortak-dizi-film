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

  // Eski WebView'lar (Chrome 84 öncesi) flex "gap" desteklemiyor: yedek boşluklar için işaretle
  (function () {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    d.append(document.createElement('div'), document.createElement('div'));
    document.documentElement.append(d);
    if (d.scrollHeight !== 1) document.documentElement.classList.add('no-flex-gap');
    d.remove();
  })();

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
      const host = (u) => u.hostname.replace(/^(www|m)\./, '');
      if (host(x) !== host(y)) return false;
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

  // Oynatıcının üstündeki yerel katman (Android): tepkiler, akan mesajlar, uyarılar, 3-2-1
  const overlay = (o) => ENV === 'app' && ui.playerOpen && native.call('overlay', o);

  // Yönetici: odayı açan kişi. Kilit açıkken bölümü yalnızca o seçer, diğerleri onu takip eder.
  const adminMember = () => client.members.find((m) => m.admin) || null;
  const isAdmin = () => !!client.me?.admin;
  const locked = () => client.state === 'bağlı' && client.lock && !!adminMember() && !isAdmin();
  const adminWatching = () => {
    const a = adminMember();
    return a && a.url && (a.watching ?? ui.watching[a.id]) ? a : null;
  };

  const PLATFORMS = [
    { id: 'disney', name: 'Disney+', url: 'https://www.disneyplus.com/', sub: 'Disney, Marvel, Star Wars' },
    { id: 'hbo', name: 'HBO Max', url: 'https://play.hbomax.com/', sub: 'HBO, Warner Bros.' },
    { id: 'apple', name: 'Apple TV+', url: 'https://tv.apple.com/', sub: 'Apple Originals' },
    { id: 'prime', name: 'Prime Video', url: 'https://www.primevideo.com/', sub: 'Amazon' },
    { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', sub: 'Denemek için ideal' },
    { id: 'netflix', name: 'Netflix', url: 'https://www.netflix.com/', sub: 'Telefonda engelleyebilir' },
  ];
  const REACTIONS = ['😂', '😮', '😱', '❤️', '👏', '🔥', '😢', '👀'];
  // Kedi tepkileri: dokununca ikinizde videonun üstünde (sesli) küçük kart olarak oynar
  const MEMES = [
    { id: 'kedi:uzgun', f: 'uzgun', ad: 'Üzgün', img: true },
    { id: 'kedi:fiyonk', f: 'fiyonk', ad: 'Fiyonk', img: true },
    { id: 'kedi:gulen', f: 'gulen', ad: 'Gülen' },
    { id: 'kedi:zipla', f: 'zipla', ad: 'Zıplayan' },
    { id: 'kedi:sarilma', f: 'sarilma', ad: 'Sarılma' },
    { id: 'kedi:muah', f: 'muah', ad: 'Muah', img: true },
    { id: 'kedi:dans', f: 'dans', ad: 'Dans' },
    { id: 'kedi:selam', f: 'selam', ad: 'Selam' },
    { id: 'kedi:sovalye', f: 'sovalye', ad: 'Şövalye' },
    { id: 'kedi:samuray', f: 'samuray', ad: 'Samuray' },
    { id: 'kedi:asker', f: 'asker', ad: 'Asker' },
  ];
  const memeOf = (id) => MEMES.find((x) => x.id === id);
  // Kedi şeridi: küçük resimler; dokununca gönderir
  function memeStrip() {
    return h(
      'div',
      { class: 'memes', role: 'group', 'aria-label': 'Kedi tepkileri' },
      ...MEMES.map((x) =>
        h('button', { type: 'button', class: 'meme', title: x.ad, 'aria-label': `Kedi tepkisi: ${x.ad}`, onclick: () => react(x.id) },
          h('img', { src: `memes/${x.f}-k.jpg`, alt: '', loading: 'lazy', draggable: 'false' }),
          h('span', null, x.ad))
      )
    );
  }

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
    drift: {}, // üye id -> {err, at}: o kişinin oda durumuna göre farkı (sn)
    bufSince: {}, // üye id -> "yükleniyor" dediği an (takılı kalırsa bir süre sonra gösterme)
    update: null, // {code, name, notes}
    leftWatch: 0, // kilitliyken bölüm dışına çıkılan an (geri getirmek için)
  };

  const client = new RoomClient({ kind: ENV === 'app' ? 'app' : 'web', onEvent: onRoomEvent });

  // ---------------------------------------------------------------- sohbet bileşeni
  const chat = (() => {
    const node = $('chatTpl').content.firstElementChild.cloneNode(true);
    const q = (s) => node.querySelector(`[data-${s}]`);
    const els = { people: q('people'), msgs: q('msgs'), typing: q('typing'), reacts: q('reacts'), form: q('form'), input: q('input') };
    // 🐱: emoji sırası ile kedi şeridi arasında geçiş
    const cats = memeStrip();
    cats.hidden = true;
    els.reacts.after(cats);
    els.reacts.append(
      h('button', { type: 'button', class: 'catbtn', title: 'Kedi tepkileri', 'aria-label': 'Kedi tepkileri', onclick: () => {
        cats.hidden = !cats.hidden;
        node.classList.toggle('cats', !cats.hidden);
      } }, '🐱')
    );
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
      if (!client.send({ t: 'chat', text })) toast('Bağlantı bekleniyor; bağlanınca gönderilecek.');
      // Yazma çubuğundayken kendi mesajın da videonun üstünden aksın (gittiğini gör)
      else if (ui.layout === 'type') overlay({ type: 'msg', name: 'Sen', text });
      els.input.value = '';
      typingSent = 0;
    });
    return { node, els };
  })();

  function react(emoji) {
    const meme = memeOf(emoji);
    if (meme) {
      client.send({ t: 'react', emoji });
      if (ui.playerOpen) overlay({ type: 'meme', id: meme.f, img: !!meme.img, name: 'Sen' });
      else toast(`🐱 ${meme.ad} gönderildi`);
      return;
    }
    if (ui.playerOpen) {
      native.call('toPlayer', { t: 'cmd', cmd: 'react', emoji });
      overlay({ type: 'react', emoji, name: 'Sen' });
    } else client.send({ t: 'react', emoji });
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

  // ---------------------------------------------------------------- kaydırarak kapatma
  // Parmakla sürüklenen öğe yeterince kaydırılınca done() çağrılır, yoksa yerine döner.
  //   axis 'x': iki yana (bildirim), '+x': yalnızca sağa (yan panel), '+y': yalnızca aşağı (alt panel)
  //   skip(target): bu öğede başlayan dokunuş kaydırma sayılmaz (yazı alanı, emoji sırası…)
  function swipe(el, { axis, done, skip, enabled }) {
    let s = null;
    const off = (ev) => {
      if (!s || ev.pointerId !== s.id) return;
      if (!s.moving) {
        s = null; // dokunup bırakma: normal tıklama
        return;
      }
      const d = s.d;
      const far = s.moving && Math.abs(d) > Math.max(70, s.size * 0.25);
      el.classList.remove('dragging');
      el.classList.add('settle');
      if (far && ev.type === 'pointerup') {
        el.style.transform = axis.endsWith('y') ? `translateY(${s.size}px)` : `translateX(${Math.sign(d) * s.size}px)`;
        el.style.opacity = '0';
        setTimeout(() => {
          el.classList.remove('settle');
          el.style.transform = el.style.opacity = '';
          done();
        }, 200);
      } else {
        el.style.transform = el.style.opacity = '';
        setTimeout(() => el.classList.remove('settle'), 220);
      }
      s = null;
    };
    el.addEventListener('pointerdown', (ev) => {
      if (s || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      if (enabled && !enabled()) return;
      if (skip && skip(ev.target)) return;
      const r = el.getBoundingClientRect();
      s = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, d: 0, moving: false, size: axis.endsWith('y') ? r.height : r.width };
    });
    el.addEventListener('pointermove', (ev) => {
      if (!s || ev.pointerId !== s.id) return;
      const dx = ev.clientX - s.x;
      const dy = ev.clientY - s.y;
      if (!s.moving) {
        if (Math.hypot(dx, dy) < 10) return;
        const along = axis.endsWith('y') ? dy : dx;
        const across = axis.endsWith('y') ? dx : dy;
        // Başka yöne giden hareket (ör. mesajları kaydırmak) bizim değil
        if (Math.abs(along) < Math.abs(across) * 1.3 || (axis[0] === '+' && along < 0)) {
          s = null;
          return;
        }
        s.moving = true;
        el.classList.add('dragging');
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {}
      }
      let d = axis.endsWith('y') ? dy : dx;
      if (axis[0] === '+') d = Math.max(0, d);
      s.d = d;
      el.style.transform = axis.endsWith('y') ? `translateY(${d}px)` : `translateX(${d}px)`;
      el.style.opacity = String(Math.max(0.3, 1 - Math.abs(d) / s.size));
    });
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    // Kaydırma bitince altta kalan düğmeye "tıklandı" sayılmasın
    el.addEventListener('click', (ev) => {
      if (el.classList.contains('settle')) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    }, true);
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
    swipe(t, { axis: 'x', done: close });
    while (box.children.length >= 3) box.firstElementChild.remove();
    box.append(t);
    setTimeout(close, opts.ms || (opts.action ? 20000 : 3500));
    reportFloatSize();
  }

  // ---------------------------------------------------------------- oda olayları
  // Oynatıcı sayfası güvenilmez (dizi sitesinin kodu da orada çalışıyor): yalnızca
  // senkron için gereken bilgiyi gönder, sohbet metinlerini gönderme.
  const PLAYER_EVENTS = new Set(['status', 'clock', 'welcome', 'member-join', 'member-leave', 'nav', 'buffer', 'state', 'sync', 'tick', 'countdown', 'react', 'lock']);
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
        followAdmin();
        break;
      case 'lock':
        render();
        followAdmin();
        break;
      case 'drift':
        ui.drift[m.from] = { err: m.err, at: Date.now() };
        break;
      case 'react': {
        if (m.from === meId) break;
        const meme = memeOf(m.emoji);
        if (meme) {
          if (ui.playerOpen && ENV === 'app') overlay({ type: 'meme', id: meme.f, img: !!meme.img, name: m.name });
          else toast([h('b', null, m.name), ` 🐱 ${meme.ad} gönderdi`]);
        } else overlay({ type: 'react', emoji: m.emoji, name: m.name });
        break;
      }
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
        if (m.from && m.from !== meId && !m.system && !m.late) {
          if (!chatVisible()) {
            ui.unread++;
            renderBadges();
            // İzlerken mesaj videonun altından akar; ana ekranda bildirim olarak görünür
            if (ui.playerOpen && ENV === 'app') overlay({ type: 'msg', name: m.name, text: m.text });
            else toast([h('b', null, m.name), ': ', m.text]);
          }
        }
        break;
      case 'typing':
        renderTyping();
        break;
      case 'chat-failed':
        toast([h('b', null, 'Mesaj gönderilemedi'), h('span', { class: 'q' }, m.text)]);
        break;
      case 'member-join':
        if (!ui.recent?.[m.member.name] || Date.now() - ui.recent[m.member.name] > 60000) {
          toast(`${m.member.name} odaya katıldı.`);
          overlay({ type: 'notice', text: `${m.member.name} odaya geldi`, ms: 3500 });
        }
        render();
        break;
      case 'member-leave':
        delete ui.drift[m.member.id];
        delete ui.bufSince[m.member.id];
        // replaced: aynı kişi yeniden bağlandı, eski bağlantısı kalktı (gerçekten çıkmadı)
        if (m.replaced) (ui.recent = ui.recent || {})[m.member.name] = Date.now();
        else {
          toast(`${m.member.name} odadan çıktı.`);
          overlay({ type: 'notice', text: `${m.member.name} odadan çıktı`, ms: 5000 });
        }
        render();
        break;
      case 'nav':
        ui.lastNav[m.member.id] = Date.now();
        ui.watching[m.member.id] = !!m.watching;
        render();
        if (m.member.admin && locked()) followAdmin();
        else if (m.watching && m.member.url) offerFollow(m.member);
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
        if (m.reason) {
          // Biri bölümden/odadan çıktı: video herkeste durdu, büyük uyarı
          const what = m.reason === 'left' ? 'odadan çıktı' : 'bölümden çıktı';
          overlay({ type: 'notice', text: `${m.name} ${what} · video durduruldu`, ms: 7000 });
          toast([h('b', null, m.name), ` ${what}. Video durduruldu.`], { ms: 6000 });
        } else if (ui.view === 'watch') {
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
        overlay({ type: 'count', ms: Math.max(0, m.at - client.serverNow()) });
        break;
      case 'buffer':
        if (m.on) ui.bufSince[m.member.id] = Date.now();
        else delete ui.bufSince[m.member.id];
        renderWatch();
        break;
    }
  }

  // Kilitliyken yöneticinin açtığı bölüm bizde de kendiliğinden açılır; başka yere gidildiyse geri gelinir
  function followAdmin() {
    if (ENV !== 'app' || !locked()) return;
    const a = adminWatching();
    if (!a) return;
    if (ui.playerOpen && ui.engine && onEpisode(ui.engine, a.url)) return;
    if (ui.playerOpen && !ui.engine) return; // sayfa yükleniyor
    if (opening && opening.url === a.url && Date.now() - opening.at < 10000) return; // zaten açılıyor
    toast(`${a.name} ${a.title || 'bir bölüm'} açtı. Sen de geçiyorsun…`);
    opening = { url: a.url, at: Date.now() };
    openUrl(a.url);
  }
  // Bölümü adresinden tanırız (aynı dizinin bölümlerinin sayfa başlığı aynı olabilir). Site aynı
  // bölümü başka bir adrese yönlendirebilir: yöneticinin adresini açtığımızda sayfanın vardığı
  // adresi o bölümün eşi olarak hatırlarız.
  const aliases = {}; // yöneticinin adresi -> bizde vardığı adres
  let opening = null; // {url, at}: yöneticinin bölümünü az önce açtık
  function onEpisode(e, url) {
    if (!e?.url || !url) return false;
    if (sameContent(e.url, url)) return true;
    return !!aliases[url] && sameContent(e.url, aliases[url]);
  }
  function noteArrival(e) {
    if (!opening || Date.now() - opening.at > 10000 || !e.watching || !e.url) return;
    if (!sameContent(e.url, opening.url)) aliases[opening.url] = e.url;
  }
  // Aynı bölüm farklı adresle açılmış olabilir (yönlendirme): başlık aynıysa aynı say
  function sameTitle(e, a) {
    if (!e?.watching || !a.title || !e.title) return false;
    try {
      if (new URL(e.url).hostname.replace(/^(www|m)\./, '') !== new URL(a.url).hostname.replace(/^(www|m)\./, '')) return false;
    } catch {
      return false;
    }
    return e.title === a.title;
  }
  // Kilitliyken oynatıcıda başka bir yere gidildi mi? Kısa bir süre sonra yöneticinin bölümüne geri dön
  function guardLock(e) {
    if (!locked() || !e) return;
    const a = adminWatching();
    if (!a) return;
    if (opening && Date.now() - opening.at < 10000) return; // sayfa daha yerleşiyor
    if (Date.now() < (ui.guardPauseUntil || 0)) return; // giriş yapması için mola
    const elsewhere = !e.watching || !onEpisode(e, a.url);
    if (!elsewhere) {
      ui.leftWatch = 0;
      ui.guardStreak = 0;
      return;
    }
    if (!ui.leftWatch) ui.leftWatch = Date.now();
    else if (Date.now() - ui.leftWatch > 2500) {
      ui.leftWatch = 0;
      // Bölüm dışı bir sayfaya (giriş, profil seçimi) art arda düşüyorsa siteye giriş yapması gerekiyordur:
      // bir süre geri getirmeyi bırak, yoksa giriş sayfasıyla bölüm arasında döner durur
      if (!e.watching && (ui.guardStreak = (ui.guardStreak || 0) + 1) >= 3) {
        ui.guardStreak = 0;
        ui.guardPauseUntil = Date.now() + 120000;
        overlay({ type: 'notice', text: 'Siteye giriş yapman gerekiyor olabilir. Giriş yapınca bölüme götürüleceksin.', ms: 9000 });
        return;
      }
      opening = { url: a.url, at: Date.now() };
      ui.engine = null;
      ui.lastNote = undefined;
      backShown = null;
      native.call('openPlayer', a.url);
      // (oynatıcı açılırken katman temizlenir: uyarıyı ondan sonra gönder)
      overlay({ type: 'notice', text: `Bölümü ${a.name} seçiyor · geri getirildin`, ms: 4000 });
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
      ui.lastNote = undefined;
      backShown = null;
      native.call('setDesktopMode', !!settings.desktop);
      native.call('openPlayer', url);
      ui.playerOpen = true;
      lastSpots = '';
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
    client.send({ t: 'nav', url: null, watching: false });
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
        noteArrival(m);
        renderWatch();
        guardLock(m);
        placeButtons();
        break;
      case 'notice':
        if (m.blocked) {
          overlay({ type: 'notice', text: m.text, ms: 9000 });
          toast(
            [h('b', null, m.text), h('span', { class: 'q' }, `${m.platform || 'Bu site'} telefonda tarayıcıdan izlemeye izin vermiyor. Bilgisayarda Ortak İzle eklentisiyle izleyebilirsiniz.`)],
            { action: { label: 'Tamam', run: () => {} }, ms: 30000 }
          );
        } else if (m.text) toast(m.text);
        break;
      case 'zones':
        noteZones(m);
        break;
      case 'diag':
        if (ui.diagWait && typeof m.text === 'string') ui.diagWait(m.text.slice(0, 18000));
        break;
      case 'drift':
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

  // ---------------------------------------------------------------- sorun raporu
  // İzlerken durum yazısına dokununca: oynatıcı sayfasının durumu + son olaylar paylaşılır
  // (WhatsApp vb. ile gönderilebilir). Şifre, oda kodu, mesaj içeriği yazılmaz.
  function askReport() {
    if (ENV !== 'app' || !ui.playerOpen) return;
    native.call('confirm', {
      id: 'diag',
      title: 'Sorun raporu gönderilsin mi?',
      text: 'Oynatıcının durumu ve son olaylar bir metin olarak paylaşılır. Mesajlar, şifre ve oda kodu eklenmez.',
      ok: 'Paylaş',
      cancel: 'Vazgeç',
    });
  }
  function sendReport() {
    const head = () => {
      const v = native.json('appVersion') || {};
      const e = ui.engine || {};
      return [
        `Ortak İzle ${v.name || '?'} (${v.code || '?'})`,
        `bağlantı=${client.state} oda=${client.config ? (client.config.code ? 'kod' : 'adres') : 'yok'} kişi=${client.members.length} yerleşim=${ui.layout} kutu=${JSON.stringify(ui.playerBox || null)}`,
        `motor=${JSON.stringify({ platform: e.platform, hasVideo: e.hasVideo, time: e.time, paused: e.paused, exact: e.exact, mode: e.mode, watching: e.watching, err: e.err, leader: e.leader })}`,
      ].join('\n');
    };
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      ui.diagWait = null;
      native.call('share', `${head()}\n${text || '(oynatıcı sayfası cevap vermedi)'}`);
    };
    ui.diagWait = finish;
    native.call('toPlayer', { t: 'cmd', cmd: 'diag' });
    setTimeout(() => finish(null), 2500);
  }

  // ---------------------------------------------------------------- katman düğmelerinin yeri
  // Oynatıcı sayfası sitenin düğmelerinin, çubuğunun, başlığının hangi ızgara hücrelerinde olduğunu
  // bildirir. Geri düğmesi (sol) ve sohbet düğmesi (sağ) bunlara değmeyen bir yere konur. Bir
  // platformda öğrenilen yerler (yatay/dikey ayrı) hatırlanır: bir dahaki açılışta düğmeler
  // site düğmelerini göstermeden önce de doğru yerde durur.
  // Ekranın en/boy oranı da anahtarda: aynı yönde farklı biçimdeki ekranda düğmeler başka yerdedir
  const ZKEY = (platform, aspect) => `oi.zones.${platform}.${(Math.round(aspect * 4) / 4).toFixed(2)}`;
  function storedZones(platform, aspect) {
    try {
      const o = JSON.parse(localStorage.getItem(ZKEY(platform, aspect)) || 'null');
      if (o && Date.now() - o.at < 14 * 86400000 && typeof o.bits === 'string') return o;
    } catch {}
    return null;
  }
  function noteZones(m) {
    if (!(m.cols > 0 && m.rows > 0 && m.cols * m.rows <= 4096) || typeof m.bits !== 'string' || m.bits.length !== m.cols * m.rows || /[^01]/.test(m.bits)) return;
    const platform = ui.engine?.platform || 'site';
    const aspect = +m.aspect > 0 ? +m.aspect : m.land ? 2 : 0.5;
    const old = storedZones(platform, aspect);
    let bits = m.bits;
    if (old && old.cols === m.cols && old.rows === m.rows) bits = [...bits].map((b, i) => (b === '1' || old.bits[i] === '1' ? '1' : '0')).join('');
    ui.zones = { cols: m.cols, rows: m.rows, bits, land: !!m.land, aspect, platform };
    try {
      localStorage.setItem(ZKEY(platform, aspect), JSON.stringify({ cols: m.cols, rows: m.rows, bits, at: Date.now() }));
    } catch {}
    placeButtons();
  }
  // Izgarada (x0,y0)-(x1,y1) dikdörtgeni (oynatıcı kutusunun dp'si cinsinden) boş mu?
  function zoneFree(z, box, x0, y0, x1, y1) {
    const c0 = Math.max(0, Math.floor((x0 / box.w) * z.cols));
    const c1 = Math.min(z.cols - 1, Math.floor((x1 / box.w) * z.cols));
    const r0 = Math.max(0, Math.floor((y0 / box.h) * z.rows));
    const r1 = Math.min(z.rows - 1, Math.floor((y1 / box.h) * z.rows));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (z.bits[r * z.cols + c] === '1') return false;
    return true;
  }
  function pickSpots(z, box) {
    const M = 10;
    const B = 50; // geri düğmesi (46) + pay
    let back = null;
    // Önce sol üst, sonra sol kenar boyunca aşağı, sonra biraz içeri
    for (const x of [M, M + 58, M + 116]) {
      for (let y = M; y + B <= box.h * 0.88 && !back; y += 6) if (zoneFree(z, box, x, y, x + B, y + B)) back = [x + B / 2, y + B / 2];
      if (back) break;
    }
    // Sohbet düğmesi sağ kenarda: dikeyde alttan, yatayda ortadan başlayıp en yakın boş yer
    const half = 39;
    const want = box.h * (z.land ? 0.5 : 0.93);
    let chat = null;
    for (let d = 0; d < box.h && chat === null; d += 6) {
      for (const cy of d ? [want + d, want - d] : [want]) {
        if (cy - half < M || cy + half > box.h - M) continue;
        if (zoneFree(z, box, box.w - M - 64, cy - half + 12, box.w - M, cy + half - 12)) {
          chat = cy;
          break;
        }
      }
    }
    return { back: back && [back[0] / box.w, back[1] / box.h], chat: chat === null ? null : chat / box.h };
  }
  let lastSpots = '';
  function placeButtons() {
    const box = ui.playerBox;
    if (ENV !== 'app' || !ui.playerOpen || !box || !box.w || !box.h) return;
    const land = box.w > box.h;
    const aspect = box.w / box.h;
    const same = (a) => Math.abs(Math.round(a * 4) / 4 - Math.round(aspect * 4) / 4) < 0.01;
    let z = ui.zones && ui.zones.land === land && same(ui.zones.aspect) && ui.zones.platform === (ui.engine?.platform || 'site') ? ui.zones : null;
    if (!z && ui.engine?.platform) {
      const o = storedZones(ui.engine.platform, aspect);
      if (o) z = { ...o, land };
    }
    if (!z) return;
    const spots = pickSpots(z, box);
    const key = JSON.stringify(spots);
    if (key === lastSpots) return;
    lastSpots = key;
    overlay({ type: 'spots', back: spots.back, chat: spots.chat });
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
    const typing = watch && ui.layout === 'type';
    $('vWelcome').hidden = ui.view !== 'welcome';
    $('topbar').hidden = ui.view !== 'lobby';
    $('vLobby').hidden = ui.view !== 'lobby';
    $('tabs').hidden = ui.view !== 'lobby';
    $('vWatch').hidden = !watch || float || typing;
    $('vFloat').hidden = !float;
    $('vType').hidden = !typing;
    $('toasts').hidden = float || typing;
    // Yazma çubuğunda sohbetin yalnızca yazı kutusu kullanılır
    const formHome = typing ? $('typeSlot') : chat.node;
    if (chat.els.form.parentNode !== formHome) formHome.append(chat.els.form);

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
    renderLock();
    renderUpdate();
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
            const where = (m.id === client.me.id ? 'sen' : bufFresh(m) ? 'yükleniyor' : m.title ? 'izliyor' : m.kind === 'web' ? 'panelde' : 'odada') + (m.admin ? ' · yönetici' : '');
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
    // Oynarken konum her saniye bildirilir; uzun süredir haber yoksa tahmini dakikayı yürütme
    const fresh = st && (st.paused || client.serverNow() - st.at < 15000);
    $('nowTc').textContent =
      st && st.url && sameContent(st.url, watching.url) && fresh
        ? `${fmt(client.expectedTime(st))} · ${st.paused ? 'duraklatıldı' : 'oynuyor'}`
        : bufFresh(watching)
          ? 'yükleniyor'
          : st && st.url && sameContent(st.url, watching.url)
            ? 'izliyor'
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
            'data-mark': p.name.replace(/[^A-Za-z]/g, '').slice(0, 1),
            type: 'button',
            'aria-disabled': off ? 'true' : null,
            onclick: () => (locked() && adminWatching() ? lockedToast() : off ? toast('Bu platform uygulama içinde oynatmaya izin vermiyor.') : openUrl(p.url)),
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
      if (locked() && adminWatching()) return lockedToast();
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

  function lockedToast() {
    const a = adminMember();
    toast(`Bölümü ${a ? a.name : 'odayı açan'} seçiyor. O bir bölüm açınca sende de kendiliğinden açılır.`);
  }

  // "Yükleniyor" bilgisi takılı kalmasın: 15 sn'den eskiyse gösterme
  const bufFresh = (m) => {
    if (!m.buffering) return false;
    if (!(m.id in ui.bufSince)) ui.bufSince[m.id] = Date.now();
    return Date.now() - ui.bufSince[m.id] < 15000;
  };

  function renderLock() {
    // Yönetici bir bölüm izlerken kardeş başka şey açamaz; yönetici izlemiyorken (ör. siteye giriş
    // yapmak için) açabilir, yönetici bir bölüm açınca oraya götürülür
    const lockOn = locked() && !!adminWatching();
    for (const b of document.querySelectorAll('#platforms .pf')) b.classList.toggle('off', lockOn);
    const a = adminMember();
    if (ENV === 'app') {
      $('pfHint').textContent = lockOn
        ? `Bölümü ${a.name} seçiyor; açtığında sende de açılır.`
        : 'İlk açılışta hesabınla bir kez giriş yap.';
    }
    $('lockRow').hidden = !isAdmin() || client.members.length < 1;
    $('setLock').checked = !!client.lock;
    const wl = $('wLock');
    wl.hidden = !(a && client.lock);
    wl.textContent = a ? (isAdmin() ? 'Bölümü sen seçiyorsun' : `Bölümü ${a.name} seçiyor`) : '';
  }

  let backShown = null;
  function renderWatch() {
    if (ui.view !== 'watch') return;
    // Kilitliyken diğer kişi bölümden çıkamaz: geri düğmesi gizli
    const showBack = !(locked() && adminWatching());
    if (showBack !== backShown) {
      backShown = showBack;
      overlay({ type: 'back', show: showBack });
    }
    const e = ui.engine;
    const meId = client.me?.id;
    $('wPlatform').textContent = e?.platform || 'Oynatıcı';
    $('wTitle').textContent = e?.title || (e?.watching ? 'Bölüm' : 'Bir bölüm seç');
    const st = client.roomState;
    // e.time null: bu platformda bölümün gerçek dakikası okunamadı
    // Panelde her zaman bu cihazdaki videonun gerçek konumu yazar (video yoksa tahmin yürütmez)
    const tc = e?.hasVideo ? e.time : null;
    $('wTc').firstChild.textContent = tc === null ? '–:––' : fmt(tc);
    $('wDur').textContent = e?.hasVideo && e.duration && tc !== null ? `/ ${fmt(e.duration)}` : '';

    const others = client.members.filter((m) => m.id !== meId);
    const peers = others.filter((m) => m.url && e?.url && (sameContent(m.url, e.url) || sameTitle(e, m)));
    const waiting = peers.filter(bufFresh);
    let cls = '';
    let txt = 'Video bekleniyor';
    if (client.state !== 'bağlı') {
      // Neden bağlı değiliz: hiç odaya girilmedi mi, bağlanmaya mı çalışılıyor, koptu mu?
      if (!client.config) {
        cls = '';
        txt = 'Odada değilsin · tek başına';
      } else if (client.state === 'bağlanıyor') {
        cls = 'warn';
        txt = 'Odaya bağlanıyor…';
      } else {
        cls = 'bad';
        txt = 'Bağlantı koptu · yeniden deneniyor';
      }
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
    } else if (!peers.length) {
      cls = 'warn';
      txt = 'Farklı bölümdesiniz';
    } else if (e.starting) {
      cls = 'ok';
      txt = 'Birlikte başlıyor…';
    } else if (e.paused) {
      cls = 'ok';
      txt = 'Duraklatıldı';
    } else {
      // "Senkron" yalnızca ölçülen fark gerçekten küçükse yazar. Kumanda bizdeyse fark diğerlerinin
      // bildirdiğidir, değilse kendi ölçtüğümüz.
      const errs = e.leader
        ? peers.map((m) => ui.drift[m.id]).filter((d) => d && Date.now() - d.at < 7000 && typeof d.err === 'number').map((d) => Math.abs(d.err))
        : typeof e.err === 'number'
          ? [Math.abs(e.err)]
          : [];
      if (errs.length) {
        const worst = Math.max(...errs);
        cls = worst < 0.25 ? 'ok' : 'warn';
        txt = worst < 0.25 ? 'Senkron' : 'Eşitleniyor…';
      } else if (e.mode === 'safe' || e.time === null) {
        cls = '';
        txt = 'Güvenli mod · oynat/durdur ortak';
      } else {
        cls = '';
        txt = 'Kontrol ediliyor…';
      }
    }
    // Biri yüklenirken videonun üstünde de görünsün
    const noteTxt = e?.holding && waiting.length ? `${waiting.map((m) => m.name).join(', ')} yükleniyor, bekleniyor…` : null;
    if (noteTxt !== ui.lastNote) {
      ui.lastNote = noteTxt;
      overlay({ type: 'note', text: noteTxt });
    }
    $('wChip').className = 'chip ' + cls;
    $('wChipTxt').textContent = txt;

    $('wWho').replaceChildren(
      ...client.members.map((m) => {
        const mine = m.id === meId;
        const same = mine ? !!e?.hasVideo : m.url && e?.url && sameContent(m.url, e.url);
        const where = bufFresh(m) ? 'yükleniyor' : same ? 'burada' : m.title ? m.title : m.kind === 'web' ? 'panelde' : 'odada';
        return h('span', { style: `--pc:${colorOf(m.id)}` }, h('i'), `${mine ? 'Sen' : m.name}${m.admin ? ' (yönetici)' : ''} · ${where}`);
      })
    );
    const playing = !!e?.hasVideo && !e.paused;
    for (const id of ['tPlayIcon', 'fPlayIcon']) {
      $(id).setAttribute('href', playing ? '#i-pause' : '#i-play');
      $(id).parentNode.classList.toggle('play', !playing);
    }
    $('tPlay').setAttribute('aria-label', playing ? 'Durdur' : 'Oynat');
    for (const id of ['tPlay', 'tBack', 'tFwd', 'fPlay', 'fBack', 'fFwd']) $(id).disabled = !e?.hasVideo;
    $('tCount').disabled = !e?.hasVideo || client.state !== 'bağlı';
    $('tResync').disabled = !e?.hasVideo;
    $('tCall').disabled = !e?.url || client.state !== 'bağlı';
  }
  setInterval(() => {
    if (ui.view !== 'watch') return;
    renderWatch();
    // Kilitliyken başka sayfada kalındıysa yöneticinin bölümüne geri dön (sayfa durumu değişmese de)
    if (ui.playerOpen && ui.engine) guardLock(ui.engine);
  }, 1000);

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
  $('setLock').addEventListener('change', (e) => client.send({ t: 'lock', on: e.target.checked }));

  // ---------------------------------------------------------------- güncelleme
  function renderUpdate() {
    const c = $('updateCard');
    c.hidden = !(ENV === 'app' && ui.update && ui.view === 'lobby');
    if (!c.hidden) $('updTitle').textContent = `Ortak İzle ${ui.update.name} hazır`;
  }
  $('updGo').addEventListener('click', () => {
    $('updGo').disabled = true;
    $('updBar').hidden = false;
    $('updFill').style.width = '0%';
    $('updText').textContent = 'İndiriliyor…';
    native.call('installUpdate');
  });
  $('updCheck').addEventListener('click', () => {
    ui.manualCheck = true;
    $('verHint').textContent = 'Denetleniyor…';
    native.call('checkUpdate');
  });
  function showVersion() {
    const v = native.json('appVersion');
    $('verHint').textContent = v ? `Sürüm ${v.name}${ui.update ? ` · ${ui.update.name} hazır` : ''}` : '—';
  }
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
  $('collapseBtn').addEventListener('click', () => native.call('setPanel', 'closed'));
  // Sohbet düğmesi: video tam ekranda kalır, altta yazma çubuğu açılır (yazarken izlenir)
  $('fOpen').addEventListener('click', () => {
    // Çubuğu hemen göster ki yazı kutusu odaklanabilsin (klavye dokunuşla birlikte açılır)
    ui.layout = 'type';
    render();
    chat.els.input.focus();
    native.call('setPanel', 'type');
  });
  $('fPanel').addEventListener('click', () => native.call('setPanel', 'open'));
  // Haptaki 🐱: kedi şeridini aç/kapat (gönderince kapanır)
  $('fMemes').append(memeStrip());
  $('fMemes').addEventListener('click', (e) => e.target.closest('.meme') && setTimeout(() => (($('fMemes').hidden = true), reportFloatSize()), 150));
  $('fCats').addEventListener('click', () => {
    $('fMemes').hidden = !$('fMemes').hidden;
    reportFloatSize();
  });
  $('fPlay').addEventListener('click', () => native.call('toPlayer', { t: 'cmd', cmd: 'toggle' }));
  $('fBack').addEventListener('click', () => native.call('toPlayer', { t: 'cmd', cmd: 'seekBy', delta: -10 }));
  $('fFwd').addEventListener('click', () => native.call('toPlayer', { t: 'cmd', cmd: 'seekBy', delta: 10 }));
  $('typeClose').addEventListener('click', () => {
    chat.els.input.blur();
    native.call('setPanel', 'closed');
  });
  $('typeExpand').addEventListener('click', () => native.call('setPanel', 'open'));
  $('wChip').addEventListener('click', askReport);
  // Panel kaydırılarak kapanır (yanda sağa, altta aşağı): "Sadece video" ile aynı
  swipe($('vWatch'), {
    axis: '+x',
    enabled: () => ENV === 'app' && ui.layout === 'side',
    skip: (t) => !!t.closest('input, textarea, .reacts'),
    done: () => native.call('setPanel', 'closed'),
  });
  swipe($('vWatch'), {
    axis: '+y',
    enabled: () => ENV === 'app' && ui.layout === 'bottom',
    // Altta yalnızca üst kısımdan (tutamak, başlık, saat, düğmeler) tutulur; mesaj listesi kendi kayar
    skip: (t) => !!t.closest('#watchChatSlot'),
    done: () => native.call('setPanel', 'closed'),
  });
  $('tResync').addEventListener('click', () => native.call('toPlayer', { t: 'cmd', cmd: 'resync' }));
  $('tPlay').addEventListener('click', () => native.call('toPlayer', { t: 'cmd', cmd: 'toggle' }));
  $('tBack').addEventListener('click', () => native.call('toPlayer', { t: 'cmd', cmd: 'seekBy', delta: -10 }));
  $('tFwd').addEventListener('click', () => native.call('toPlayer', { t: 'cmd', cmd: 'seekBy', delta: 10 }));
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
    // Oynatıcı kutusunun boyutu (dp): katman düğmelerinin yeri buna göre seçilir
    setPlayerBox(b) {
      const o = typeof b === 'string' ? JSON.parse(b) : b;
      ui.playerBox = o && o.w > 0 && o.h > 0 ? { w: +o.w, h: +o.h } : null;
      lastSpots = '';
      placeButtons();
    },
    // Sohbet düğmesi ekranın alt yarısındaysa bildirimler onun üstünde açılır
    setFloatUp(up) {
      $('vFloat').classList.toggle('up', !!up);
      lastFloat = '';
      reportFloatSize();
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
      client.send({ t: 'nav', url: null, watching: false });
      render();
    },
    // Geri: sol üstteki düğme ya da telefonun geri hareketi. Bölümden kazara çıkılmasın.
    onBack() {
      if (!ui.playerOpen) return;
      // Yazma çubuğu açıksa geri tuşu yalnızca onu kapatır
      if (ui.layout === 'type') {
        chat.els.input.blur();
        native.call('setPanel', 'closed');
        return;
      }
      const a = adminWatching();
      if (locked() && a) {
        overlay({ type: 'notice', text: `Bölümü ${a.name} yönetiyor · ${a.name} çıkınca sen de çıkabilirsin`, ms: 4000 });
        return;
      }
      const e = ui.engine;
      if (e && e.watching && e.hasVideo) {
        const others = client.members.some((m) => m.id !== client.me?.id && m.url && (sameContent(m.url, e.url) || sameTitle(e, m)));
        native.call('confirm', {
          id: 'exit',
          title: 'Bölümden çıkılsın mı?',
          text: others ? 'Video ikinizde de durur.' : 'Video durur.',
          ok: 'Çık',
          cancel: 'İzlemeye devam',
        });
        return;
      }
      native.call('playerBack');
    },
    onConfirm(id, ok) {
      if (id === 'diag' && ok) return sendReport();
      if (id !== 'exit' || !ok) return;
      // Önce herkeste durdur (sayfa kapanmadan), sonra çık
      native.call('toPlayer', { t: 'cmd', cmd: 'pauseAll' });
      setTimeout(() => native.call('playerBack'), 350);
    },
    onUpdate(info, failed) {
      // Denetim başarısızsa (internet yok) eldeki bilgiyi silme
      if (!failed) ui.update = info || null;
      showVersion();
      renderUpdate();
      if (ui.manualCheck) {
        ui.manualCheck = false;
        toast(failed ? 'Güncelleme denetlenemedi. İnternet bağlantını kontrol et.' : info ? `Yeni sürüm hazır: ${info.name}. Ana ekrandaki "Güncelle"ye dokun.` : 'En güncel sürümü kullanıyorsun.');
      }
    },
    onUpdateProgress(p) {
      if (typeof p === 'number') {
        $('updFill').style.width = `${p}%`;
        $('updText').textContent = p >= 100 ? 'Kurulum ekranı açılıyor… "Güncelle"ye dokun. Açılmazsa "Kur"a bas.' : `İndiriliyor… %${p}`;
        clearTimeout(ui.kurTimer);
        if (p >= 100) {
          ui.kurTimer = setTimeout(() => {
            $('updGo').disabled = false;
            $('updGo').textContent = 'Kur';
          }, 3000);
        }
        return;
      }
      clearTimeout(ui.kurTimer);
      $('updGo').disabled = false;
      $('updGo').textContent = p === 'izin' ? 'Kur' : 'Tekrar dene';
      $('updText').textContent =
        p === 'izin'
          ? 'Açılan ayarda "Bu kaynaktan izin ver"i aç ve geri dön; kurulum kendiliğinden açılır.'
          : String(p);
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
    // Yeni sürüm var mı? (açılışta ve 6 saatte bir)
    showVersion();
    setTimeout(() => native.call('checkUpdate'), 4000);
    setInterval(() => native.call('checkUpdate'), 6 * 3600 * 1000);
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
    const me = { id: 'me', name: 'Berkay', kind: 'app', url: null, title: '', platform: '', admin: true };
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
    ui.engine = { hasVideo: true, time: 2540, duration: 3480, paused: false, platform: 'HBO Max', title: sis.title, url: sis.url, watching: true, err: 0.04, mode: 'exact', leader: false };
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
