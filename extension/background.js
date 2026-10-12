// Ortak İzle — eklenti arka planı. Sunucuyla tek bağlantıyı tutar (oda istemcisi
// web/room-client.js ile ortaktır) ve platform sekmeleri ile popup arasında köprü kurar.
// Bağlantı burada olduğu için https sayfalardan ws:// adrese bağlanmak engellenmez.

if (typeof importScripts === 'function' && !globalThis.OrtakIzleRoom) importScripts('shared/room-client.js');

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = { serverUrl: '', name: '', room: 'salon', password: '', enabled: false, autoFollow: false };
let settings = { ...DEFAULTS };
const ports = new Set();

const client = new OrtakIzleRoom.RoomClient({
  kind: 'eklenti',
  onEvent(m) {
    if (m.t === 'status') m = withSettings(m);
    if (m.t === 'error' && m.code === 'password') {
      settings.enabled = false;
      api.storage.local.set({ enabled: false });
    }
    for (const p of ports) {
      try {
        p.postMessage(m);
      } catch {
        ports.delete(p);
      }
    }
    updateBadge();
  },
});

function withSettings(st) {
  return { ...st, autoFollow: settings.autoFollow, settings: { ...settings, password: settings.password ? '••••' : '' } };
}

function updateBadge() {
  const action = api.action ?? api.browserAction;
  if (!action) return;
  const ok = client.state === 'bağlı' && client.me;
  action.setBadgeText({ text: ok ? String(client.members.length) : client.state === 'hata' && settings.enabled ? '!' : '' });
  action.setBadgeBackgroundColor({ color: ok ? '#8cc79c' : '#e2606f' });
  if (action.setBadgeTextColor) action.setBadgeTextColor({ color: '#140e10' });
}

function apply() {
  if (settings.enabled && settings.serverUrl) {
    const base = { name: settings.name || 'Misafir', room: settings.room, password: settings.password };
    // Oda kodu (K7M-4QX) ise internet üzerinden, değilse adrese doğrudan bağlan
    if (OrtakIzleRoom.isCode(settings.serverUrl)) client.connect({ ...base, code: OrtakIzleRoom.normalizeCode(settings.serverUrl) });
    else client.connect({ ...base, server: settings.serverUrl });
  } else {
    client.disconnect();
  }
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ortak-izle') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      if (settings.enabled && !client.config) apply();
      port.postMessage(withSettings(client.status()));
      return;
    }
    if (['chat', 'sync', 'tick', 'nav', 'invite', 'react', 'typing', 'buffer', 'countdown', 'drift'].includes(m.t)) {
      client.send(m);
      // Kendi hareketimizi aynı tarayıcıdaki diğer sekmelere de bildir
      if (m.t === 'sync' || m.t === 'tick') {
        for (const p of ports) if (p !== port) p.postMessage({ t: 'state', state: client.roomState });
      }
    }
  });
});

api.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.t === 'getStatus') {
    if (settings.enabled && !client.config) apply();
    reply(withSettings(client.status()));
    return;
  }
  if (m?.t === 'saveSettings') {
    const prev = settings;
    settings = { ...settings, ...m.settings };
    const reconnect = ['serverUrl', 'name', 'room', 'password', 'enabled'].some((k) => prev[k] !== settings[k]);
    api.storage.local.set(settings).then(() => {
      if (reconnect) apply();
      else client.onEvent(client.status());
      reply(withSettings(client.status()));
    });
    return true;
  }
});

api.storage.local.get(DEFAULTS).then((s) => {
  settings = { ...DEFAULTS, ...s };
  apply();
});
