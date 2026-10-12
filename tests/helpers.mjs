// Uçtan uca testler için ortak yardımcılar: Playwright yükleme, deneme videosu,
// sahte Disney+ sayfası ve test sunucusu.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadPlaywright() {
  for (const spec of ['playwright', process.env.PLAYWRIGHT_MODULE].filter(Boolean)) {
    try {
      return await import(spec);
    } catch {}
  }
  for (const p of ['/opt/node-tools/node_modules/playwright/index.mjs']) {
    if (fs.existsSync(p)) return import(p);
  }
  throw new Error('Playwright bulunamadı: npm install (kök klasörde) çalıştırın.');
}

export function chromeOptions(extra = {}) {
  const exe = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
  return { ...(exe ? { executablePath: exe } : {}), ...extra };
}

// Deneme videosu (ffmpeg ile bir kez üretilir). Varsayılan 2 dk; uzun: 12 dk
export function testVideo(seconds = 120) {
  const file = path.join(os.tmpdir(), `ortak-izle-test-${seconds}.webm`);
  if (!fs.existsSync(file)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
      '-t', String(seconds), '-c:v', 'libvpx', '-b:v', seconds > 200 ? '60k' : '150k', '-g', '20', file]);
  }
  return fs.readFileSync(file);
}

// Disney+ benzeri sayfa: video gölge DOM'un içinde
export const fakePage = (title) => `<!doctype html><html><head><title>Watch ${title} | Disney+</title></head><body style="margin:0;background:#000">
<disney-web-player id="p"></disney-web-player>
<script>
const sr = document.getElementById('p').attachShadow({mode:'open'});
sr.innerHTML = '<video id="v" src="https://www.disneyplus.com/media/v.webm" muted style="width:100vw;height:100vh"></video>';
window.v = sr.getElementById('v');
// Testte "kullanıcı dokundu" (ör. oynatıcının düğmesine basıldı) taklidi
window.tap = () => dispatchEvent(new PointerEvent('pointerdown'));
// Ağ takılması taklidi: video bir süre yavaş oynar (geride kalır), olay üretmeden
window.stall = (ms, rate = 0.25) => {
  v.playbackRate = rate;
  setTimeout(() => (v.playbackRate = 1), ms);
};
// Zor koşul testi: window.__resist > 0 iken oynatıcı, dışarıdan yapılan durdur/oynat'ı bir kez geri alır
// (bazı platform oynatıcılarının kendi durumunu dayatması gibi)
window.__resist = 0;
// Disney+ benzeri zaman çizelgesi (adres parametreleri):
//   ?offset=N    : video zamanı içerik dakikası değil; gerçek dakika = video zamanı + N, yalnızca
//                  oynatıcının ilerleme çubuğunda (role=slider, aria-valuenow) yazar
//   ?unreliable=1: video süresi sonsuz görünür ve çubuk yok (gerçek dakika hiç okunamaz)
const q = new URLSearchParams(location.search);
// ?autoplay=1: site sayfa açılınca videoyu kendiliğinden oynatır (kullanıcı dokunmadan)
// ?controls=1: Disney+ gibi kendi düğmeleri (gizli dururlar, dokununca görünürler): sol üstte geri +
// başlık, altta çubuk, sağ altta ayar ve tam ekran
if (q.has('controls')) {
  const c = document.createElement('div');
  c.id = 'ctl';
  c.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0';
  c.innerHTML = '<button aria-label="Geri" style="position:absolute;left:3%;top:5%;width:48px;height:48px"></button>' +
    '<h2 style="position:absolute;left:calc(3% + 60px);top:5%;margin:0;color:#fff;font:700 22px sans-serif">The Talkers</h2>' +
    '<div role="slider" aria-valuenow="0" style="position:absolute;left:3%;right:3%;bottom:22%;height:6px;background:#888"></div>' +
    '<button aria-label="Ayarlar" style="position:absolute;right:12%;bottom:6%;width:44px;height:44px"></button>' +
    '<button aria-label="Tam ekran" style="position:absolute;right:3%;bottom:6%;width:44px;height:44px"></button>' +
    '<button aria-label="Oynat" style="position:absolute;left:calc(50% - 30px);bottom:5%;width:60px;height:60px"></button>';
  sr.appendChild(c);
}
// ?freezeseek=1: Disney+'ın telefondaki hatası gibi: video konumu dışarıdan değiştirilince oynatıcı
// donar (zaman ilerlemez). Kendi ±10 tuşu kullanılınca düzelir.
let keySeek = (fn) => fn();
if (q.has('freezeseek')) {
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  let frozenAt = null;
  let viaKey = false;
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get() { return frozenAt !== null ? frozenAt : desc.get.call(v); },
    set(t) { desc.set.call(v, t); frozenAt = viaKey ? null : t; },
  });
  keySeek = (fn) => { frozenAt = null; viaKey = true; try { fn(); } finally { viaKey = false; } };
  window.__frozen = () => frozenAt !== null;
}
// Disney+ gibi: sol/sağ ok tuşu 10 sn geri/ileri sarar (yalnızca gerçek tuş basışı)
addEventListener('keydown', (e) => {
  if (!e.isTrusted) return;
  if (e.key === 'ArrowLeft') keySeek(() => (v.currentTime = Math.max(0, v.currentTime - 10)));
  if (e.key === 'ArrowRight') keySeek(() => (v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10)));
});
if (q.has('autoplay')) v.addEventListener('loadeddata', () => v.play().catch(() => {}), { once: true });
if (q.has('offset') || q.has('unreliable')) {
  Object.defineProperty(v, 'duration', { get: () => Infinity });
}
if (q.has('offset')) {
  const off = +q.get('offset');
  const bar = document.createElement('div');
  bar.setAttribute('role', 'slider');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '2700');
  bar.style.cssText = 'position:fixed;left:5%;right:5%;bottom:20px;height:6px;background:#888';
  sr.appendChild(bar);
  // Gerçek oynatıcılar gibi çubuk sık güncellenir (değer saniyeye yuvarlanır)
  setInterval(() => {
    const n = String(Math.floor(v.currentTime + off));
    if (bar.getAttribute('aria-valuenow') !== n) bar.setAttribute('aria-valuenow', n);
  }, 100);
}
for (const ev of ['pause', 'play']) v.addEventListener(ev, () => {
  if (window.__resist > 0) {
    window.__resist--;
    setTimeout(() => (ev === 'pause' ? v.play() : v.pause()), 250);
  }
});
</script></body></html>`;

export async function routeFakeDisney(ctx, video) {
  await ctx.route('https://www.disneyplus.com/**', (route) => {
    const u = route.request().url();
    if (u.endsWith('.webm')) {
      const range = route.request().headers()['range'];
      if (range) {
        const [s, e] = range.replace('bytes=', '').split('-');
        const start = +s;
        const end = e ? +e : video.length - 1;
        return route.fulfill({ status: 206, headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${video.length}` }, body: video.subarray(start, end + 1) });
      }
      return route.fulfill({ status: 200, headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes' }, body: video });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: fakePage(/loki/.test(u) ? 'Loki' : 'Ana sayfa') });
  });
}

export async function startServer(port, extraEnv = {}) {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: String(port), ODA_SIFRE: '', ...extraEnv } });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Sunucu açılmadı')), 5000);
    srv.stdout.on('data', (d) => /çalışıyor/.test(String(d)) && (clearTimeout(t), resolve()));
  });
  return srv;
}

export function reporter() {
  let failed = 0;
  return {
    pass: (m) => console.log('  ✔', m),
    fail: (m) => {
      console.error('  ✘', m);
      failed++;
    },
    get failed() {
      return failed;
    },
  };
}

export { startBroker } from './broker.mjs';
export const TEST_CODE = 'K7M4QX';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
