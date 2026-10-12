// Ortak İzle — oda istemcisi. Sunucuya WebSocket ile bağlanır, oda durumunu
// (üyeler, oynatma durumu, sohbet geçmişi, saat farkı) tutar ve olayları bildirir.
// Hem Android uygulamasında, hem web panelinde, hem de eklentinin arka planında
// (service worker) çalışır; bu yüzden DOM kullanmaz.

(function (root) {
  'use strict';

  const HISTORY = 100;

  function toWsUrl(address) {
    let s = String(address || '').trim();
    if (!s) throw new Error('Sunucu adresi boş.');
    if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
    const url = new URL(s);
    if (!url.port && url.protocol === 'http:' && !/\.(ts\.net|trycloudflare\.com)$/.test(url.hostname)) url.port = '8787';
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = '';
    url.hash = '';
    return url.href;
  }

  // Kullanıcıya gösterilecek kısa adres: "192.168.1.20:8787"
  function displayAddress(address) {
    try {
      const u = new URL(toWsUrl(address));
      return u.host;
    } catch {
      return String(address || '');
    }
  }


  // ==================================================================== oda kodu (internet)
  // Farklı evlerdeki cihazlar, herkese açık ücretsiz MQTT aracı sunucuları üzerinden
  // buluşur. Odayı açan cihaz (tablet) aracıya bağlanıp sunucu gibi davranır; diğerleri
  // oda koduyla gelir. Tüm mesajlar oda kodundan türetilen anahtarla AES-GCM ile şifrelenir;
  // aracı sunucu ne konuşulduğunu göremez, konu adı da kodu ele vermez.
  const BROKERS = [
    { ws: 'wss://broker.emqx.io:8084/mqtt', tcp: 'ssl://broker.emqx.io:8883' },
    { ws: 'wss://broker.hivemq.com:8884/mqtt', tcp: 'ssl://broker.hivemq.com:8883' },
    { ws: 'wss://test.mosquitto.org:8081/mqtt', tcp: 'ssl://test.mosquitto.org:8886' },
  ];
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // karışan harfler (I, L, O, 0, 1) yok

  function normalizeCode(code) {
    return String(code || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }
  function isCode(text) {
    return /^[A-Z0-9]{6}$/.test(normalizeCode(text)) && !/[.:]/.test(String(text));
  }
  function formatCode(code) {
    const c = normalizeCode(code);
    return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
  }
  function newCode() {
    const b = new Uint8Array(6);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const hex = (buf) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');

  async function relayKeys(code) {
    const norm = normalizeCode(code);
    const topic = hex(await crypto.subtle.digest('SHA-256', enc.encode('ortak-izle/konu/' + norm))).slice(0, 32);
    const base = await crypto.subtle.importKey('raw', enc.encode(norm), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('ortak-izle/anahtar/v1'), iterations: 100000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return { topic: `ortakizle/v1/${topic}`, key };
  }
  async function seal(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return out;
  }
  async function open(key, bytes) {
    if (bytes.length < 29) throw new Error('kısa');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return dec.decode(pt);
  }

  // Asgari MQTT 3.1.1 istemcisi (WebSocket üzerinden, yalnızca QoS 0)
  class Mqtt {
    constructor(url, clientId, handlers) {
      this.h = handlers;
      this.clientId = clientId;
      this.buf = new Uint8Array(0);
      this.connected = false;
      this.closed = false;
      this.pid = 1;
      try {
        this.ws = new WebSocket(url, ['mqtt']);
      } catch {
        setTimeout(() => this._close(), 0);
        return;
      }
      this.ws.binaryType = 'arraybuffer';
      // Aracı bağlantıyı kabul etmezse (CONNACK gelmezse) takılı kalma
      this.ackTimer = setTimeout(() => !this.connected && this._close(), 15000);
      this.ws.onopen = () => {
        const id = enc.encode(clientId);
        const body = [0, 4, 77, 81, 84, 84, 4, 2, 0, 30, id.length >> 8, id.length & 255, ...id];
        this._send(0x10, body);
      };
      this.ws.onmessage = (e) => {
        this.lastIn = Date.now();
        this._data(new Uint8Array(e.data));
      };
      this.ws.onclose = this.ws.onerror = () => this._close();
    }
    _send(type, body) {
      if (!this.ws || this.ws.readyState !== 1) return;
      const len = [];
      let n = body.length;
      do {
        let d = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) d |= 128;
        len.push(d);
      } while (n > 0);
      const out = new Uint8Array(1 + len.length + body.length);
      out[0] = type;
      out.set(len, 1);
      out.set(body, 1 + len.length);
      this.ws.send(out);
    }
    _data(chunk) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
      for (;;) {
        if (this.buf.length < 2) return;
        let len = 0;
        let mul = 1;
        let i = 1;
        for (;;) {
          if (i >= this.buf.length) return;
          const d = this.buf[i++];
          len += (d & 127) * mul;
          mul *= 128;
          if (!(d & 128)) break;
          if (i > 4) return this._close();
        }
        if (this.buf.length < i + len) return;
        const type = this.buf[0] >> 4;
        const body = this.buf.subarray(i, i + len);
        this.buf = this.buf.slice(i + len);
        this._packet(type, body);
        if (this.closed) return;
      }
    }
    _packet(type, body) {
      if (type === 2) {
        // CONNACK
        if (body[1] !== 0) return this._close();
        this.connected = true;
        this.lastIn = Date.now();
        // 20 sn'de bir ping; aracıdan 50 sn hiçbir şey gelmezse bağlantı ölmüştür
        this.ping = setInterval(() => {
          if (Date.now() - this.lastIn > 50000) return this._close();
          this._send(0xc0, []);
        }, 20000);
        this.h.onConnect && this.h.onConnect();
      } else if (type === 3) {
        // PUBLISH (QoS 0)
        const tl = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tl));
        this.h.onMessage && this.h.onMessage(topic, body.slice(2 + tl));
      }
    }
    subscribe(topic) {
      const t = enc.encode(topic);
      const id = this.pid++ & 0xffff || 1;
      this._send(0x82, [id >> 8, id & 255, t.length >> 8, t.length & 255, ...t, 0]);
    }
    publish(topic, payload) {
      const t = enc.encode(topic);
      const body = new Uint8Array(2 + t.length + payload.length);
      body[0] = t.length >> 8;
      body[1] = t.length & 255;
      body.set(t, 2);
      body.set(payload, 2 + t.length);
      this._send(0x30, body);
    }
    end() {
      this._send(0xe0, []);
      this._close();
    }
    _close() {
      if (this.closed) return;
      this.closed = true;
      this.connected = false;
      clearInterval(this.ping);
      clearTimeout(this.ackTimer);
      try {
        this.ws && this.ws.close();
      } catch {}
      this.h.onClose && this.h.onClose();
    }
  }

  // WebSocket gibi davranan, oda koduyla aracı üzerinden odaya bağlanan soket.
  // Birden çok aracıyı aynı anda dener; odayı açan cihazın ilk cevap verdiği yol kullanılır.
  class RelaySocket {
    constructor(code, brokers) {
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.cid = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => x.toString(16).padStart(2, '0')).join('');
      this.links = [];
      this.active = null;
      this.lastRx = Date.now();
      // Testlerde yerel aracı kullanılır (globalThis.__ortakIzleBrokers)
      this._start(code, brokers || root.__ortakIzleBrokers || BROKERS.map((b) => b.ws));
    }
    async _start(code, urls) {
      try {
        const { topic, key } = await relayKeys(code);
        this.key = key;
        this.up = `${topic}/up/${this.cid}`;
        this.down = `${topic}/down/${this.cid}`;
      } catch (e) {
        return this._fail();
      }
      if (this.readyState === 3) return;
      const hello = JSON.stringify({ _: 'hello', v: 1 });
      for (const url of urls) {
        const link = { mqtt: null, timer: null };
        link.mqtt = new Mqtt(url, 'oi-' + this.cid + '-' + this.links.length, {
          onConnect: () => {
            link.mqtt.subscribe(this.down);
            const say = async () => {
              if (this.active || link.mqtt.closed) return;
              link.mqtt.publish(this.up, await seal(this.key, hello));
            };
            say();
            link.timer = setInterval(say, 1500);
          },
          onMessage: (t, payload) => {
            // Şifre çözme eşzamansız: mesaj sırası bozulmasın diye zincirle
            link.rx = (link.rx || Promise.resolve()).then(async () => {
              let text;
              try {
                text = await open(this.key, payload);
              } catch {
                return;
              }
              this._rx(link, text);
            });
          },
          onClose: () => {
            clearInterval(link.timer);
            if (!this.links.includes(link)) return setTimeout(() => this._checkAllClosed(), 0);
            if (this.active === link) this._lost();
            else if (!this.active && this.links.every((l) => l.mqtt.closed)) this._fail();
          },
        });
        this.links.push(link);
      }
      this.giveUp = setTimeout(() => !this.active && this._fail(), 12000);
    }
    _checkAllClosed() {
      if (!this.active && this.links.length && this.links.every((l) => l.mqtt.closed)) this._fail();
    }
    _rx(link, text) {
      this.lastRx = Date.now();
      let ctl = null;
      if (text.startsWith('{"_"')) {
        try {
          ctl = JSON.parse(text);
        } catch {}
      }
      if (ctl && ctl._) {
        if (ctl._ === 'hi' && !this.active) {
          this.active = link;
          clearTimeout(this.giveUp);
          for (const l of this.links) {
            clearInterval(l.timer);
            if (l !== link) l.mqtt.end();
          }
          this.readyState = 1;
          // Oda 6 sn'de bir ping'e cevap verir: 25 sn ses yoksa yol ölmüştür, hemen yeniden bağlan
          this.watch = setInterval(() => Date.now() - this.lastRx > 25000 && this._lost(), 5000);
          this.onopen && this.onopen();
        } else if ((ctl._ === 'bye' || ctl._ === 'reset') && this.active === link) {
          this._lost();
        }
        return;
      }
      if (this.active === link && this.readyState === 1) this.onmessage && this.onmessage({ data: text });
    }
    send(text) {
      if (this.readyState !== 1 || !this.active) return;
      const link = this.active;
      this.tx = (this.tx || Promise.resolve()).then(async () => {
        const b = await seal(this.key, String(text));
        if (this.active === link) link.mqtt.publish(this.up, b);
      });
    }
    close() {
      if (this.readyState === 3) return;
      if (this.active && this.readyState === 1) {
        const link = this.active;
        seal(this.key, JSON.stringify({ _: 'bye' })).then((b) => {
          link.mqtt.publish(this.up, b);
          setTimeout(() => link.mqtt.end(), 50);
        });
      }
      this._finish(true);
    }
    _lost() {
      this._finish(false);
    }
    _fail() {
      this.failed = true;
      this._finish(false);
    }
    _finish(byUser) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      clearTimeout(this.giveUp);
      clearInterval(this.watch);
      for (const l of this.links) {
        clearInterval(l.timer);
        if (!byUser || l !== this.active) l.mqtt && l.mqtt.end();
      }
      this.onclose && this.onclose({});
    }
  }

  class RoomClient {
    /**
     * @param {{onEvent:(m:any)=>void, kind?:string}} opts
     */
    constructor(opts) {
      this.onEvent = opts.onEvent || (() => {});
      this.kind = opts.kind || 'app';
      this.config = null; // {server, name, room, password}
      this.ws = null;
      this.state = 'kapalı'; // kapalı | bağlanıyor | bağlı | hata
      this.error = '';
      this.retry = 0;
      this.retryTimer = null;
      this.pingTimer = null;
      this.clockOffset = 0;
      this.bestRtt = Infinity;
      this.reset();
    }

    reset() {
      this.me = null;
      this.roomName = null;
      this.serverName = null;
      this.members = [];
      this.roomState = null;
      this.history = [];
      this.typing = {};
      this.lock = true;
    }

    serverNow() {
      return Date.now() + this.clockOffset;
    }

    connect(config) {
      this.disconnect(true);
      this.config = { ...config };
      this.retry = 0;
      this._open();
    }

    disconnect(silent) {
      clearTimeout(this.retryTimer);
      clearInterval(this.pingTimer);
      if (this.ws) {
        this.ws.onclose = this.ws.onerror = this.ws.onmessage = this.ws.onopen = null;
        try {
          this.ws.close();
        } catch {}
      }
      this.ws = null;
      this.config = silent ? this.config : null;
      this.reset();
      this._setState('kapalı', '');
    }

    _open() {
      if (!this.config) return;
      const viaCode = !!this.config.code;
      let ws;
      if (viaCode) {
        this._setState('bağlanıyor', '');
        ws = new RelaySocket(this.config.code, this.config.brokers);
      } else {
        let url;
        try {
          url = toWsUrl(this.config.server);
        } catch (e) {
          this._setState('hata', 'Sunucu adresi geçersiz.');
          return;
        }
        this._setState('bağlanıyor', '');
        try {
          ws = new WebSocket(url);
        } catch {
          this._setState('hata', 'Sunucu adresi geçersiz.');
          return;
        }
      }
      this.ws = ws;
      this.bestRtt = Infinity;
      this.clockSamples = [];
      let opened = false;

      let lastRx = Date.now();
      ws.onopen = () => {
        opened = true;
        this.retry = 0;
        // Odaya katılma cevabı (welcome) yolda kaybolursa takılı kalma: yeniden bağlan
        clearTimeout(this.joinTimer);
        this.joinTimer = setTimeout(() => {
          if (this.ws === ws && !this.me) {
            try {
              ws.close();
            } catch {}
          }
        }, 10000);
        this.send({
          t: 'join',
          name: this.config.name,
          room: this.config.room || 'salon',
          password: this.config.password || '',
          kind: this.kind,
          // Bağlantı koptuysa eski kimliğimiz: sunucu eski (ölü) bağlantıyı sessizce kaldırır,
          // "odadan çıktı" sayıp videoyu durdurmaz
          prev: this.prevId || undefined,
        });
        this._ping();
        setTimeout(() => this._ping(), 1500);
        clearInterval(this.pingTimer);
        // 6 sn'de bir: saat farkını tazeler, kaçan sohbet mesajını fark ettirir,
        // servis çalışanını uyanık tutar.
        // 25 sn'dir hiçbir şey gelmediyse bağlantı ölmüştür: kapatıp yeniden bağlan
        this.pingTimer = setInterval(() => {
          if (Date.now() - lastRx > 25000) {
            try {
              ws.close();
            } catch {}
            return;
          }
          this._ping();
        }, 6000);
      };

      ws.onmessage = (e) => {
        lastRx = Date.now();
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m && typeof m === 'object') this._handle(m);
      };

      ws.onclose = () => {
        clearInterval(this.pingTimer);
        clearTimeout(this.joinTimer);
        if (this.ws !== ws) return; // eski bağlantı
        this.ws = null;
        const wasJoined = !!this.me;
        this.members = [];
        this.me = null;
        if (!this.config) return this._setState('kapalı', '');
        const err = opened
          ? wasJoined
            ? 'Bağlantı koptu. Yeniden bağlanıyor…'
            : 'Sunucu bağlantıyı kapattı.'
          : viaCode
            ? 'Bu kodla açık bir oda bulunamadı. Kod doğru mu, odayı açan cihazda uygulama açık mı?'
            : 'Sunucuya ulaşılamadı. Adres doğru mu, sunucu açık mı?';
        this._setState('hata', err);
        const delay = Math.min(1000 * 2 ** this.retry++, 10000);
        this.retryTimer = setTimeout(() => this._open(), delay);
      };
    }

    _trackChat(obj) {
      this.pendingChats = this.pendingChats || new Map();
      const entry = { obj, tries: 0 };
      this.pendingChats.set(obj.cid, entry);
      const again = () => {
        if (!this.pendingChats.has(obj.cid)) return;
        if (entry.tries++ >= 5) {
          this.pendingChats.delete(obj.cid);
          this.onEvent({ t: 'chat-failed', text: obj.text });
          return;
        }
        if (this.ws && this.ws.readyState === 1 && this.me) this.ws.send(JSON.stringify(obj));
        entry.timer = setTimeout(again, 3000);
      };
      entry.timer = setTimeout(again, 3000);
    }

    // Boşluksuz alınmış en büyük sohbet sıra numarası (arada kaçan varsa ondan öncesi): sunucu
    // daha büyüğünü bildirdikçe kaçan yeniden istenir
    _contiguous() {
      const seqs = this.history.map((h) => h.seq).filter(Boolean).sort((a, b) => a - b);
      if (!seqs.length) return 0;
      let c = seqs[0];
      for (let k = 1; k < seqs.length && seqs[k] === c + 1; k++) c = seqs[k];
      return c;
    }

    // Kaçırılan sohbet mesajlarını iste (en fazla 2 sn'de bir)
    _resend() {
      if (Date.now() - (this.lastResend || 0) < 2000) return;
      this.lastResend = Date.now();
      // Geçmişteki ilk boşluğun öncesinden itibaren iste
      this.send({ t: 'resend', after: this._contiguous() });
    }

    _ping() {
      this.send({ t: 'ping', c: Date.now() });
    }

    send(obj) {
      // Sohbet mesajları ulaşana kadar (sunucu herkese, gönderene de yollar) 3 sn arayla tekrar denenir
      if (obj && obj.t === 'chat' && !obj.cid) {
        obj = { ...obj, cid: Math.random().toString(36).slice(2, 12) };
        this._trackChat(obj);
      }
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify(obj));
        if (this.me) this._local(obj);
        return true;
      }
      return false;
    }

    // Kendi gönderdiklerimizi yerel duruma da işle (sunucu bize geri yollamıyor)
    _local(m) {
      const meId = this.me.id;
      if (m.t === 'sync') {
        const paused = m.action === 'pause' ? true : m.action === 'play' ? false : !!m.paused;
        this.roomState = { paused, time: m.time, at: typeof m.at === 'number' ? m.at : this.serverNow(), url: this.me.url, by: meId, rel: !!m.rel };
      } else if (m.t === 'tick') {
        this.roomState = { paused: !!m.paused, time: m.time, at: typeof m.at === 'number' ? m.at : this.serverNow(), url: this.me.url, by: meId, rel: !!m.rel };
      } else if (m.t === 'nav') {
        this.me = { ...this.me, url: m.url || null, title: m.title || '', platform: m.platform || '', watching: !!m.watching && !!m.url };
        this._upsert(this.me);
      } else if (m.t === 'buffer') {
        this.me = { ...this.me, buffering: !!m.on };
        this._upsert(this.me);
      }
    }

    _upsert(member) {
      const i = this.members.findIndex((x) => x.id === member.id);
      if (i >= 0) this.members[i] = member;
      else this.members.push(member);
    }

    _setState(state, error) {
      this.state = state;
      this.error = error || '';
      this.onEvent(this.status());
    }

    status() {
      return {
        t: 'status',
        wsState: this.state,
        lastError: this.error,
        clockOffset: this.clockOffset,
        rtt: Number.isFinite(this.bestRtt) ? this.bestRtt : null,
        room: {
          lock: this.lock,
          lastAction: this.lastAction || 0,
          me: this.me,
          name: this.roomName,
          server: this.serverName,
          members: this.members,
          state: this.roomState,
          history: this.history,
        },
      };
    }

    _handle(m) {
      // Sunucuda bizim görmediğimiz sohbet mesajı var mı? (pong, tick ve drift söyler)
      if (this.me && typeof m.cs === 'number' && m.cs > (this.lastSeq || 0)) this._resend();
      switch (m.t) {
        case 'pong': {
          const now = Date.now();
          const rtt = now - m.c;
          if (rtt < 0 || typeof m.s !== 'number') return;
          // Son 12 ölçümden gidiş-dönüşü en kısa olanı en doğru saat farkını verir
          // (yolda bekleyen mesaj ölçümü bozar). Pencere kaydığı için ağ değişse de güncel kalır.
          const samples = (this.clockSamples = this.clockSamples || []);
          samples.push({ rtt, off: m.s + rtt / 2 - now });
          if (samples.length > 12) samples.shift();
          const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
          this.bestRtt = best.rtt;
          this.rtt = rtt;
          this.clockOffset = best.off;
          this.onEvent({ t: 'clock', offset: this.clockOffset, rtt: best.rtt, lastRtt: rtt });
          return;
        }
        case 'welcome':
          clearTimeout(this.joinTimer);
          this.me = m.you;
          this.roomName = m.room;
          this.serverName = m.server || null;
          this.members = m.members || [];
          this.roomState = m.state || null;
          this.lastAction = m.lastAction || 0;
          this.lock = m.lock !== false;
          this.history = m.history || [];
          this.lastSeq = this._contiguous();
          this.prevId = m.you && m.you.id;
          this.typing = {};
          this.state = 'bağlı';
          this.error = '';
          break;
        case 'error':
          if (m.code === 'password') {
            this.config = null;
            this.disconnect(true);
            this.config = null;
            this._setState('hata', 'Şifre yanlış. Sunucuyu açan kişiye sor.');
            this.onEvent(m);
            return;
          }
          break;
        case 'member-join':
          this._upsert(m.member);
          break;
        case 'member-leave':
          this.members = this.members.filter((x) => x.id !== m.member.id);
          delete this.typing[m.member.id];
          break;
        case 'nav':
        case 'buffer':
          this._upsert(m.member);
          // Kendi bilgimiz değiştiyse (ör. yönetici bize devredildi) "me"yi de güncelle
          if (this.me && m.member.id === this.me.id) this.me = { ...this.me, ...m.member };
          break;
        case 'lock':
          this.lock = !!m.on;
          break;
        case 'state':
          // Kendi kumanda hareketimizin sunucudaki sonucu
          if (m.state) this.roomState = m.state;
          break;
        case 'chat':
          if (m.cid && this.pendingChats && this.pendingChats.has(m.cid)) {
            clearTimeout(this.pendingChats.get(m.cid).timer);
            this.pendingChats.delete(m.cid);
          }
          // Tekrar iletilen mesajı ikinci kez gösterme
          if (m.cid && this.history.some((h) => h.cid === m.cid)) return;
          if (m.seq && this.history.some((h) => h.seq === m.seq)) return;
          if (m.seq) {
            const last = this.lastSeq || 0;
            if (m.seq > last + 1) this._resend(); // arada kaçırdığımız var
            // Geç gelen (yeniden istenen) mesajı sırasına yerleştir
            const i = this.history.findIndex((h) => h.seq && h.seq > m.seq);
            if (i >= 0) {
              this.history.splice(i, 0, m);
              this.lastSeq = this._contiguous();
              m = { ...m, late: true };
              if (this.history.length > HISTORY) this.history.shift();
              if (m.from) delete this.typing[m.from];
              break;
            }
          }
          this.history.push(m);
          if (this.history.length > HISTORY) this.history.shift();
          if (m.seq) this.lastSeq = this._contiguous();
          if (m.from) delete this.typing[m.from];
          break;
        case 'typing':
          if (m.on) this.typing[m.from] = { name: m.name, until: Date.now() + 6000 };
          else delete this.typing[m.from];
          break;
        case 'sync':
        case 'tick':
          this.roomState = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by, rel: !!m.rel };
          break;
        case 'countdown':
          this.roomState = { paused: false, time: m.time, at: m.at, url: m.url, by: m.from, rel: !!m.rel };
          break;
      }
      this.onEvent(m);
      if (m.t === 'welcome') this.onEvent(this.status());
    }

    // Oda durumuna göre şu anki beklenen konum (sn)
    expectedTime(st = this.roomState) {
      if (!st) return 0;
      return st.paused ? st.time : st.time + Math.max(0, this.serverNow() - st.at) / 1000;
    }

    typingNames() {
      const now = Date.now();
      return Object.entries(this.typing)
        .filter(([, v]) => v.until > now)
        .map(([, v]) => v.name);
    }
  }

  root.OrtakIzleRoom = {
    RoomClient,
    RelaySocket,
    Mqtt,
    BROKERS,
    toWsUrl,
    displayAddress,
    normalizeCode,
    formatCode,
    isCode,
    newCode,
    relayKeys,
    seal,
    open,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
