// Android uygulamasının JavaScript tarafını tarayıcıda taklit eder: arayüz sayfası (web/index.html)
// + oynatıcı sayfası, aradaki köprü MainActivity'deki gibi (OrtakNative.* ↔ OI.*).
// Yerel (Kotlin) işlevlerin çağrıları `calls` listesine yazılır; testler oradan bakar.
import fs from 'fs';
import path from 'path';
import { ROOT, routeFakeDisney } from './helpers.mjs';

const ENGINE = fs.readFileSync(path.join(ROOT, 'web/engine.js'), 'utf8');
// MainActivity.bootstrapScript ile aynı yapıştırıcı (tepki/geri sayım Android katmanında: stage:false)
export const BOOT = `(function(){ if (window.top !== window) return;\n${ENGINE}\n})();
;(function () {
  if (window.top !== window || window.__ortakIzle) return;
  window.__ortakIzle = true;
  function post(m) { window.__toUi(JSON.stringify(m)); }
  function start() {
    var engine = OrtakIzleEngine.create({ post: post, displayFont: 'OI Display', stage: false });
    window.__ortakIzleRecv = function (m) { engine.receive(typeof m === 'string' ? JSON.parse(m) : m); };
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

// MainActivity.allowedFromPlayer ile aynı
export const ALLOWED = new Set(['hello', 'engine', 'sync', 'tick', 'nav', 'buffer', 'countdown', 'react', 'invite', 'typing', 'drift', 'notice']);
const NATIVE = ['openPlayer', 'closePlayer', 'toPlayer', 'setPanel', 'setFloatSize', 'setDesktopMode', 'keepScreenOn', 'share', 'startDiscovery', 'stopDiscovery', 'stopHost', 'overlay', 'confirm', 'playerBack', 'checkUpdate', 'installUpdate'];

export async function makeApp(browser, { label, port, brokerWs, video, w = 1280, h = 800, debug = false }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await routeFakeDisney(ctx, video);
  const ui = await ctx.newPage();
  const player = await ctx.newPage();
  const log = [];
  const calls = []; // [işlev, argüman] (overlay/confirm için argüman JSON çözülmüş)
  ui.on('pageerror', (e) => log.push('UI hata: ' + e.message));
  player.on('pageerror', (e) => log.push('Oynatıcı hata: ' + e.message));
  await player.addInitScript(BOOT);
  await player.exposeFunction('__toUi', async (raw) => {
    const o = JSON.parse(raw);
    if (debug && !['engine', 'drift'].includes(o.t)) console.log('      ', label, '→', raw.slice(0, 160));
    if (!ALLOWED.has(o.t)) return;
    await ui.evaluate((m) => window.OI && OI.fromPlayer(m), o).catch(() => {});
  });
  const app = { ctx, ui, player, log, calls, label, layout: 'full' };
  const closed = async () => {
    await player.goto('about:blank');
    await ui.evaluate(() => {
      OI.setLayout({ mode: 'full' });
      OI.onPlayerClosed();
    });
  };
  await ui.exposeFunction('__native', async (fn, args) => {
    const arg = args[0];
    calls.push([fn, (fn === 'overlay' || fn === 'confirm') && typeof arg === 'string' ? JSON.parse(arg) : arg]);
    if (fn === 'openPlayer') {
      await player.goto(arg);
      await ui.evaluate((m) => OI.setLayout({ mode: m }), app.layout === 'full' ? 'side' : app.layout);
    } else if (fn === 'toPlayer') {
      await player.evaluate((j) => window.__ortakIzleRecv && __ortakIzleRecv(j), arg).catch(() => {});
    } else if (fn === 'closePlayer') {
      await player.goto('about:blank');
      await ui.evaluate(() => OI.setLayout({ mode: 'full' }));
    } else if (fn === 'playerBack') {
      // Testte oynatıcı geçmişi yok: ana ekrana dönülür
      await closed();
    } else if (fn === 'setPanel') {
      app.layout = arg === 'open' ? 'side' : 'float';
      await ui.evaluate((m) => OI.setLayout({ mode: m }), app.layout);
    }
  });
  if (brokerWs) await ui.addInitScript((url) => (window.__ortakIzleBrokers = [url]), brokerWs);
  await ui.addInitScript((fns) => {
    window.OrtakNative = {
      getInfo: () => JSON.stringify({ hosting: false, port: -1, addresses: [] }),
      startHost: () => JSON.stringify({ ok: false, error: 'test' }),
      appVersion: () => JSON.stringify({ name: 'test', code: 1 }),
    };
    for (const f of fns) window.OrtakNative[f] = (...a) => { window.__native(f, a); return ''; };
  }, NATIVE);
  await ui.goto(`http://127.0.0.1:${port}/index.html`);
  // Yerel katmana gönderilenler
  app.overlays = (type) => calls.filter(([f, a]) => f === 'overlay' && (!type || a.type === type)).map(([, a]) => a);
  app.called = (fn) => calls.filter(([f]) => f === fn).map(([, a]) => a);
  return app;
}

export async function waitFor(fn, ms = 10000, every = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}
