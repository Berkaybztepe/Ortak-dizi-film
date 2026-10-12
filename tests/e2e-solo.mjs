// ODAYA BAĞLI DEĞİLKEN motor videoya hiç karışmamalı: sitenin kendi oynat / durdur / sar düğmeleri
// serbestçe çalışır. Bağlantı, bekleme ("X yükleniyor") ya da birlikte başlama sırasında koparsa
// yarım kalan iş de bırakılır.
//   node tests/e2e-solo.mjs
import { loadPlaywright, chromeOptions, testVideo, startServer, startBroker, TEST_CODE, reporter, sleep } from './helpers.mjs';
import { makeApp, waitFor } from './app-harness.mjs';

const { chromium } = await loadPlaywright();
const PORT = 8796;
const broker = await startBroker(18970, 18971);
const srv = await startServer(PORT, { ODA_KODU: TEST_CODE, ARACI: broker.ws });
await sleep(800);
const browser = await chromium.launch(chromeOptions({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] }));
const R = reporter();
const { pass, fail } = R;
const LOKI = 'https://www.disneyplus.com/play/loki?controls=1';
const vs = (p) => p.evaluate(() => ({ paused: v.paused, t: +v.currentTime.toFixed(2), rate: v.playbackRate }));

// Kullanıcı sitenin düğmesine basmış gibi: dokunuş + oynatıcı işlemi; 3 sn sonra hâlâ öyle mi?
async function userDoes(A, what, fn, check) {
  await A.player.evaluate(fn);
  await sleep(3000);
  const s = await vs(A.player);
  check(s) ? pass(`${what}: kaldı (${JSON.stringify(s)})`) : fail(`${what}: geri alındı ${JSON.stringify(s)}`);
}

try {
  const A = await makeApp(browser, { label: 'A', port: PORT, brokerWs: broker.ws, video: testVideo() });
  await A.ui.fill('#nameInput', 'Berkay');
  await A.ui.click('#nameForm button');
  await sleep(500);

  // ---- 1) Hiç odaya girmeden izleme
  await A.ui.locator('.pf[data-p="disney"]').click();
  await sleep(500);
  await A.player.goto(LOKI);
  await A.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  await sleep(1500);
  /Odada değilsin/.test(await A.ui.locator('#wChipTxt').innerText()) ? pass('Panelde "Odada değilsin" yazıyor (Bağlantı yok değil)') : fail('Çip: ' + (await A.ui.locator('#wChipTxt').innerText()));
  await userDoes(A, 'Odasızken oynat', () => (tap(), v.play()), (s) => !s.paused);
  await userDoes(A, 'Odasızken 10 sn ileri', () => (tap(), (v.currentTime += 10)), (s) => !s.paused && s.t > 13);
  await userDoes(A, 'Odasızken durdur', () => (tap(), v.pause()), (s) => s.paused);
  await userDoes(A, 'Odasızken çubukla sar', () => (tap(), (v.currentTime = 40)), (s) => s.paused && Math.abs(s.t - 40) < 0.3);
  // Paneldeki düğmeler de çalışır
  await A.ui.locator('#tPlay').click();
  (await waitFor(async () => !(await vs(A.player)).paused, 3000)) ? pass('Paneldeki oynat odasızken çalışıyor') : fail('Panel oynat çalışmadı');
  await A.ui.locator('#tBack').click();
  await sleep(600);
  (await vs(A.player)).t < 40 ? pass('Paneldeki 10 sn geri odasızken çalışıyor') : fail('Panel geri çalışmadı');
  A.called('input').some((i) => i.key === 'left')
    ? pass('Disney+\'ta paneldeki ±10 sitenin kendi tuşuyla yapıldı (video donmasın)')
    : fail('±10 tuşla yapılmadı: ' + JSON.stringify(A.called('input')));

  // ---- 2) Bağlantı koptu ama eski oda bilgisinde kardeş "yükleniyor" görünüyor: bekletmemeli
  const stale = (wsState) =>
    A.player.evaluate((ws) => {
      __ortakIzleRecv({
        t: 'status',
        wsState: ws,
        clockOffset: 0,
        room: {
          me: { id: 'a', name: 'Berkay' },
          members: [
            { id: 'a', name: 'Berkay', url: location.href, watching: true },
            { id: 'b', name: 'Kardeş', url: location.href, watching: true, buffering: true, bufferAt: Date.now() },
          ],
          state: { paused: false, time: v.currentTime, at: Date.now(), url: location.href, by: 'b' },
        },
      });
    }, wsState);
  await A.player.evaluate(() => (tap(), v.play()));
  await sleep(500);
  await stale('bağlı');
  (await waitFor(async () => (await vs(A.player)).paused, 3000)) ? pass('Bağlıyken kardeş yüklenirken bekletiyor (doğru)') : fail('Bağlıyken bekletmedi');
  await stale('bağlanıyor');
  await sleep(300);
  await userDoes(A, 'Bağlantı kopunca oynat (bekleme bırakıldı)', () => (tap(), v.play()), (s) => !s.paused);
  await userDoes(A, 'Bağlantı yokken durdur', () => (tap(), v.pause()), (s) => s.paused);
  await userDoes(A, 'Bağlantı yokken sar', () => (tap(), (v.currentTime = 20)), (s) => Math.abs(s.t - 20) < 0.3);
  await userDoes(A, 'Bağlantı yokken yeniden oynat', () => (tap(), v.play()), (s) => !s.paused && s.rate === 1);

  // ---- 3) Senkron sarması oynatıcıyı dondurursa kendiliğinden kurtulur, sonra tuşla sarar
  await A.player.goto('https://www.disneyplus.com/play/loki?controls=1&freezeseek=1');
  await A.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  await A.player.evaluate(() => (tap(), v.play()));
  await sleep(2500);
  await A.player.evaluate(() => {
    const room = (ws) => ({
      t: 'status',
      wsState: ws,
      clockOffset: 0,
      room: {
        me: { id: 'a', name: 'Berkay' },
        members: [
          { id: 'a', name: 'Berkay', url: location.href, watching: true },
          { id: 'b', name: 'Kardeş', url: location.href, watching: true },
        ],
        state: { paused: false, time: v.currentTime + 3, at: Date.now(), url: location.href, by: 'b' },
      },
    });
    __ortakIzleRecv(room('bağlı'));
  });
  (await waitFor(() => A.player.evaluate(() => __frozen()), 6000)) ? pass('Senkron sarması (taklit) oynatıcıyı dondurdu') : fail('Donma taklidi olmadı');
  const healed = await waitFor(async () => {
    const a = await A.player.evaluate(() => v.currentTime);
    await sleep(700);
    const b = await A.player.evaluate(() => v.currentTime);
    return !(await A.player.evaluate(() => __frozen())) && b - a > 0.3;
  }, 15000, 300);
  healed ? pass('Donan video kendiliğinden kurtarıldı (sitenin ±10 tuşuyla)') : fail('Video donuk kaldı');
  if (!healed || process.env.DBG) {
    await A.player.evaluate(() => __ortakIzleRecv({ t: 'cmd', cmd: 'diag' }));
    const d = await waitFor(() => A.posts.find((m) => m.t === 'diag'), 3000);
    console.log(d ? d.text.split('\n').slice(-40).join('\n') : 'tanı yok');
  }
  for (const l of A.log) fail(l);
} catch (e) {
  fail(e.stack);
} finally {
  srv.kill();
  await browser.close();
  await broker.close();
}
console.log(R.failed ? `BAŞARISIZ (${R.failed})` : 'Odasız / bağlantısız izleme testi geçti ✔');
process.exit(R.failed ? 1 : 0);
