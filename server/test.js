// Sunucu testi: node test.js  (Node 22+ yerleşik WebSocket istemcisini kullanır)
'use strict';
const assert = require('assert');
process.env.ODA_SIFRE = 'gizli';
const { server } = require('./server');

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
    next(pred, ms = 2000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('zaman aşımı')), ms);
      });
    },
    none(pred, ms = 300) {
      return new Promise((resolve, reject) =>
        setTimeout(() => (inbox.some(pred) ? reject(new Error('beklenmeyen mesaj')) : resolve()), ms)
      );
    },
    close: () => ws.close(),
  };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.strictEqual(res.status, 200);
  assert.ok((await res.text()).includes('Ortak İzle'));
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/../server.js`)).status, 404);

  const a = client(port);
  const b = client(port);
  await Promise.all([a.ready, b.ready]);

  b.send({ t: 'join', room: 'Salon', name: 'Kardeş', password: 'yanlış' });
  assert.strictEqual((await b.next((m) => m.t === 'error')).code, 'password');

  a.send({ t: 'join', room: 'Salon', name: 'Berkay', password: 'gizli' });
  const wa = await a.next((m) => m.t === 'welcome');
  assert.strictEqual(wa.room, 'salon');

  b.send({ t: 'join', room: 'salon', name: 'Kardeş', password: 'gizli' });
  const wb = await b.next((m) => m.t === 'welcome');
  assert.strictEqual(wb.members.length, 2);
  assert.strictEqual((await a.next((m) => m.t === 'member-join')).member.name, 'Kardeş');

  // Ping/pong saat eşitleme
  b.send({ t: 'ping', c: 123 });
  const pong = await b.next((m) => m.t === 'pong');
  assert.strictEqual(pong.c, 123);

  // Sohbet herkese gider
  a.send({ t: 'chat', text: 'selam' });
  assert.strictEqual((await b.next((m) => m.t === 'chat' && !m.system)).text, 'selam');
  assert.strictEqual((await a.next((m) => m.t === 'chat' && !m.system)).text, 'selam');

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

  // Konum bildirimi sadece son kumanda edenden kabul edilir
  b.send({ t: 'tick', time: 10, paused: false });
  await a.none((m) => m.t === 'tick');
  a.send({ t: 'tick', time: 70, paused: false });
  assert.strictEqual((await b.next((m) => m.t === 'tick')).time, 70);

  // Davet
  b.send({ t: 'invite', url: 'https://play.hbomax.com/video/watch/x/y', title: 'The Last of Us' });
  assert.strictEqual((await a.next((m) => m.t === 'invite')).name, 'Kardeş');

  // Geçersiz URL kabul edilmez
  b.send({ t: 'nav', url: 'javascript:alert(1)', watching: true });
  assert.strictEqual((await a.next((m) => m.t === 'nav')).member.url, null);

  // Ayrılınca diğeri haber alır, kumanda boşa düşer
  a.close();
  assert.strictEqual((await b.next((m) => m.t === 'member-leave')).member.name, 'Berkay');
  b.send({ t: 'tick', time: 99, paused: false });

  // Sonradan katılan güncel durumu alır
  const c = client(port);
  await c.ready;
  c.send({ t: 'join', room: 'salon', name: 'Üçüncü', password: 'gizli' });
  const wc = await c.next((m) => m.t === 'welcome');
  assert.strictEqual(wc.state.time, 99);
  assert.ok(wc.history.some((m) => m.text === 'selam'));

  b.close();
  c.close();
  server.close();
  console.log('Tüm testler geçti ✔');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
