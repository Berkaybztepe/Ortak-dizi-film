// ZOR KOŞUL testi (uygulama benzetimi): mesaj kaybı, platform oynatıcısının komutu geri alması,
// aynı bölümün farklı adreslerle açılması, cevap vermeyen "yükleniyor". Altta uygulamanın JS tarafı.
// Orijinal açıklama: Android uygulamasının JavaScript tarafının uçtan uca testi. Yerel (Kotlin) köprüyü
// taklit eder: arayüz sayfası + oynatıcı sayfası, aradaki mesajlar MainActivity'deki gibi
// (OrtakNative.toPlayer / OI.fromPlayer) taşınır.
//   node tests/e2e-app.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT, loadPlaywright, chromeOptions, testVideo, routeFakeDisney, startServer, startBroker, TEST_CODE, reporter, sleep } from './helpers.mjs';

const { chromium } = await loadPlaywright();
const VIDEO = testVideo();
const ENGINE = fs.readFileSync(path.join(ROOT, 'web/engine.js'), 'utf8');
const SHOTS = process.env.SHOTS_DIR || os.tmpdir();
// MainActivity.bootstrapScript ile aynı yapıştırıcı
const BOOT = `(function(){ if (window.top !== window) return;\n${ENGINE}\n})();
;(function () {
  if (window.top !== window || window.__ortakIzle) return;
  window.__ortakIzle = true;
  function post(m) { window.__toUi(JSON.stringify(m)); }
  function start() {
    var engine = OrtakIzleEngine.create({ post: post, displayFont: 'OI Display' });
    window.__ortakIzleRecv = function (m) { engine.receive(typeof m === 'string' ? JSON.parse(m) : m); };
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

const PORT = 8794;
const broker = await startBroker(18880, 18881);
const srv = await startServer(PORT, { ODA_KODU: TEST_CODE, ARACI: broker.ws });
await sleep(800);
const browser = await chromium.launch(chromeOptions({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] }));

const ALLOWED = new Set(['hello', 'engine', 'sync', 'tick', 'nav', 'buffer', 'countdown', 'react', 'invite', 'typing', 'drift', 'notice']);
async function app(label, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await routeFakeDisney(ctx, VIDEO);
  const ui = await ctx.newPage();
  const player = await ctx.newPage();
  const log = [];
  ui.on('pageerror', (e) => log.push('UI hata: ' + e.message));
  player.on('pageerror', (e) => log.push('Oynatıcı hata: ' + e.message));
  await player.addInitScript(BOOT);
  await player.exposeFunction('__toUi', async (raw) => {
    const o = JSON.parse(raw);
    if (!ALLOWED.has(o.t)) return;
    await ui.evaluate((m) => window.OI && OI.fromPlayer(m), o).catch(() => {});
  });
  const calls = [];
  await ui.exposeFunction('__native', async (fn, args) => {
    calls.push(fn);
    if (fn === 'openPlayer') {
      await player.goto(args[0]);
      await ui.evaluate(() => OI.setLayout({ mode: 'side' }));
    } else if (fn === 'toPlayer') {
      await player.evaluate((j) => window.__ortakIzleRecv && __ortakIzleRecv(j), args[0]).catch(() => {});
    } else if (fn === 'closePlayer') {
      await player.goto('about:blank');
      await ui.evaluate(() => OI.setLayout({ mode: 'full' }));
    }
  });
  await ui.addInitScript((url) => (window.__ortakIzleBrokers = [url]), broker.ws);
  await ui.addInitScript(() => {
    const fns = ['openPlayer', 'closePlayer', 'toPlayer', 'setPanel', 'setFloatSize', 'setDesktopMode', 'keepScreenOn', 'share', 'startDiscovery', 'stopDiscovery', 'stopHost'];
    window.OrtakNative = { getInfo: () => JSON.stringify({ hosting: false, port: -1, addresses: [] }), startHost: () => JSON.stringify({ ok: false, error: 'test' }) };
    for (const f of fns) window.OrtakNative[f] = (...a) => { window.__native(f, a); return ''; };
  });
  await ui.goto(`http://127.0.0.1:${PORT}/index.html`);
  return { ctx, ui, player, log, calls, label };
}

const R = reporter();
const { pass, fail } = R;
const vs = (p) => p.evaluate(() => ({ paused: v.paused, t: +v.currentTime.toFixed(2) }));


async function waitFor(fn, ms = 10000, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(every);
  }
  return null;
}
const both = async (A, B, pred) => pred(await vs(A.player), await vs(B.player));

try {
  const A = await app('Berkay', 1280, 800);
  const B = await app('Kardeş', 400, 860);
  for (const X of [A, B]) {
    await X.ui.fill('#nameInput', X.label);
    await X.ui.click('#nameForm button');
    await X.ui.fill('#codeInput', 'k7m4qx');
    await X.ui.click('#codeForm button');
  }
  (await waitFor(async () => /2 kişi/.test(await A.ui.locator('#connText').innerText()), 15000)) ? pass('İkisi bağlandı') : fail('Bağlanamadılar');

  // Aynı bölüm, farklı adreslerle (biri yönlendirmeli/dil önekli gibi)
  await A.ui.locator('.pf[data-p="disney"]').click();
  await sleep(1200);
  await A.player.goto('https://www.disneyplus.com/play/loki');
  await B.ui.locator('.pf[data-p="disney"]').click();
  await sleep(1200);
  await B.player.goto('https://www.disneyplus.com/tr-tr/video/loki-s1e1?ref=home');
  await A.player.waitForFunction(() => window.v && v.readyState >= 1);
  await B.player.waitForFunction(() => window.v && v.readyState >= 1);
  await sleep(2500);
  await A.player.evaluate(() => { window.tap && tap(); v.currentTime = 40; v.play(); });
  (await waitFor(() => both(A, B, (a, b) => !b.paused && Math.abs(a.t - b.t) < 1.5), 8000))
    ? pass('Farklı adreslerle açılmış aynı bölüm yine senkron')
    : fail('Farklı adres: ' + JSON.stringify([await vs(A.player), await vs(B.player)]));

  // İnatçı oynatıcı: B'nin oynatıcısı uzaktan gelen "durdur"u bir kez geri alıyor
  await B.player.evaluate(() => (window.__resist = 1));
  await A.player.evaluate(() => (window.tap && tap(), v.pause()));
  await sleep(4000);
  let a = await vs(A.player), b = await vs(B.player);
  a.paused && b.paused
    ? pass(`Oynatıcı durdurmayı geri alsa da ikisi de durdu ve A kendiliğinden oynamadı (A ${a.t}, B ${b.t})`)
    : fail(`İnatçı oynatıcı: A ${JSON.stringify(a)} B ${JSON.stringify(b)}`);

  // Mesaj kaybı: aracı, mesajların %35'ini düşürüyor; 6 tur oynat/durdur/sar
  broker.setLoss(0.35);
  let ok = 0;
  const N = 6;
  for (let i = 0; i < N; i++) {
    const actor = i % 2 ? B : A;
    if (i % 3 === 2) {
      const target = 100 + i * 20;
      await actor.player.evaluate((t) => { window.tap && tap(); v.currentTime = t; }, target);
    } else {
      await actor.player.evaluate(() => (window.tap && tap(), v.paused ? v.play() : v.pause()));
    }
    const conv = await waitFor(() => both(A, B, (x, y) => x.paused === y.paused && Math.abs(x.t - y.t) < 2.2), 9000, 300);
    if (conv) ok++;
    else console.log('    tur', i, 'eşitlenmedi:', JSON.stringify([await vs(A.player), await vs(B.player)]));
    await sleep(1200);
  }
  console.log(`    (aracı ${broker.state.dropped} mesaj düşürdü)`);
  ok === N ? pass(`%35 mesaj kaybında ${N}/${N} hareket iki tarafta da eşitlendi (en geç birkaç sn)`) : fail(`Mesaj kaybında ${ok}/${N} eşitlendi`);

  // Mesaj kaybında sohbet: tekrar gönderimle ulaşmalı
  await B.ui.locator('#chatInput').fill('kayıpta bile geldi mi');
  await B.ui.locator('#chatInput').press('Enter');
  (await waitFor(async () => /kayıpta bile geldi mi/.test(await A.ui.locator('#vWatch').innerText()), 20000))
    ? pass('Mesaj kaybına rağmen sohbet mesajı ulaştı')
    : fail(`Sohbet mesajı kayboldu (A: ${(await A.ui.locator('#vWatch').innerText()).slice(-300).replace(/\n/g, ' | ')})`);
  broker.setLoss(0);
  await sleep(2000);

  // Takılan "yükleniyor": üçüncü kişi yükleniyor deyip bir daha haber vermiyor
  // (videonun sonuna gelinmesin diye önce başa yakın bir yere)
  await A.player.evaluate(() => { window.tap && tap(); v.pause(); v.currentTime = 20; });
  await sleep(1500);
  await A.player.evaluate(() => (window.tap && tap(), v.play()));
  await waitFor(() => both(A, B, (x, y) => !x.paused && !y.paused), 8000);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: 'join', name: 'Kuzen', room: 'salon' }));
  await sleep(300);
  ws.send(JSON.stringify({ t: 'nav', url: 'https://www.disneyplus.com/play/loki', title: 'Loki', platform: 'Disney+', watching: true }));
  await sleep(300);
  ws.send(JSON.stringify({ t: 'buffer', on: true }));
  const held = await waitFor(() => both(A, B, (x, y) => x.paused && y.paused), 6000);
  held ? pass('Biri yüklenirken ikisi de bekledi') : fail('Beklemedi');
  const resumed = await waitFor(() => both(A, B, (x, y) => !x.paused && !y.paused), 20000, 500);
  resumed ? pass('"Yükleme bitti" hiç gelmese de en geç 12 sn sonra devam edildi') : fail(`Sonsuza kadar bekledi: ${JSON.stringify([await vs(A.player), await vs(B.player)])}`);
  ws.close();

  for (const X of [A, B]) for (const l of X.log) fail(`${X.label}: ${l}`);
} catch (e) {
  fail(e.stack);
} finally {
  srv.kill();
  await browser.close();
  await broker.close();
}
console.log(R.failed ? `BAŞARISIZ (${R.failed})` : 'Zor koşul testi geçti ✔');
process.exit(R.failed ? 1 : 0);
