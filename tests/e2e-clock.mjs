// İÇERİK SAATİ testi: platformun <video> zamanı bölümün gerçek dakikası olmadığında (Disney+ gibi)
//  1) gerçek dakika oynatıcının ilerleme çubuğundan okunup iki cihaz aynı dakikaya getirilir,
//  2) hiç okunamıyorsa güvenli mod: yanlış yere atlanmaz, oynat/durdur ve sarma miktarı yine eşitlenir.
// Orijinal açıklama: Android uygulamasının JavaScript tarafının uçtan uca testi. Yerel (Kotlin) köprüyü
// taklit eder: arayüz sayfası + oynatıcı sayfası, aradaki mesajlar MainActivity'deki gibi
// (OrtakNative.toPlayer / OI.fromPlayer) taşınır.
//   node tests/e2e-app.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT, loadPlaywright, chromeOptions, testVideo, routeFakeDisney, startServer, startBroker, TEST_CODE, reporter, sleep } from './helpers.mjs';

const { chromium } = await loadPlaywright();
const VIDEO = testVideo(720);
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

const PORT = 8793;
const broker = await startBroker(18890, 18891);
const srv = await startServer(PORT, { ODA_KODU: TEST_CODE, ARACI: broker.ws });
await sleep(800);
const browser = await chromium.launch(chromeOptions({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] }));

const ALLOWED = new Set(['hello', 'engine', 'sync', 'tick', 'nav', 'buffer', 'countdown', 'react', 'invite', 'typing', 'drift', 'notice', 'zones']);
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
    if (process.env.DBG && /^(sync|tick)$/.test(o.t)) console.log('      [' + label + ' →]', raw);
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
  // ---- 1) Arayüzden saat okuma (birim test)
  {
    const p = await browser.newPage();
    await p.setContent('<html><body></body></html>');
    await p.addScriptTag({ content: ENGINE });
    const cases = await p.evaluate(() => {
      const R = [];
      const mk = (html) => {
        document.body.innerHTML = html;
        try {
          return OrtakIzleEngine.readUiClock(null);
        } catch (e) {
          return 'HATA ' + e.message;
        }
      };
      R.push(['saniyeli kaydırıcı', mk('<div role="slider" aria-valuemin="0" aria-valuemax="2700" aria-valuenow="1234"></div>'), [1234, 2700]]);
      R.push(['valuetext', mk('<div role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="45" aria-valuetext="20:34 / 45:00"></div>'), [1234, 2700]]);
      R.push(['yüzde + kalan süre (sağda)', mk('<div style="display:flex;width:800px"><div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80" style="width:600px;height:4px"></div><span style="width:100px">9:00</span></div>'), [2160, 2700]]);
      R.push(['yüzde + geçen/toplam', mk('<div><span>36:00</span><div role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80"></div><span>45:00</span></div>'), [2160, 2700]]);
      R.push(['gölge DOM içinde', (() => { document.body.innerHTML = '<x-player></x-player>'; const sh = document.querySelector('x-player').attachShadow({ mode: 'open' }); sh.innerHTML = '<div role="slider" aria-valuemin="0" aria-valuemax="3000" aria-valuenow="61"></div>'; return OrtakIzleEngine.readUiClock(null); })(), [61, 3000]]);
      R.push(['ses kaydırıcısı (0-1) karışmamalı', mk('<input type="range" min="0" max="1" step="0.1" value="0.5">'), null]);
      R.push(['hiçbir şey yok', mk('<div>merhaba</div>'), null]);
      return R;
    });
    for (const [name, got, want] of cases) {
      const ok = want === null ? got === null : got && Math.abs(got.now - want[0]) < 2 && Math.abs(got.max - want[1]) < 3;
      ok ? pass(`Saat okuma: ${name}`) : fail(`Saat okuma: ${name} → ${JSON.stringify(got)} (beklenen ${JSON.stringify(want)})`);
    }
    await p.close();
  }

  const A = await app('Berkay', 1280, 800);
  const B = await app('Kardeş', 400, 860);
  for (const X of [A, B]) {
    await X.ui.fill('#nameInput', X.label);
    await X.ui.click('#nameForm button');
    await X.ui.fill('#codeInput', 'k7m4qx');
    await X.ui.click('#codeForm button');
  }
  (await waitFor(async () => /2 kişi/.test(await A.ui.locator('#connText').innerText()), 15000)) ? pass('İkisi bağlandı') : fail('Bağlanamadılar');

  const ctA = () => A.player.evaluate(() => ({ paused: v.paused, vt: +v.currentTime.toFixed(2), ct: +(v.currentTime + 1000).toFixed(2) }));
  const ctB = () => B.player.evaluate(() => ({ paused: v.paused, vt: +v.currentTime.toFixed(2), ct: +(v.currentTime + 900).toFixed(2) }));

  // ---- 2) Çubuk okunabilir: A'nın video zamanı = dakika - 1000, B'ninki = dakika - 900
  await A.ui.locator('.pf[data-p="disney"]').click();
  await sleep(1200);
  await A.player.goto('https://www.disneyplus.com/play/loki?offset=1000');
  await B.ui.locator('.pf[data-p="disney"]').click();
  await sleep(1200);
  await B.player.goto('https://www.disneyplus.com/play/loki?offset=900');
  await A.player.waitForFunction(() => window.v && v.readyState >= 1);
  await B.player.waitForFunction(() => window.v && v.readyState >= 1);
  await sleep(2500);
  // Panelde gerçek dakika görünmeli (video zamanı değil)
  await A.player.evaluate(() => { window.tap && tap(); v.currentTime = 30; });
  await sleep(2500);
  const tcA = await A.ui.locator('#wTc').innerText().catch(() => '');
  /17:1/.test(tcA) ? pass(`Panelde gerçek dakika görünüyor: ${tcA.split('\n')[0]} (video zamanı 0:30 değil)`) : fail('Paneldeki dakika: ' + tcA);
  await A.player.evaluate(() => (window.tap && tap(), v.play()));
  const aligned = await waitFor(async () => {
    const a = await ctA(), b = await ctB();
    return !b.paused && Math.abs(a.ct - b.ct) < 1.5 ? [a, b] : null;
  }, 10000);
  aligned
    ? pass(`İki cihaz aynı dakikada: A ${aligned[0].ct}, B ${aligned[1].ct} (video zamanları ${aligned[0].vt} / ${aligned[1].vt})`)
    : fail('Aynı dakikaya gelmedi: ' + JSON.stringify([await ctA(), await ctB()]));
  if (process.env.DBG) { await B.player.evaluate(() => (window.__oiDebug = 1)); B.player.on('console', (m) => console.log('      Bkonsol', m.text())); }
  await B.player.evaluate(() => { window.tap && tap(); v.currentTime = 400; }); // B 1300. dakikaya sarar
  if (process.env.DBG) for (let i = 0; i < 6; i++) { await sleep(500); console.log('      B:', JSON.stringify(await B.player.evaluate(() => ({ t: v.currentTime, seeking: v.seeking, rs: v.readyState, paused: v.paused })))); }
  const seekOk = await waitFor(async () => {
    const a = await ctA();
    return Math.abs(a.ct - 1300) < 2 ? a : null;
  }, 8000);
  seekOk ? pass(`B 21:40'a sardı, A da 21:40'a geldi (A video zamanı ${seekOk.vt})`) : fail('Sarma dakikası tutmadı: ' + JSON.stringify(await ctA()));
  await B.player.evaluate(() => (window.tap && tap(), v.pause()));
  const pausedSame = await waitFor(async () => {
    const a = await ctA(), b = await ctB();
    return a.paused && Math.abs(a.ct - b.ct) < 0.5 ? [a, b] : null;
  }, 8000);
  pausedSame ? pass(`Durunca aynı karede: A ${pausedSame[0].ct}, B ${pausedSame[1].ct}`) : fail('Durma: ' + JSON.stringify([await ctA(), await ctB()]));

  const vt = (p) => p.evaluate(() => ({ paused: v.paused, t: +v.currentTime.toFixed(2) }));
  // ---- 3) Hiçbir şey okunamıyor (güvenli mod)
  await A.player.goto('https://www.disneyplus.com/play/loki?unreliable=1');
  await B.player.goto('https://www.disneyplus.com/play/loki?unreliable=1');
  await A.player.waitForFunction(() => window.v && v.readyState >= 1);
  await B.player.waitForFunction(() => window.v && v.readyState >= 1);
  await sleep(2500);
  // Hizalama: ikisi de durmuşken kendi videosunu aynı sahneye getiriyor (iç zamanlar farklı)
  await A.player.evaluate(() => (window.tap && tap(), v.pause()));
  await B.player.evaluate(() => (window.tap && tap(), v.pause()));
  await sleep(800);
  await A.player.evaluate(() => { window.tap && tap(); v.currentTime = 30; });
  await B.player.evaluate(() => { window.tap && tap(); v.currentTime = 80; });
  await sleep(2000);
  const sa = await vt(A.player), sb = await vt(B.player);
  Math.abs(sa.t - 30) < 1 && Math.abs(sb.t - 80) < 1 ? pass('Güvenli mod: durmuşken yapılan hizalama sarmaları karşıya taşmadı') : fail(`Hizalama karıştı: A ${sa.t} B ${sb.t}`);
  const tcU = await A.ui.locator('#wTc').innerText().catch(() => '');
  /–:––/.test(tcU) ? pass('Dakika okunamayınca panel yanlış dakika göstermiyor (–:––)') : fail('Panel: ' + tcU);
  await A.player.evaluate(() => (window.tap && tap(), v.play()));
  const both = await waitFor(async () => (!(await vt(B.player)).paused ? true : null), 8000);
  let b = await vt(B.player);
  both && b.t > 75 && b.t < 90 ? pass(`Güvenli mod: A oynattı, B kendi yerinden oynadı, yanlış yere atlamadı (B ${b.t})`) : fail('Güvenli mod oynat: ' + JSON.stringify(b));
  await sleep(1500);
  const before = await vt(B.player);
  await A.player.evaluate(() => { window.tap && tap(); v.currentTime = v.currentTime + 20; });
  await sleep(2500);
  b = await vt(B.player);
  const jump = b.t - before.t;
  jump > 19 && jump < 25 ? pass(`Güvenli mod: A 20 sn ileri sardı, B de ~20 sn ileri gitti (${jump.toFixed(1)} sn)`) : fail(`Güvenli mod sarma: B ${before.t} → ${b.t}`);
  await A.player.evaluate(() => (window.tap && tap(), v.pause()));
  const pz = await waitFor(async () => ((await vt(B.player)).paused ? true : null), 8000);
  pz ? pass('Güvenli mod: A durdurdu, B de durdu') : fail('Güvenli mod durdur');
  const drift = await waitFor(async () => {
    const x = await vt(B.player);
    return Math.abs(x.t - b.t) < 3 ? true : null;
  }, 4000);
  drift ? pass('Güvenli mod: düzenli bildirimler B\'yi yanlış yere sarmadı') : fail('Güvenli modda istenmeyen sarma');

  for (const X of [A, B]) for (const l of X.log) fail(`${X.label}: ${l}`);
} catch (e) {
  fail(e.stack);
} finally {
  srv.kill();
  await browser.close();
  await broker.close();
}
console.log(R.failed ? `BAŞARISIZ (${R.failed})` : 'İçerik saati testi geçti ✔');
process.exit(R.failed ? 1 : 0);
