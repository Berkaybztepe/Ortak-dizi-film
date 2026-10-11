// Android uygulamasının JavaScript tarafının uçtan uca testi. Yerel (Kotlin) köprüyü
// taklit eder: arayüz sayfası + oynatıcı sayfası, aradaki mesajlar MainActivity'deki gibi
// (OrtakNative.toPlayer / OI.fromPlayer) taşınır.
//   node tests/e2e-app.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT, loadPlaywright, chromeOptions, testVideo, routeFakeDisney, startServer, reporter, sleep } from './helpers.mjs';

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

const PORT = 8798;
const srv = await startServer(PORT);
const browser = await chromium.launch(chromeOptions({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] }));

const ALLOWED = new Set(['hello', 'engine', 'sync', 'tick', 'nav', 'buffer', 'countdown', 'react', 'invite', 'typing']);
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

try {
  const A = await app('Berkay', 1280, 800);
  const B = await app('Kardeş', 400, 860);

  for (const X of [A, B]) {
    await X.ui.fill('#nameInput', X.label);
    await X.ui.click('#nameForm button');
    await X.ui.fill('#addrInput', `127.0.0.1:${PORT}`);
    await X.ui.click('#joinForm button');
  }
  await sleep(1200);
  const chipA = await A.ui.locator('#connText').innerText();
  /Bağlı · 2 kişi/.test(chipA) ? pass('İkisi de salona bağlandı: ' + chipA) : fail('Bağlantı: ' + chipA);
  const seats = await A.ui.locator('#tkSeats').innerText();
  /Kardeş/.test(seats) ? pass('Bilette iki koltuk görünüyor') : fail('Bilet: ' + seats);
  await A.ui.screenshot({ path: `${SHOTS}/sim-lobby-A.png` });

  // A Disney+ açıp bölüme girer
  await A.ui.locator('.pf[data-p="disney"]').click();
  await sleep(500);
  await A.player.goto('https://www.disneyplus.com/play/loki');
  await A.player.waitForFunction(() => window.v && v.readyState >= 1);
  await sleep(3000);
  const nowB = await B.ui.locator('#nowCard').isVisible();
  const toastB = await B.ui.locator('#toasts').innerText();
  nowB && /Loki/.test(await B.ui.locator('#nowWhat').innerText()) ? pass('B\'nin salonunda "Berkay izliyor: Loki" kartı çıktı') : fail('Şu an kartı: ' + nowB);
  /Sen de aç/.test(toastB) || /Loki/.test(toastB) ? pass('B\'ye "Sen de aç" bildirimi geldi') : fail('Bildirim: ' + toastB);
  await B.ui.screenshot({ path: `${SHOTS}/sim-lobby-B.png` });
  await B.ui.locator('#nowBtn').click();
  await B.player.waitForFunction(() => window.v && v.readyState >= 1, null, { timeout: 8000 });
  await sleep(2500);
  const watchVisible = await B.ui.locator('#vWatch').isVisible();
  watchVisible ? pass('B izleme paneline geçti') : fail('İzleme paneli görünmüyor');

  await A.player.evaluate(() => { v.currentTime = 20; v.play(); });
  await sleep(2500);
  let a = await vs(A.player), b = await vs(B.player);
  !b.paused && Math.abs(a.t - b.t) < 1.5 ? pass(`Uygulamada oynat senkron (A ${a.t}, B ${b.t})`) : fail(`Oynat: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
  const chip = await B.ui.locator('#wChipTxt').innerText();
  /Senkron/.test(chip) ? pass('Panel durumu: ' + chip) : fail('Panel durumu: ' + chip);
  await B.ui.screenshot({ path: `${SHOTS}/sim-watch-B.png` });

  await B.ui.locator('#tCount').click();
  await sleep(1200);
  a = await vs(A.player);
  a.paused ? pass('3-2-1 düğmesi: A\'da geri sayım başladı (video bekliyor)') : fail('Geri sayım A: ' + JSON.stringify(a));
  await sleep(3200);
  a = await vs(A.player); b = await vs(B.player);
  !a.paused && !b.paused && Math.abs(a.t - b.t) < 0.5 ? pass(`Geri sayım sonrası birlikte (A ${a.t}, B ${b.t})`) : fail(`Geri sayım sonrası ${JSON.stringify(a)} ${JSON.stringify(b)}`);

  await B.ui.locator('#chatInput').fill('çay hazır');
  await B.ui.locator('#chatInput').press('Enter');
  await sleep(700);
  const msgsA = await A.ui.locator('#vWatch').innerText().catch(() => '');
  /çay hazır/.test(msgsA) ? pass('Mesaj A\'nın panelinde') : fail('Mesaj gelmedi');
  await B.ui.getByRole('button', { name: 'Tepki: 😂' }).click();
  await sleep(500);
  (await A.player.locator('[data-ortak-izle="stage"] .r').count()) ? pass('Tepki A\'nın videosunda uçtu') : fail('Tepki yok');

  // B salona döner
  await B.ui.locator('#homeBtn').click();
  await sleep(500);
  (await B.ui.locator('#vLobby').isVisible()) ? pass('Ana ekrana dönüş çalışıyor') : fail('Ana ekrana dönülemedi');

  for (const X of [A, B]) for (const l of X.log) fail(`${X.label}: ${l}`);
} catch (e) {
  fail(e.stack);
} finally {
  srv.kill();
  await browser.close();
}
console.log(R.failed ? `BAŞARISIZ (${R.failed})` : 'Uygulama benzetim testi geçti ✔');
process.exit(R.failed ? 1 : 0);
