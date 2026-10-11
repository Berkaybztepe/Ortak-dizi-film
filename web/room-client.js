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
      let url;
      try {
        url = toWsUrl(this.config.server);
      } catch (e) {
        this._setState('hata', 'Sunucu adresi geçersiz.');
        return;
      }
      this._setState('bağlanıyor', '');
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        this._setState('hata', 'Sunucu adresi geçersiz.');
        return;
      }
      this.ws = ws;
      this.bestRtt = Infinity;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        this.retry = 0;
        this.send({
          t: 'join',
          name: this.config.name,
          room: this.config.room || 'salon',
          password: this.config.password || '',
          kind: this.kind,
        });
        this._ping();
        setTimeout(() => this._ping(), 1500);
        clearInterval(this.pingTimer);
        // 15 sn'de bir: saat farkını tazeler, servis çalışanını uyanık tutar
        this.pingTimer = setInterval(() => this._ping(), 15000);
      };

      ws.onmessage = (e) => {
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
        this.ws = null;
        const wasJoined = !!this.me;
        this.members = [];
        this.me = null;
        if (!this.config) return this._setState('kapalı', '');
        const err = opened
          ? wasJoined
            ? 'Bağlantı koptu. Yeniden bağlanıyor…'
            : 'Sunucu bağlantıyı kapattı.'
          : 'Sunucuya ulaşılamadı. Adres doğru mu, sunucu açık mı?';
        this._setState('hata', err);
        const delay = Math.min(1000 * 2 ** this.retry++, 10000);
        this.retryTimer = setTimeout(() => this._open(), delay);
      };
    }

    _ping() {
      this.send({ t: 'ping', c: Date.now() });
    }

    send(obj) {
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
        this.roomState = { paused, time: m.time, at: this.serverNow(), url: this.me.url, by: meId };
      } else if (m.t === 'tick') {
        this.roomState = { paused: !!m.paused, time: m.time, at: this.serverNow(), url: this.me.url, by: meId };
      } else if (m.t === 'nav') {
        this.me = { ...this.me, url: m.url || null, title: m.title || '', platform: m.platform || '' };
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
        room: {
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
      switch (m.t) {
        case 'pong': {
          const now = Date.now();
          const rtt = now - m.c;
          if (rtt < 0) return;
          // En kısa gidiş-dönüş süreli ölçüm en doğru saat farkını verir
          if (rtt <= this.bestRtt * 1.5) {
            this.bestRtt = Math.min(this.bestRtt, rtt);
            this.clockOffset = m.s + rtt / 2 - now;
            this.onEvent({ t: 'clock', offset: this.clockOffset, rtt });
          }
          return;
        }
        case 'welcome':
          this.me = m.you;
          this.roomName = m.room;
          this.serverName = m.server || null;
          this.members = m.members || [];
          this.roomState = m.state || null;
          this.history = m.history || [];
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
          this._upsert(m.member);
          break;
        case 'buffer':
          this._upsert(m.member);
          break;
        case 'chat':
          this.history.push(m);
          if (this.history.length > HISTORY) this.history.shift();
          if (m.from) delete this.typing[m.from];
          break;
        case 'typing':
          if (m.on) this.typing[m.from] = { name: m.name, until: Date.now() + 6000 };
          else delete this.typing[m.from];
          break;
        case 'sync':
        case 'tick':
          this.roomState = { paused: m.paused, time: m.time, at: m.at, url: m.url, by: m.by };
          break;
        case 'countdown':
          this.roomState = { paused: false, time: m.time, at: m.at, url: m.url, by: m.from };
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

  root.OrtakIzleRoom = { RoomClient, toWsUrl, displayAddress };
})(typeof globalThis !== 'undefined' ? globalThis : self);
