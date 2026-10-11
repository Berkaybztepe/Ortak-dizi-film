// Gerçek Android (emülatör/cihaz) testi: test sürümünü kurar, uygulamanın içindeki WebView ekranlarına
// hata ayıklama protokolüyle bağlanır; oda açma, oda koduyla katılma, sohbet, oynat/durdur/sar,
// geri sayım, tepki, tam ekran ve dikey ekranı dener.
// Gerekenler: çalışan emülatör (adb devices), node tests/broker.mjs 18870 18871, sahte video sitesi (10.0.2.2:8900),
// ./gradlew :app:assembleDebug.  Çalıştır: node tests/e2e-android.mjs
// Emülatörde gerçek uygulama testi (Android WebView + Kotlin oda sunucusu + oda kodu)
import { execSync } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require(new URL('../web/room-client.js', import.meta.url).pathname);
const R = globalThis.OrtakIzleRoom;


// --- sade CDP istemcisi (eski WebView'lar Playwright'ın tarayıcı bağlantısını desteklemiyor)
async function listPages() {
  const r = await fetch('http://127.0.0.1:9333/json/list');
  return r.json();
}
class Page {
  constructor(info) {
    this.info = info;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
  }
  url() { return this.info.url; }
  async open() {
    this.ws = new WebSocket(this.info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    };
    this.ws.onclose = () => {
      this.closed = true;
      for (const [, res] of this.pending) res({ result: { exceptionDetails: { exception: { description: 'bağlantı kapandı' } } } });
      this.pending.clear();
    };
    await this.send('Runtime.enable');
    return this;
  }
  send(method, params = {}) {
    if (this.closed) return Promise.resolve({ result: { exceptionDetails: { exception: { description: 'bağlantı kapandı' } } } });
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  async evaluate(fn, arg) {
    const expr = `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`;
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval hatası');
    return r.result?.result?.value;
  }
  text(sel) { return this.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel); }
  visible(sel) { return this.evaluate((s) => { const e = document.querySelector(s); return !!(e && e.getClientRects().length && !e.closest('[hidden]')); }, sel); }
  fill(sel, v) { return this.evaluate(([s, v]) => { const e = document.querySelector(s); e.focus(); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, v]); }
  click(sel) { return this.evaluate((s) => document.querySelector(s).click(), sel); }
  submit(sel) { return this.evaluate((s) => { const f = document.querySelector(s).closest('form'); f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { cancelable: true })); }, sel); }
}
async function findPage(pred) {
  const list = await listPages();
  const p = list.find((x) => x.type === 'page' && pred(x.url));
  return p ? new Page(p).open() : null;
}

const ADB = (process.env.ANDROID_HOME || '/root/android-sdk') + '/platform-tools/adb';
const adb = (c) => execSync(`${ADB} ${c}`, { encoding: 'utf8', timeout: 600000 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT = (n) => execSync(`${ADB} exec-out screencap -p > ${process.env.SHOTS_DIR || '/tmp'}/emu-${n}.png`);
let failed = 0;
const pass = (m) => console.log('  ✔', m);
const fail = (m) => (console.log('  ✘', m), failed++);
const step = (m) => console.log('•', m);

async function waitFor(fn, ms = 60000, every = 1000) {
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

step('APK kuruluyor');
if (!process.env.SKIP_INSTALL) console.log(adb(`install -r -g ${new URL('../android/app/build/outputs/apk/debug/app-debug.apk', import.meta.url).pathname}`));
adb('shell pm clear com.ortakizle.app');
adb('shell am start -W -n com.ortakizle.app/.MainActivity --es araci_tcp tcp://10.0.2.2:18870 --es araci_ws ws://10.0.2.2:18871/mqtt');

step('WebView hata ayıklama soketi aranıyor');
const sock = await waitFor(() => {
  const s = adb('shell cat /proc/net/unix').split('\n').map((l) => l.trim().split(/\s+/).pop()).find((x) => /webview_devtools_remote/.test(x || ''));
  return s ? s.replace(/^@/, '') : null;
}, 300000, 3000);
if (!sock) {
  console.log('Soket bulunamadı');
  process.exit(1);
}
try { adb('forward --remove tcp:9333'); } catch {}
adb(`forward tcp:9333 localabstract:${sock}`);
const ui = await waitFor(() => findPage((u) => u.includes('appassets')), 240000, 2000);
if (!ui) {
  console.log('Arayüz sayfası yok:', (await listPages()).map((p) => p.url));
  process.exit(1);
}
const errors = [];
pass('Arayüz yüklendi: ' + ui.url());
await waitFor(() => ui.visible('#nameInput'), 240000);
await sleep(1500);
SHOT('1-karsilama');

step('İsim ve odayı açma');
await ui.fill('#nameInput', 'Berkay');
await ui.submit('#nameInput');
await waitFor(() => ui.visible('#hostBtn'), 120000);
SHOT('2-baglan');
await ui.click('#hostBtn');
const code = await waitFor(async () => {
  const t = await ui.text('#tkAddrs');
  const m = t.match(/[A-Z0-9]{3}-[A-Z0-9]{3}/);
  return m && m[0];
}, 120000);
code ? pass('Oda açıldı, kod: ' + code) : fail('Oda kodu görünmedi');
const online = await waitFor(async () => /ULAŞILABİLİR|ulaşılabilir/.test(await ui.text('#tkServer')), 240000, 2000);
online ? pass('Kotlin sunucusu aracıya bağlandı ("internetten ulaşılabilir")') : fail('Aracıya bağlanamadı: ' + (await ui.text('#tkServer')));
await sleep(1000);
SHOT('3-oda');

step('Uzaktaki kardeş oda koduyla katılıyor');
const events = [];
const kardes = new R.RoomClient({ kind: 'app', onEvent: (m) => events.push(m) });
kardes.connect({ code, name: 'Kardeş', room: 'salon', password: '', brokers: ['ws://127.0.0.1:18871/mqtt'] });
const joined = await waitFor(() => kardes.state === 'bağlı' && kardes.members.length === 2, 60000, 500);
joined ? pass('Kardeş bağlandı, odada 2 kişi') : fail('Kardeş bağlanamadı: ' + kardes.state + ' ' + kardes.error);
const seen = await waitFor(async () => /2 kişi/.test(await ui.text('#connText')), 90000);
seen ? pass('Tablet ekranında "2 kişi" görünüyor') : fail('Tablet kardeşi görmedi');

step('Sohbet');
kardes.send({ t: 'chat', text: 'Selam abi, hazırım 🍿' });
const gotMsg = await waitFor(async () => /hazırım/.test(await ui.text('body')), 90000);
gotMsg ? pass('Kardeşin mesajı tablette göründü') : fail('Mesaj gelmedi');
await ui.fill('#chatInput', 'Geliyorum, bölümü açıyorum');
await ui.submit('#chatInput');
const back = await waitFor(() => events.some((m) => m.t === 'chat' && /bölümü açıyorum/.test(m.text)), 90000, 500);
back ? pass('Tabletin mesajı kardeşe ulaştı') : fail('Mesaj kardeşe gitmedi');
SHOT('4-sohbet');

step('Bölüm açılıyor (sahte dizi sitesi)');
await ui.fill('#customUrl', 'http://10.0.2.2:8900/play/loki');
await ui.submit('#customUrl');
const player = await waitFor(() => findPage((u) => u.includes('10.0.2.2:8900')), 240000, 2000);
player ? pass('Oynatıcı açıldı') : fail('Oynatıcı açılmadı: ' + (await listPages()).map((p) => p.url));
const hasVideo = await waitFor(() => player.evaluate(() => window.v && v.readyState >= 1), 240000);
hasVideo ? pass('Video yüklendi') : fail('Video yüklenmedi');
const engineOk = await waitFor(() => player.evaluate(() => typeof window.__ortakIzleRecv === 'function'), 120000);
engineOk ? pass('Senkron motoru oynatıcı sayfasına yerleşti') : fail('Motor yok');
const nav = await waitFor(() => events.find((m) => m.t === 'nav' && m.member && /loki/.test(m.member.url || '') && m.watching), 90000, 500);
nav ? pass(`Kardeşe "Berkay açtı: ${nav.member.title}" bildirimi gitti`) : fail('nav gitmedi');
await sleep(3000);
SHOT('5-izleme-yan-panel');

step('Kardeş oynatıyor → tablette de oynamalı');
kardes.send({ t: 'nav', url: 'http://10.0.2.2:8900/play/loki', title: 'Loki', platform: '10.0.2.2', watching: true });
await sleep(1000);
kardes.send({ t: 'sync', action: 'seek', time: 60, paused: true });
await sleep(1500);
kardes.send({ t: 'sync', action: 'play', time: 60 });
const playing = await waitFor(() => player.evaluate(() => !v.paused && v.currentTime > 59), 90000, 500);
const st1 = await player.evaluate(() => ({ paused: v.paused, t: v.currentTime }));
playing ? pass(`Tablette oynuyor (konum ${st1.t.toFixed(1)} sn)`) : fail('Oynamadı: ' + JSON.stringify(st1));

step('Kardeş durduruyor → tablet aynı karede durmalı');
await sleep(2000);
const t2 = kardes.expectedTime();
kardes.send({ t: 'sync', action: 'pause', time: t2 });
const paused = await waitFor(() => player.evaluate(() => v.paused), 60000, 300);
const st2 = await player.evaluate(() => ({ paused: v.paused, t: v.currentTime }));
paused && Math.abs(st2.t - t2) < 0.5 ? pass(`Durdu: tablet ${st2.t.toFixed(2)} / kardeş ${t2.toFixed(2)}`) : fail('Durma: ' + JSON.stringify(st2) + ' beklenen ' + t2);

step('Tablette sarma → kardeşe gitmeli');
await player.evaluate(() => { v.currentTime = 300; });
const seek = await waitFor(() => events.find((m) => m.t === 'sync' && Math.abs(m.time - 300) < 1), 90000, 500);
seek ? pass('Tabletteki sarma kardeşe ulaştı (5:00)') : fail('Sarma ulaşmadı');

step('Tablette oynat → kardeşe gitmeli');
await player.evaluate(() => v.play());
const play2 = await waitFor(() => events.find((m) => m.t === 'sync' && m.paused === false), 90000, 500);
play2 ? pass('Tabletteki oynat kardeşe ulaştı') : fail('Oynat ulaşmadı');
const tick = await waitFor(() => events.find((m) => m.t === 'tick'), 90000, 500);
tick ? pass('Tablet oynarken konumunu düzenli bildiriyor (kayma düzeltmesi)') : fail('tick yok');

step('Tepki ve geri sayım');
kardes.send({ t: 'react', emoji: '🔥' });
const rx = await waitFor(() => player.evaluate(() => document.querySelector('[data-ortak-izle="stage"]').shadowRoot.querySelectorAll('.r').length), 40000, 300);
rx ? pass('Tepki videonun üstünde uçtu') : fail('Tepki görünmedi');
await ui.click('#tCount');
const cd = await waitFor(() => events.find((m) => m.t === 'countdown'), 60000, 300);
cd ? pass('3-2-1 geri sayımı kardeşe gitti') : fail('Geri sayım gitmedi');
await sleep(1200);
SHOT('6-geri-sayim');
await sleep(4000);
const afterCd = await player.evaluate(() => ({ paused: v.paused, t: v.currentTime }));
!afterCd.paused ? pass(`Geri sayım bitince oynamaya başladı (${afterCd.t.toFixed(1)} sn)`) : fail('Geri sayım sonrası oynamadı');

step('Paneli gizle (tam ekran + yüzen düğme)');
await ui.click('#collapseBtn');
await sleep(2500);
SHOT('7-tam-ekran');
const floatShown = await ui.visible('#vFloat');
floatShown ? pass('Tam ekran: yüzen sohbet düğmesi görünüyor') : fail('Yüzen düğme yok');
kardes.send({ t: 'chat', text: 'Bu sahne efsane' });
await sleep(2500);
SHOT('8-tam-ekran-mesaj');
await ui.click('#fOpen');
await sleep(2000);

step('Dikey ekran');
adb('shell settings put system accelerometer_rotation 0');
adb('shell settings put system user_rotation 1');
await sleep(6000);
SHOT('9-dikey');
adb('shell settings put system user_rotation 0');
await sleep(4000);

step('Ana ekrana dönüş ve geri tuşu');
await ui.click('#homeBtn');
await sleep(2500);
(await ui.visible('#vLobby')) ? pass('Ana ekrana dönüldü') : fail('Ana ekrana dönülmedi');
SHOT('10-ana-ekran');

const crash = adb('logcat -d -b crash');
crash.includes('com.ortakizle') ? fail('Çökme kaydı var:\n' + crash.slice(0, 2000)) : pass('Çökme kaydı yok');
for (const e of [...errors, ...ui.errors.map((x) => 'UI: ' + x), ...(player ? player.errors.map((x) => 'Oynatıcı: ' + x) : [])]) fail(e);
kardes.disconnect();

console.log(failed ? `BAŞARISIZ (${failed})` : 'Emülatör testi geçti ✔');
process.exit(failed ? 1 : 0);
