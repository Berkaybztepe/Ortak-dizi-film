// Ortak İzle — arka plan: sunucuya tek WebSocket bağlantısı tutar ve
// platform sekmelerindeki içerik betikleri (content.js) ile popup arasında köprü kurar.
// WebSocket burada olduğu için https sayfalardan ws:// (şifresiz) adrese bağlanmak
// "karışık içerik" engeline takılmaz.

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = { serverUrl: '', name: '', room: 'salon', password: '', enabled: false, autoFollow: false };

let settings = { ...DEFAULTS };
let ws = null;
let wsState = 'kapalı'; // kapalı | bağlanıyor | bağlı | hata
let lastError = '';
let retry = 0;
let retryTimer = null;
let pingTimer = null;
let clockOffset = 0; // sunucuSaati - yerelSaat (ms)
let bestRtt = Infinity;

// Odaya dair son bilinenler (yeni açılan sekmeler ve popup için)
let room = { me: null, name: null, members: [], state: null, history: [] };

const ports = new Set();

function toWsUrl(u) {
  let s = (u || '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
  const url = new URL(s);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.href;
}

function statusPayload() {
  return {
    t: 'status',
    wsState,
    lastError,
    clockOffset,
    settings: { ...settings, password: settings.password ? '••••' : '' },
    room,
  };
}

function toPorts(msg) {
  for (const p of ports) {
    try {
      p.postMessage(msg);
    } catch {
      ports.delete(p);
    }
  }
}

function setState(s, err = '') {
  wsState = s;
  lastError = err;
  toPorts(statusPayload());
  updateBadge();
}

function updateBadge() {
  const action = api.action ?? api.browserAction;
  if (!action) return;
  const n = room.members.length;
  action.setBadgeText({ text: wsState === 'bağlı' ? String(n || '') : wsState === 'hata' ? '!' : '' });
  action.setBadgeBackgroundColor({ color: wsState === 'bağlı' ? '#22c39a' : '#e5484d' });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function disconnect() {
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch {}
  }
  ws = null;
  room = { me: null, name: null, members: [], state: null, history: [] };
  setState('kapalı');
}

function connect() {
  disconnect();
  if (!settings.enabled || !settings.serverUrl) return;
  let url;
  try {
    url = toWsUrl(settings.serverUrl);
  } catch {
    setState('hata', 'Sunucu adresi geçersiz.');
    return;
  }
  setState('bağlanıyor');
  const sock = new WebSocket(url);
  ws = sock;
  bestRtt = Infinity;

  sock.onopen = () => {
    retry = 0;
    send({ t: 'join', name: settings.name, room: settings.room, password: settings.password });
    ping();
    // 20 sn'de bir ping: hem saat farkını günceller hem de Chrome'un servis
    // çalışanını (service worker) uyutmasını engeller.
    pingTimer = setInterval(ping, 20000);
  };

  sock.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    onServer(m);
  };

  sock.onerror = () => {
    lastError = 'Sunucuya ulaşılamadı.';
  };

  sock.onclose = () => {
    clearInterval(pingTimer);
    ws = null;
    room.members = [];
    setState(settings.enabled ? 'hata' : 'kapalı', lastError || 'Bağlantı koptu.');
    if (settings.enabled) {
      retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
    }
  };
}

function ping() {
  send({ t: 'ping', c: Date.now() });
}

function onServer(m) {
  switch (m.t) {
    case 'pong': {
      const now = Date.now();
      const rtt = now - m.c;
      // En düşük gecikmeli ölçüm en doğru saat farkını verir
      if (rtt <= bestRtt * 1.5) {
        bestRtt = Math.min(bestRtt, rtt);
        clockOffset = m.s + rtt / 2 - now;
        toPorts({ t: 'clock', offset: clockOffset });
      }
      return;
    }
    case 'welcome':
      room = { me: m.you, name: m.room, members: m.members, state: m.state, history: m.history };
      setState('bağlı');
      break;
    case 'error':
      if (m.code === 'password') {
        settings.enabled = false;
        api.storage.local.set({ enabled: false });
        lastError = m.message;
        disconnect();
        setState('hata', m.message);
        return;
      }
      break;
    case 'member-join':
      room.members = room.members.filter((x) => x.id !== m.member.id).concat(m.member);
      updateBadge();
      break;
    case 'member-leave':
      room.members = room.members.filter((x) => x.id !== m.member.id);
      updateBadge();
      break;
    case 'nav':
      room.members = room.members.map((x) => (x.id === m.member.id ? m.member : x));
      break;
    case 'chat':
      room.history.push(m);
      if (room.history.length > 100) room.history.shift();
      break;
    case 'sync':
    case 'tick':
      room.state = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by };
      break;
  }
  toPorts(m);
}

// İçerik betiklerinden ve popup'tan gelen mesajlar
function onPortMessage(m, port) {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'hello':
      port.postMessage(statusPayload());
      if (!ws && settings.enabled) connect();
      return;
    case 'chat':
    case 'sync':
    case 'tick':
    case 'nav':
    case 'invite': {
      const ok = send(m);
      if (ok && room.me) {
        // Kendi durumumuzu yerelde de güncel tut
        if (m.t === 'sync' || m.t === 'tick') {
          const paused = m.t === 'sync' ? (m.action === 'pause' ? true : m.action === 'play' ? false : !!m.paused) : !!m.paused;
          room.state = { paused, time: m.time, at: Date.now() + clockOffset, url: room.me.url, by: room.me.id };
          // Aynı tarayıcıdaki diğer sekmeler de bilsin
          for (const p of ports) if (p !== port) p.postMessage({ t: 'state', state: room.state });
        }
        if (m.t === 'nav') {
          room.me = { ...room.me, url: m.url, title: m.title, platform: m.platform };
          room.members = room.members.map((x) => (x.id === room.me.id ? room.me : x));
        }
      }
      return;
    }
  }
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ortak-izle') return;
  ports.add(port);
  port.onMessage.addListener((m) => onPortMessage(m, port));
  port.onDisconnect.addListener(() => ports.delete(port));
});

// Popup'tan tek seferlik istekler
api.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.t === 'getStatus') {
    if (!ws && settings.enabled) connect();
    reply(statusPayload());
    return;
  }
  if (m?.t === 'saveSettings') {
    const prev = settings;
    settings = { ...settings, ...m.settings };
    const reconnect = ['serverUrl', 'name', 'room', 'password', 'enabled'].some((k) => prev[k] !== settings[k]);
    api.storage.local.set(settings).then(() => {
      if (reconnect || (settings.enabled && !ws)) connect();
      else toPorts(statusPayload());
      reply(statusPayload());
    });
    return true;
  }
  if (m?.t === 'chat' || m?.t === 'invite') {
    reply({ ok: send(m) });
    return;
  }
});

api.storage.local.get(DEFAULTS).then((s) => {
  settings = { ...DEFAULTS, ...s };
  if (settings.enabled) connect();
});
