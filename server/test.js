// Sunucu testi: node test.js  (Node 22+ yerleşik WebSocket istemcisini kullanır)
// Başka bir sunucuyu (ör. Android uygulamasındaki Kotlin sunucusu) aynı testten
// geçirmek için: ODA_SIFRE=gizli ile başlatın, sonra TEST_PORT=8787 node test.js
'use strict';
const assert = require('assert');
process.env.ODA_SIFRE = 'gizli';
const EXTERNAL = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT, 10) : 0;
const { server } = EXTERNAL ? { server: null } : require('./server');
// Oda koduyla (aracı üzerinden) dene: TEST_RELAY_CODE=ABC123 TEST_RELAY_BROKER=ws://127.0.0.1:18831/mqtt
const RELAY_CODE = process.env.TEST_RELAY_CODE || '';
const RELAY_BROKER = process.env.TEST_RELAY_BROKER || '';
if (RELAY_CODE) require('../web/room-client.js');

function client(port) {
  const ws = RELAY_CODE
    ? new globalThis.OrtakIzleRoom.RelaySocket(RELAY_CODE, [RELAY_BROKER])
    : new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  };
  return {
    ready: new Promise((r) => (ws.onopen = r)),
    send: (o) => ws.send(JSON.stringify(o)),
    raw: (text) => ws.send(text),
    next(pred, ms = 2000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      if (RELAY_CODE) ms *= 2; // aracı üzerinden biraz daha yavaş
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('zaman aşımı: ' + pred)), ms);
      });
    },
    none(pred, ms = RELAY_CODE ? 600 : 300) {
      return new Promise((resolve, reject) =>
        setTimeout(() => (inbox.some(pred) ? reject(new Error('beklenmeyen mesaj')) : resolve()), ms)
      );
    },
    close: () => ws.close(),
  };
}

(async () => {
  let port = EXTERNAL;
  if (!EXTERNAL) {
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;
  }

  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.strictEqual(res.status, 200);
  assert.ok((await res.text()).includes('Ortak İzle'));
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/../server.js`)).status, 404);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.strictEqual(health.app, 'ortak-izle');
  assert.strictEqual(health.password, true);

  const a = client(port);
  const b = client(port);
  await Promise.all([a.ready, b.ready]);

  b.send({ t: 'join', room: 'Salon', name: 'Kardeş', password: 'yanlış' });
  assert.strictEqual((await b.next((m) => m.t === 'error')).code, 'password');

  a.send({ t: 'join', room: 'Salon', name: 'Berkay', password: 'gizli' });
  const wa = await a.next((m) => m.t === 'welcome');
  assert.strictEqual(wa.room, 'salon');

  b.send({ t: 'join', room: 'salon', name: 'Kardeş', password: 'gizli', kind: 'app' });
  const wb = await b.next((m) => m.t === 'welcome');
  assert.strictEqual(wb.members.length, 2);
  assert.strictEqual(wb.you.kind, 'app');
  assert.strictEqual(typeof wb.server, 'string');
  assert.strictEqual((await a.next((m) => m.t === 'member-join')).member.name, 'Kardeş');

  // Ping/pong saat eşitleme
  b.send({ t: 'ping', c: 123 });
  const pong = await b.next((m) => m.t === 'pong');
  assert.strictEqual(pong.c, 123);

  // Sohbet herkese gider
  a.send({ t: 'chat', text: 'selam' });
  assert.strictEqual((await b.next((m) => m.t === 'chat' && !m.system)).text, 'selam');
  assert.strictEqual((await a.next((m) => m.t === 'chat' && !m.system)).text, 'selam');

  // Aynı kimlikle tekrar gönderilen sohbet mesajı çoğalmaz, yalnızca gönderene tekrar bildirilir
  const cid = 'c' + Math.random().toString(36).slice(2, 10);
  a.send({ t: 'chat', text: 'tekrar', cid });
  assert.strictEqual((await b.next((m) => m.t === 'chat' && m.cid === cid)).text, 'tekrar');
  await a.next((m) => m.t === 'chat' && m.cid === cid);
  a.send({ t: 'chat', text: 'tekrar', cid });
  const again = await b.next((m) => m.t === 'chat' && m.cid === cid);
  assert.strictEqual(again.at, (await a.next((m) => m.t === 'chat' && m.cid === cid)).at); // aynı mesaj, yeni değil

  // Hangi sayfada olduğu
  a.send({ t: 'nav', url: 'https://www.disneyplus.com/play/abc', title: 'Loki', platform: 'Disney+', watching: true });
  const nav = await b.next((m) => m.t === 'nav');
  assert.strictEqual(nav.member.title, 'Loki');
  assert.ok(nav.watching);

  // Senkron: A durdurur -> B'ye gider, A'ya geri gelmez
  a.send({ t: 'sync', action: 'pause', time: 61.5 });
  const s = await b.next((m) => m.t === 'sync');
  assert.deepStrictEqual([s.action, s.paused, s.time, s.name], ['pause', true, 61.5, 'Berkay']);
  assert.strictEqual(s.url, 'https://www.disneyplus.com/play/abc');
  await a.none((m) => m.t === 'sync');

  // Güvenli mod: rel bayrağı ve sarma miktarı (delta, eksi olabilir) iletilir
  a.send({ t: 'sync', action: 'seek', time: 5, paused: true, rel: true, delta: -10 });
  const rs = await b.next((m) => m.t === 'sync' && m.action === 'seek');
  assert.deepStrictEqual([rs.rel, rs.delta], [true, -10]);
  a.send({ t: 'sync', action: 'pause', time: 61.5 });
  const nr = await b.next((m) => m.t === 'sync' && m.action === 'pause');
  assert.strictEqual(nr.rel, undefined);

  // Konum bildirimi sadece son kumanda edenden kabul edilir
  b.send({ t: 'tick', time: 10, paused: false });
  await a.none((m) => m.t === 'tick');

  // Fark bildirimi diğerlerine gider
  b.send({ t: 'drift', err: 0.1234 });
  assert.strictEqual((await a.next((m) => m.t === 'drift')).err, 0.12);
  b.send({ t: 'drift', err: 'x' });
  assert.strictEqual((await a.next((m) => m.t === 'drift')).err, null);

  // Kumandayı değiştiren hareket yolda kaybolduysa: daha yeni "since" taşıyan tick kabul edilir
  a.send({ t: 'sync', action: 'pause', time: 70 });
  await b.next((m) => m.t === 'sync' && m.time === 70);
  b.send({ t: 'tick', time: 11, paused: true, since: Date.now() - 60000 }); // eski: reddedilir
  await a.none((m) => m.t === 'tick' && m.time === 11);
  b.send({ t: 'tick', time: 12, paused: true, since: Date.now() }); // yeni hareket: kumanda B'ye geçer
  assert.strictEqual((await a.next((m) => m.t === 'tick' && m.time === 12)).by, wb.you.id);
  a.send({ t: 'tick', time: 13, paused: true }); // artık A'nınki reddedilir
  await b.none((m) => m.t === 'tick' && m.time === 13);
  a.send({ t: 'sync', action: 'pause', time: 70 });
  await b.next((m) => m.t === 'sync' && m.time === 70);
  a.send({ t: 'tick', time: 70, paused: false });
  assert.strictEqual((await b.next((m) => m.t === 'tick' && m.time === 70)).time, 70);

  // Davet
  b.send({ t: 'invite', url: 'https://play.hbomax.com/video/watch/x/y', title: 'The Last of Us' });
  assert.strictEqual((await a.next((m) => m.t === 'invite')).name, 'Kardeş');

  // Tepki: izin verilen emoji iletilir, diğerleri yok sayılır
  a.send({ t: 'react', emoji: '<script>' });
  a.send({ t: 'react', emoji: '😂' });
  assert.strictEqual((await b.next((m) => m.t === 'react')).emoji, '😂');

  // Yazıyor göstergesi
  b.send({ t: 'typing', on: true });
  const ty = await a.next((m) => m.t === 'typing');
  assert.deepStrictEqual([ty.on, ty.name], [true, 'Kardeş']);

  // Yükleniyor (buffer) durumu üyelere yansır, tekrarlanan aynı durum yayınlanmaz
  b.send({ t: 'buffer', on: true });
  const bf = await a.next((m) => m.t === 'buffer');
  assert.deepStrictEqual([bf.on, bf.member.name, bf.member.buffering], [true, 'Kardeş', true]);
  b.send({ t: 'buffer', on: true });
  await a.none((m) => m.t === 'buffer');
  b.send({ t: 'buffer', on: false });
  assert.strictEqual((await a.next((m) => m.t === 'buffer')).on, false);

  // Geri sayım herkese (gönderen dahil) aynı başlangıç anıyla gider
  const before = Date.now();
  a.send({ t: 'countdown', time: 42 });
  const ca = await a.next((m) => m.t === 'countdown');
  const cb = await b.next((m) => m.t === 'countdown');
  assert.strictEqual(ca.at, cb.at);
  assert.strictEqual(cb.time, 42);
  assert.ok(ca.at - before > 2000 && ca.at - before < 6000);

  // Yönetici: odayı açan cihaz (sunucuya bu cihazdan ilk bağlanan); kilidi yalnızca o değiştirir
  if (!RELAY_CODE) {
    assert.strictEqual(wa.you.admin, true);
    assert.strictEqual(wb.you.admin, false);
  }
  assert.strictEqual(wa.lock, true);
  b.send({ t: 'lock', on: false });
  await a.none((m) => m.t === 'lock');
  if (!RELAY_CODE) {
    a.send({ t: 'lock', on: false });
    assert.strictEqual((await b.next((m) => m.t === 'lock')).on, false);
    a.send({ t: 'lock', on: true });
    assert.strictEqual((await b.next((m) => m.t === 'lock')).on, true);
  }

  // Gönderenin ölçüm anı korunur (ağ gecikmesi senkrona eklenmez); saçma değerler yok sayılır
  const past = Date.now() - 800;
  a.send({ t: 'sync', action: 'pause', time: 50, at: past });
  assert.strictEqual((await b.next((m) => m.t === 'sync' && m.time === 50)).at, past);
  const t0 = Date.now();
  a.send({ t: 'sync', action: 'pause', time: 51, at: past - 60000 });
  assert.ok((await b.next((m) => m.t === 'sync' && m.time === 51)).at >= t0 - 50);
  // Planlı başlatma: birkaç yüz ms sonrası kabul edilir, çok ileri tarih edilmez
  const fut = Date.now() + 700;
  a.send({ t: 'sync', action: 'play', time: 52, at: fut });
  assert.strictEqual((await b.next((m) => m.t === 'sync' && m.time === 52)).at, fut);
  a.send({ t: 'sync', action: 'play', time: 53, at: Date.now() + 60000 });
  assert.ok((await b.next((m) => m.t === 'sync' && m.time === 53)).at < Date.now() + 1000);
  const tk = Date.now() - 300;
  a.send({ t: 'tick', time: 54, paused: false, at: tk });
  assert.strictEqual((await b.next((m) => m.t === 'tick' && m.time === 54)).at, tk);

  // İzleyen biri bölümden çıkınca video herkeste durur
  b.send({ t: 'nav', url: 'https://www.disneyplus.com/play/abc', title: 'Loki', platform: 'Disney+', watching: true });
  await a.next((m) => m.t === 'nav' && m.member.name === 'Kardeş');
  a.send({ t: 'nav', url: 'https://www.disneyplus.com/browse', title: '', platform: 'Disney+', watching: false });
  const ex = await b.next((m) => m.t === 'sync' && m.reason);
  assert.deepStrictEqual([ex.reason, ex.paused, ex.name, ex.action], ['exit', true, 'Berkay', 'pause']);
  assert.ok(ex.time >= 54);
  await a.none((m) => m.t === 'sync' && m.reason);
  // Durmuşken çıkmak bir şey değiştirmez
  a.send({ t: 'nav', url: 'https://www.disneyplus.com/play/abc', title: 'Loki', platform: 'Disney+', watching: true });
  a.send({ t: 'nav', url: 'https://www.disneyplus.com/browse', title: '', platform: 'Disney+', watching: false });
  await b.none((m) => m.t === 'sync' && m.reason);

  // Bölüm değişince takılı kalmış "yükleniyor" temizlenir
  b.send({ t: 'buffer', on: true });
  assert.strictEqual((await a.next((m) => m.t === 'buffer')).on, true);
  b.send({ t: 'nav', url: 'https://www.disneyplus.com/play/def', title: 'Loki 2', platform: 'Disney+', watching: true });
  const bo = await a.next((m) => m.t === 'buffer');
  assert.deepStrictEqual([bo.on, bo.member.buffering], [false, false]);
  assert.strictEqual((await a.next((m) => m.t === 'nav' && m.member.title === 'Loki 2')).member.watching, true);

  // Geçersiz URL kabul edilmez
  b.send({ t: 'nav', url: 'javascript:alert(1)', watching: true });
  assert.strictEqual((await a.next((m) => m.t === 'nav')).member.url, null);

  // Ayrılınca diğeri haber alır, izlerken ayrıldıysa video durur, kumanda boşa düşer
  a.send({ t: 'nav', url: 'https://www.disneyplus.com/play/abc', title: 'Loki', platform: 'Disney+', watching: true });
  a.send({ t: 'sync', action: 'play', time: 61.5 });
  await b.next((m) => m.t === 'sync' && m.time === 61.5);
  a.close();
  assert.strictEqual((await b.next((m) => m.t === 'member-leave')).member.name, 'Berkay');
  const lf = await b.next((m) => m.t === 'sync' && m.reason);
  assert.deepStrictEqual([lf.reason, lf.paused, lf.by], ['left', true, null]);
  b.send({ t: 'tick', time: 99, paused: false });

  // Sonradan katılan güncel durumu alır
  const c = client(port);
  await c.ready;
  c.send({ t: 'join', room: 'salon', name: 'Üçüncü', password: 'gizli' });
  const wc = await c.next((m) => m.t === 'welcome');
  assert.strictEqual(wc.state.time, 99);
  assert.ok(wc.history.some((m) => m.text === 'selam'));

  // Bozuk girdiler sunucuyu düşürmez
  c.raw('{bozuk json');
  c.raw('null');
  c.raw('[1,2]');
  // (her çalıştırmada farklı metin: önceki çalıştırmanın tekrar gönderimi karışmasın)
  const LONG = Math.random().toString(36).slice(2, 8) + 'x'.repeat(5000);
  c.send({ t: 'chat', text: LONG });
  c.send({ t: 'sync', action: 'play', time: 'abc' });
  const long = await b.next((m) => m.t === 'chat' && !m.system && m.name === 'Üçüncü' && m.text.startsWith(LONG.slice(0, 6)));
  assert.strictEqual(long.text.length, 1000);
  const play = await b.next((m) => m.t === 'sync' && m.name === 'Üçüncü');
  assert.strictEqual(play.time, 0);

  // Sohbet sıra numarası: pong son numarayı söyler, "resend" kaçanları yeniden yollar
  assert.ok(long.seq > 1);
  c.send({ t: 'ping', c: 1 });
  assert.strictEqual((await c.next((m) => m.t === 'pong')).cs, long.seq);
  c.send({ t: 'resend', after: long.seq - 2 });
  const r1 = await c.next((m) => m.t === 'chat' && m.seq === long.seq - 1);
  const r2 = await c.next((m) => m.t === 'chat' && m.seq === long.seq);
  assert.strictEqual(r2.text, long.text);
  assert.ok(r1.seq < r2.seq);

  b.close();
  c.close();
  if (RELAY_CODE) await new Promise((r) => setTimeout(r, 800)); // "bye" mesajları gitsin
  if (server) server.close();
  console.log('Tüm testler geçti ✔');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
