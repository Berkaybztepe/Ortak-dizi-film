#!/usr/bin/env node
// Ortak İzle — senkron + sohbet sunucusu.
// Hiçbir npm paketi gerektirmez; Termux (Android tablet), Windows, macOS, Linux'ta
// `node server.js` ile çalışır. Video akışını taşımaz: herkes kendi cihazında,
// kendi (ortak) hesabıyla izler; sunucu sadece oynat/durdur/sar, sohbet ve
// "kim ne açtı" bilgisini odadaki herkese iletir.

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '8787', 10);
const PASSWORD = process.env.ODA_SIFRE || ''; // boşsa şifre sorulmaz
// Arayüz dosyaları (Android uygulamasıyla ortak)
const PUBLIC_DIR = path.join(__dirname, '..', 'web');
const MAX_HISTORY = 100;
const MAX_TEXT = 1000;
const SERVER_NAME = (process.env.ODA_ADI || os.hostname() || 'Ortak İzle').slice(0, 40);
const REACTIONS = ['😂', '😮', '😱', '❤️', '👏', '🔥', '😢', '👀'];
const KINDS = ['app', 'eklenti', 'web'];
const COUNTDOWN_MS = 3500;

// ---------------------------------------------------------------------------
// Minimal WebSocket (RFC 6455) — sadece metin mesajları, ping/pong ve kapanış.
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Socket {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.open = true;
    this.alive = true;
    this.onmessage = () => {};
    this.onclose = () => {};
    sock.setNoDelay(true);
    sock.on('data', (d) => this._data(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.onclose();
  }

  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > 1n << 20n) return this.close(1009); // 1 MB üstü reddedilir
        len = Number(big);
        off = 10;
      }
      if (len > 1 << 20) return this.close(1009);
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(off + maskLen + len);
      this._frame(fin, opcode, payload);
      if (!this.open) return;
    }
  }

  _frame(fin, opcode, payload) {
    this.alive = true;
    if (opcode === 0x8) return this.close(1000);
    if (opcode === 0x9) return this._send(0xa, payload); // ping -> pong
    if (opcode === 0xa) return; // pong
    if (opcode === 0x1 || opcode === 0x0) {
      this.fragments.push(payload);
      if (!fin) return;
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.onmessage(text);
    }
  }

  _send(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.sock.write(Buffer.concat([header, payload]));
    } catch {
      this._closed();
    }
  }

  send(obj) {
    this._send(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  ping() {
    this._send(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this._send(0x8, p);
    this.sock.end();
    this._closed();
  }
}

// ---------------------------------------------------------------------------
// Odalar
// ---------------------------------------------------------------------------

/** @type {Map<string, {name:string, clients:Set<any>, history:any[], state:any}>} */
const rooms = new Map();

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = {
      name,
      clients: new Set(),
      history: [],
      // Son bilinen oynatma durumu: `at` sunucu saati (ms) — oynarken
      // güncel konum = time + (şimdi - at) / 1000
      state: { paused: true, time: 0, at: Date.now(), url: null, by: null },
    };
    rooms.set(name, room);
  }
  return room;
}

function memberInfo(c) {
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    title: c.title,
    platform: c.platform,
    kind: c.kind,
    buffering: !!c.buffering,
  };
}

function broadcast(room, msg, except) {
  for (const c of room.clients) if (c !== except) c.ws.send(msg);
}

function cleanStr(v, max = 200) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function cleanNum(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function cleanUrl(v) {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href.slice(0, 2000) : null;
  } catch {
    return null;
  }
}

// Sohbet mesajlarına sıra numarası: istemci arada kaçırdığını fark edip yeniden isteyebilsin
function pushChat(room, msg) {
  room.seq = (room.seq || 0) + 1;
  msg.seq = room.seq;
  room.history.push(msg);
  if (room.history.length > MAX_HISTORY) room.history.shift();
}

function addSystemMessage(room, text) {
  const msg = { t: 'chat', system: true, text, at: Date.now() };
  room.seq = (room.seq || 0) + 1;
  msg.seq = room.seq;
  room.history.push(msg);
  if (room.history.length > MAX_HISTORY) room.history.shift();
  broadcast(room, msg);
}

function handle(client, raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (!m || typeof m !== 'object') return;

  // Saat eşitleme her zaman serbest
  if (m.t === 'ping') {
    const pong = { t: 'pong', c: m.c, s: Date.now() };
    if (client.room) pong.cs = client.room.seq || 0; // son sohbet sıra numarası
    client.ws.send(pong);
    return;
  }

  if (m.t === 'join') {
    if (PASSWORD && m.password !== PASSWORD) {
      client.ws.send({ t: 'error', code: 'password', message: 'Şifre yanlış.' });
      return;
    }
    const roomName = cleanStr(m.room, 40).trim().toLowerCase() || 'salon';
    if (client.room) leave(client);
    client.name = cleanStr(m.name, 30).trim() || 'Misafir';
    client.kind = KINDS.includes(m.kind) ? m.kind : 'eklenti';
    client.buffering = false;
    client.room = getRoom(roomName);
    client.room.clients.add(client);
    client.ws.send({
      t: 'welcome',
      you: memberInfo(client),
      room: roomName,
      server: SERVER_NAME,
      members: [...client.room.clients].map(memberInfo),
      state: client.room.state,
      history: client.room.history,
      now: Date.now(),
    });
    broadcast(client.room, { t: 'member-join', member: memberInfo(client) }, client);
    addSystemMessage(client.room, `${client.name} odaya katıldı.`);
    log(`[${roomName}] + ${client.name} (${client.kind})`);
    return;
  }

  const room = client.room;
  if (!room) {
    client.ws.send({ t: 'error', code: 'nojoin', message: 'Önce odaya katılın.' });
    return;
  }

  switch (m.t) {
    case 'chat': {
      const text = cleanStr(m.text, MAX_TEXT).trim();
      if (!text) return;
      const cid = cleanStr(m.cid, 20);
      if (cid) {
        // Aynı mesaj (bağlantı sorunu yüzünden) tekrar geldiyse çoğaltma; herkese yeniden ilet
        // (ilk iletim birine ulaşmamış olabilir, istemciler kimliğe bakıp tekrarı gösterme)
        const dup = room.history.find((h) => h.cid === cid);
        if (dup) return broadcast(room, dup);
      }
      const msg = { t: 'chat', from: client.id, name: client.name, text, at: Date.now() };
      if (cid) msg.cid = cid;
      pushChat(room, msg);
      broadcast(room, msg);
      return;
    }

    // Kullanıcı eliyle oynat / durdur / sar yaptı
    case 'sync': {
      const action = ['play', 'pause', 'seek'].includes(m.action) ? m.action : null;
      if (!action) return;
      const now = Date.now();
      room.state = {
        paused: action === 'pause' ? true : action === 'play' ? false : !!m.paused,
        time: cleanNum(m.time),
        at: now,
        url: client.url,
        by: client.id,
      };
      // rel: gönderenin zamanı içeriğin gerçek dakikası değil (ör. Disney+): konuma atlanmaz
      if (m.rel) room.state.rel = true;
      const msg = { t: 'sync', action, ...room.state, from: client.id, name: client.name };
      // delta: sarma miktarı (sn), güvenli modda karşı taraf aynı miktarda sarar
      if (action === 'seek' && typeof m.delta === 'number' && Number.isFinite(m.delta) && Math.abs(m.delta) <= 86400) msg.delta = m.delta;
      broadcast(room, msg, client);
      return;
    }

    // Oynatırken düzenli konum bildirimi (kayma düzeltmesi için)
    case 'tick': {
      // Sadece son kumanda eden kişinin tick'i durumu belirler; aksi halde iki
      // taraf birbirini sonsuza kadar düzeltmeye çalışır.
      if (room.state.by && room.state.by !== client.id) return;
      room.state = {
        ...room.state,
        paused: !!m.paused,
        time: cleanNum(m.time),
        at: Date.now(),
        url: client.url,
        by: client.id,
      };
      if (m.rel) room.state.rel = true;
      broadcast(room, { t: 'tick', ...room.state, from: client.id, cs: room.seq || 0 }, client);
      return;
    }

    // Kullanıcı bir dizi/film sayfası açtı
    case 'nav': {
      const url = cleanUrl(m.url);
      client.url = url;
      client.title = cleanStr(m.title, 200);
      client.platform = cleanStr(m.platform, 30);
      broadcast(room, { t: 'nav', member: memberInfo(client), watching: !!m.watching }, client);
      return;
    }

    // Diğerlerinin tarayıcısına "buraya gel" isteği
    case 'invite': {
      const url = cleanUrl(m.url) || client.url;
      if (!url) return;
      broadcast(room, { t: 'invite', url, title: cleanStr(m.title, 200), from: client.id, name: client.name }, client);
      addSystemMessage(room, `${client.name} herkesi davet etti: ${cleanStr(m.title, 200) || url}`);
      return;
    }

    // İstemci arada kaçırdığı sohbet mesajlarını istiyor
    case 'resend': {
      const after = cleanNum(m.after);
      for (const h of room.history) if (h.seq > after) client.ws.send(h);
      return;
    }

    // Hızlı tepki (videonun üstünde uçuşan emoji)
    case 'react': {
      if (!REACTIONS.includes(m.emoji)) return;
      broadcast(room, { t: 'react', emoji: m.emoji, from: client.id, name: client.name }, client);
      return;
    }

    // "yazıyor…" göstergesi
    case 'typing': {
      broadcast(room, { t: 'typing', on: !!m.on, from: client.id, name: client.name }, client);
      return;
    }

    // Biri yükleniyor (buffer): diğerleri onu bekler
    case 'buffer': {
      const on = !!m.on;
      if (client.buffering === on) return;
      client.buffering = on;
      broadcast(room, { t: 'buffer', on, member: memberInfo(client) }, client);
      return;
    }

    // 3-2-1 geri sayımla birlikte başlat. Herkes (gönderen dahil) aynı sunucu
    // anında oynatmaya başlar.
    case 'countdown': {
      const at = Date.now() + COUNTDOWN_MS;
      const time = cleanNum(m.time);
      room.state = { paused: false, time, at, url: client.url, by: client.id };
      if (m.rel) room.state.rel = true;
      const cd = { t: 'countdown', at, time, url: client.url, from: client.id, name: client.name };
      if (m.rel) cd.rel = true;
      broadcast(room, cd);
      addSystemMessage(room, `${client.name} geri sayım başlattı.`);
      return;
    }

    default:
      return;
  }
}

function leave(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client);
  client.room = null;
  if (room.state.by === client.id) room.state.by = null;
  broadcast(room, { t: 'member-leave', member: memberInfo(client) });
  addSystemMessage(room, `${client.name} odadan ayrıldı.`);
  log(`[${room.name}] - ${client.name}`);
  if (room.clients.size === 0) {
    // Boş odayı bir süre sonra temizle (yenileme sırasında geçmiş kaybolmasın)
    setTimeout(() => {
      if (room.clients.size === 0 && rooms.get(room.name) === room) rooms.delete(room.name);
    }, 30 * 60 * 1000).unref();
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket yükseltme
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(
      JSON.stringify({
        ok: true,
        app: 'ortak-izle',
        version: 2,
        name: SERVER_NAME,
        password: !!PASSWORD,
        rooms: [...rooms.values()].map((r) => ({ name: r.name, members: [...r.clients].map((c) => c.name) })),
      })
    );
    return;
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Bulunamadı');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const ws = new Socket(sock);
  const client = { id: crypto.randomBytes(4).toString('hex'), ws, room: null, name: '', url: null };
  ws.onmessage = (text) => handle(client, text);
  ws.onclose = () => leave(client);
});

// ---------------------------------------------------------------------------
// Oda kodu: internet üzerinden (aracı MQTT sunucuları) bağlanan istemciler
// ---------------------------------------------------------------------------

async function startRelay(code, brokerUrls) {
  require('../web/room-client.js');
  const R = globalThis.OrtakIzleRoom;
  const { topic, key } = await R.relayKeys(code);
  const peers = new Map(); // cid -> { client, link, lastSeen, tx }

  function publish(peer, obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const link = peer.link;
    peer.tx = peer.tx.then(async () => {
      if (!link.mqtt.closed) link.mqtt.publish(`${topic}/down/${peer.cid}`, await R.seal(key, text));
    });
  }

  function drop(cid) {
    const peer = peers.get(cid);
    if (!peer) return;
    peers.delete(cid);
    leave(peer.client);
  }

  function onText(link, cid, text) {
    let ctl = null;
    if (text.startsWith('{"_"')) {
      try {
        ctl = JSON.parse(text);
      } catch {}
    }
    let peer = peers.get(cid);
    if (ctl && ctl._ === 'hello') {
      if (!peer) {
        peer = { cid, link, lastSeen: Date.now(), tx: Promise.resolve() };
        const client = { id: crypto.randomBytes(4).toString('hex'), room: null, name: '', url: null };
        client.ws = { alive: true, send: (obj) => publish(peer, obj), ping() { this.alive = true; }, close: () => drop(cid) };
        peer.client = client;
        peers.set(cid, peer);
      }
      peer.link = link;
      peer.lastSeen = Date.now();
      publish(peer, { _: 'hi', name: SERVER_NAME });
      return;
    }
    if (ctl && ctl._ === 'bye') return drop(cid);
    if (!peer) {
      // Sunucu yeniden başlamış: istemci baştan bağlansın
      const tmp = { cid, link, tx: Promise.resolve() };
      publish(tmp, { _: 'reset' });
      return;
    }
    peer.link = link;
    peer.lastSeen = Date.now();
    handle(peer.client, text);
  }

  function connect(url, attempt = 0) {
    const link = { url, rx: Promise.resolve() };
    link.mqtt = new R.Mqtt(url, 'oi-h-' + crypto.randomBytes(6).toString('hex'), {
      onConnect: () => {
        attempt = 0;
        link.mqtt.subscribe(`${topic}/up/+`);
        log(`Oda kodu hazır (${new URL(url).hostname})`);
      },
      onMessage: (t, payload) => {
        const cid = t.slice(t.lastIndexOf('/') + 1);
        if (!/^[0-9a-f]{16}$/.test(cid)) return;
        link.rx = link.rx.then(async () => {
          let text;
          try {
            text = await R.open(key, payload);
          } catch {
            return;
          }
          onText(link, cid, text);
        });
      },
      onClose: () => {
        setTimeout(() => connect(url, attempt + 1), Math.min(2000 * 2 ** attempt, 60000)).unref();
      },
    });
  }
  for (const url of brokerUrls) connect(url);

  // 45 sn'dir ses vermeyen istemci gitmiş sayılır (istemciler 15 sn'de bir ping atar)
  setInterval(() => {
    const now = Date.now();
    for (const [cid, p] of peers) if (now - p.lastSeen > 45000) drop(cid);
  }, 10000).unref();
}

// Ölü bağlantıları temizle
setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.clients) {
      if (!c.ws.alive) {
        c.ws.close(1001);
        continue;
      }
      c.ws.alive = false;
      c.ws.ping();
    }
  }
}, 30000).unref();

function log(...a) {
  console.log(new Date().toLocaleTimeString('tr-TR'), ...a);
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

const RELAY_CODE = process.env.ODA_KODU || '';

if (require.main === module) {
  if (RELAY_CODE) {
    require('../web/room-client.js');
    const R = globalThis.OrtakIzleRoom;
    const brokers = process.env.ARACI ? process.env.ARACI.split(',') : R.BROKERS.map((b) => b.ws);
    startRelay(RELAY_CODE, brokers).catch((e) => console.error('Oda kodu başlatılamadı:', e));
    console.log(`\n  Oda kodu: ${R.formatCode(RELAY_CODE)}  (farklı evlerden bu kodla katılınır)`);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  Ortak İzle sunucusu çalışıyor 🎬\n');
    console.log(`  Bu cihazda:      http://localhost:${PORT}`);
    for (const ip of localAddresses()) console.log(`  Aynı Wi-Fi'da:   http://${ip}:${PORT}`);
    console.log(`\n  Eklentideki "Sunucu adresi" alanına yukarıdakilerden birini yazın.`);
    console.log(`  Farklı evlerdeyseniz README'deki Tailscale adımlarına bakın.`);
    console.log(PASSWORD ? '  Şifre: AÇIK (ODA_SIFRE)\n' : '  Şifre: kapalı (ODA_SIFRE ile açabilirsiniz)\n');
  });
}

module.exports = { server, startRelay };
