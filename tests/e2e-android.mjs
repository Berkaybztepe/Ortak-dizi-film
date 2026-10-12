// Gerçek Android (emülatör/cihaz) testi: test sürümünü kurar, uygulamanın içindeki WebView ekranlarına
// hata ayıklama protokolüyle bağlanır; oda açma, oda koduyla katılma, sohbet, oynat/durdur/sar,
// geri sayım, tepki, tam ekran ve dikey ekranı dener.
// Gerekenler: çalışan emülatör (adb devices), node tests/broker.mjs 18870 18871, node tests/fake-site.mjs,
// ./gradlew :app:assembleDebug.  Çalıştır: node tests/e2e-android.mjs
// Güncelleme adımı için: ./gradlew :app:assembleRelease -PsurumKodu=<şimdiki+1> ile çıkan APK'yı
// <klasör>/dist/OrtakIzle.apk olarak koy, yanına version.json (bkz. tools/make-version.mjs) yaz,
// sahte siteyi UPDATE_DIR=<klasör> ile başlat ve testi de UPDATE_DIR=<klasör> ile çalıştır.
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
adb('logcat -c');
// Güncelleme izni şimdiden (sonradan değişirse Android uygulamayı kapatır)
if (process.env.UPDATE_DIR) adb('shell appops set com.ortakizle.app REQUEST_INSTALL_PACKAGES allow');
// Yavaş emülatörde sistem arayüzü "yanıt vermiyor" penceresi açabiliyor: tuş/dokunuştan önce kapat
const focus = () => {
  try {
    return adb('shell dumpsys window | grep mCurrentFocus');
  } catch {
    return '';
  }
};
const clearDialogs = async () => {
  for (let i = 0; i < 4 && /Not Responding/.test(focus()); i++) {
    adb('shell input keyevent 4'); // "yanıt vermiyor" penceresinde geri = bekle
    await sleep(1500);
  }
};
// UPDATE_DIR verildiyse uygulama güncellemeyi GitHub yerine sahte siteden (fake-site.mjs) arar
adb(`shell am start -W -n com.ortakizle.app/.MainActivity --es araci_tcp tcp://10.0.2.2:18870 --es araci_ws ws://10.0.2.2:18871/mqtt${process.env.UPDATE_DIR ? ' --es guncelleme_url http://10.0.2.2:8900/guncelleme' : ''}`);

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
let kardesState = '';
const kardes = new R.RoomClient({
  kind: 'app',
  onEvent: (m) => {
    events.push({ ...m, _rx: Date.now() });
    if (m.t === 'status' && m.wsState !== kardesState) {
      kardesState = m.wsState;
      console.log(`    [kardeş ${new Date().toTimeString().slice(0, 8)}] ${m.wsState}${m.lastError ? ' · ' + m.lastError : ''}`);
    }
  },
});
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
await player.evaluate(() => { window.tap && tap(); v.currentTime = 300; });
// (yavaş emülatörde ağ takılıp kardeş yeniden bağlanırsa sarmayı odanın güncel durumundan öğrenir)
const seek = await waitFor(() => events.find((m) => m.t === 'sync' && Math.abs(m.time - 300) < 1) || (kardes.state === 'bağlı' && kardes.roomState && Math.abs(kardes.roomState.time - 300) < 5), 90000, 500);
seek ? pass('Tabletteki sarma kardeşe ulaştı (5:00)') : fail('Sarma ulaşmadı');

step('Tablette oynat → kardeşe gitmeli');
await player.evaluate(() => (window.tap && tap(), v.play()));
const play2 = await waitFor(() => events.find((m) => m.t === 'sync' && m.paused === false) || (kardes.state === 'bağlı' && kardes.roomState && kardes.roomState.paused === false && kardes.roomState.time >= 299), 90000, 500);
play2 ? pass('Tabletteki oynat kardeşe ulaştı') : fail('Oynat ulaşmadı');
const tick = await waitFor(() => events.find((m) => m.t === 'tick'), 90000, 500);
tick ? pass('Tablet oynarken konumunu düzenli bildiriyor (kayma düzeltmesi)') : fail('tick yok');

step('Masaüstü kimliği');
const ua = await player.evaluate(() => ({ ua: navigator.userAgent, platform: navigator.platform, mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null }));
/Windows NT/.test(ua.ua) && ua.platform === 'Win32' && ua.mobile !== true ? pass('Oynatıcı masaüstü Chrome gibi görünüyor (Windows, Win32, mobil değil)') : fail('Masaüstü kimliği: ' + JSON.stringify(ua));

step('Tepki, akan mesaj ve uyarılar (Android katmanı)');
// Ekrandaki gerçek Android görünümleri (uiautomator) içinde yazı ara
// Ekrandaki Android görünümleri yerine (video oynarken uiautomator ekranı okuyamıyor ve yavaş
// emülatörü kilitliyor) test sürümünün günlüğüne bakılır: katmana gelen her şey "Katman: {...}",
// onay pencereleri "Onay: ...", geri düğmesinin yeri "Geri düğmesi: x y" olarak yazılır.
const logLines = () => adb('logcat -d -s OrtakIzle').split('\n');
const katman = (re) => logLines().some((l) => /Katman:/.test(l) && re.test(l));
async function seeOverlay(logRe, ms = 20000) {
  return waitFor(() => katman(logRe), ms, 700);
}
function backButtonAt() {
  const l = logLines().filter((x) => /Geri düğmesi: \d+ \d+/.test(x)).pop();
  const m = l && l.match(/Geri düğmesi: (\d+) (\d+)/);
  return m ? { x: +m[1], y: +m[2] } : null;
}
kardes.send({ t: 'react', emoji: '🔥' });
const rx = await seeOverlay(/"type":"react".*🔥|🔥.*"type":"react"/, 15000);
rx ? pass('Tepki Android katmanına ulaştı (videonun üstünde uçar)') : fail('Tepki katmana gelmedi');
await ui.click('#collapseBtn');
await sleep(2500);
SHOT('7-tam-ekran');
const floatShown = await ui.visible('#vFloat');
floatShown ? pass('Sadece video: yüzen sohbet düğmesi görünüyor') : fail('Yüzen düğme yok');
kardes.send({ t: 'chat', text: 'Bu sahne efsane' });
const ticker = await seeOverlay(/"type":"msg".*Bu sahne efsane|Bu sahne efsane.*"type":"msg"/, 20000);
ticker ? pass('Sohbet kapalıyken mesaj katmana gitti (videonun altından akar)') : fail('Akan mesaj katmana gelmedi');
SHOT('8-akan-mesaj');
const backBtn = await waitFor(() => backButtonAt(), 10000, 700);
backBtn && backBtn.x < 400 && backBtn.y < 400 ? pass(`Sol üstte ayrı geri düğmesi var (${backBtn.x},${backBtn.y})`) : fail('Geri düğmesi bulunamadı: ' + JSON.stringify(backBtn));

step('Geri sayım (aynı kareden, aynı anda)');
await ui.click('#fOpen');
await sleep(2000);
await ui.click('#tCount');
const cd = await waitFor(() => events.find((m) => m.t === 'countdown'), 60000, 300);
cd ? pass('3-2-1 geri sayımı kardeşe gitti') : fail('Geri sayım gitmedi');
await sleep(800);
SHOT('6-geri-sayim');
await sleep(4500);
const afterCd = await player.evaluate(() => ({ paused: v.paused, t: v.currentTime }));
!afterCd.paused ? pass(`Geri sayım bitince oynamaya başladı (${afterCd.t.toFixed(1)} sn)`) : fail('Geri sayım sonrası oynamadı');

step('Kardeş bölümden çıkınca tablette video durur ve uyarı çıkar');
kardes.send({ t: 'nav', url: 'http://10.0.2.2:8900/play/loki', title: 'Loki', platform: '10.0.2.2', watching: true });
await sleep(1500);
kardes.send({ t: 'nav', url: 'http://10.0.2.2:8900/', title: '', platform: '10.0.2.2', watching: false });
const stopped = await waitFor(() => player.evaluate(() => v.paused), 30000, 300);
stopped ? pass('Kardeş çıkınca tablette video durdu') : fail('Video durmadı');
const warn = await seeOverlay(/"type":"notice".*bölümden çıktı|bölümden çıktı.*"type":"notice"/, 15000);
warn ? pass('Ekrana "Kardeş bölümden çıktı · video durduruldu" uyarısı gitti') : fail('Uyarı katmana gelmedi');
SHOT('9-cikti-uyarisi');

step('Dikey ekran');
adb('shell settings put system accelerometer_rotation 0');
adb('shell settings put system user_rotation 1');
await sleep(6000);
SHOT('10-yatay');
adb('shell settings put system user_rotation 0');
await sleep(4000);

step('Geri tuşu kazara çıkarmaz, onay sorar');
await player.evaluate(() => (window.tap && tap(), v.play()));
await sleep(2000);
const onaylar = () => adb('logcat -d -s OrtakIzle').split('\n').filter((l) => /Onay: Bölümden çıkılsın mı/.test(l)).length;
const o0 = onaylar();
await clearDialogs();
await sleep(500);
adb('shell input keyevent 4');
const dlg = await waitFor(() => onaylar() > o0, 20000, 700);
dlg ? pass('Geri tuşunda "Bölümden çıkılsın mı?" onayı açıldı') : fail('Onay penceresi açılmadı');
await sleep(1500);
SHOT('11-onay');
adb('shell input keyevent 4'); // pencereyi kapat = vazgeç
await sleep(2500);
(await ui.visible('#vWatch')) && !(await player.evaluate(() => v.paused)) ? pass('Vazgeçince bölümde kalındı, video sürüyor') : fail('Bölümden çıkıldı ya da video durdu');
const exitAt = Date.now();
// Sol üstteki geri düğmesine dokun
const btn = backButtonAt() || { x: 70, y: 116 };
const o1 = onaylar();
await clearDialogs();
await sleep(500);
adb(`shell input tap ${btn.x} ${btn.y}`);
const dlg2 = await waitFor(() => onaylar() > o1, 20000, 700);
dlg2 ? pass('Sol üstteki geri düğmesi de onay soruyor') : fail('Geri düğmesi onay sormadı');
await sleep(1500);
SHOT('11b-onay-dugme');
// "Çık"a dokunmak yerine pencereyi kapatıp onayı arayüze doğrudan veriyoruz (düğmenin yeri dile göre değişir)
adb('shell input keyevent 4');
await sleep(800);
await ui.evaluate(() => OI.onConfirm('exit', true));
// Kardeşin bağlantısı yavaş emülatörde arada yenilenebiliyor: duraklatma mesajı ya da odanın
// güncel durumu (yeniden bağlanınca gelir) "durdu" olmalı
const pausedMsg = await waitFor(
  () => events.find((m) => m.t === 'sync' && m.action === 'pause' && m._rx > exitAt) || (kardes.state === 'bağlı' && kardes.roomState && kardes.roomState.paused),
  30000,
  300
);
pausedMsg ? pass('Çıkarken önce herkeste durduruldu') : fail('Çıkarken durdurma gitmedi');
const home = await waitFor(() => ui.visible('#vLobby'), 20000);
home ? pass('Onaylayınca ana ekrana dönüldü') : fail('Ana ekrana dönülmedi');
SHOT('12-ana-ekran');

if (process.env.UPDATE_DIR) {
  step('Uygulama içi güncelleme (eskisini silmeden)');
  const startCode = +(adb('shell dumpsys package com.ortakizle.app').match(/versionCode=(\d+)/) || [0, 0])[1];
  const card = await waitFor(() => ui.visible('#updateCard'), 60000, 1000);
  card ? pass('Ana ekranda güncelleme kartı çıktı: ' + (await ui.text('#updTitle'))) : fail('Güncelleme kartı çıkmadı');
  SHOT('13-guncelleme-karti');
  await clearDialogs();
  adb('shell am start -n com.ortakizle.app/.MainActivity'); // uygulama önde olsun (kurulum ekranı ancak öndeyken açılır)
  await sleep(2000);
  await ui.click('#updGo');
  let tries = 0;
  const inst = await waitFor(async () => {
    await clearDialogs();
    if (/packageinstaller/i.test(focus())) return true;
    // İndirme bitti ama kurulum ekranı açılmadıysa (uygulama arkadaydı) "Kur"a yeniden bas
    if (++tries % 10 === 0 && /Kur/.test(await ui.text('#updGo').catch(() => ''))) {
      adb('shell am start -n com.ortakizle.app/.MainActivity');
      await sleep(1500);
      await ui.click('#updGo').catch(() => {});
    }
    return false;
  }, 180000, 3000);
  inst ? pass('İndirildi, imza doğrulandı, Android kurulum ekranı açıldı') : fail('Kurulum ekranı açılmadı: ' + (await ui.text('#updText').catch(() => '?')));
  SHOT('14-kurulum');
  if (inst) {
    // Video oynamadığı için burada ekran okunabilir: kurulum düğmesini bul ve dokun
    await clearDialogs();
    let xml = '';
    try {
      adb('shell uiautomator dump /sdcard/oi.xml');
      xml = adb('shell cat /sdcard/oi.xml');
    } catch {}
    const node = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0]).find((n) => /text="(UPDATE|INSTALL|Update|Install|GÜNCELLE|Güncelle|YÜKLE|Yükle)"/.test(n));
    const b = node && node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (b) adb(`shell input tap ${(+b[1] + +b[3]) >> 1} ${(+b[2] + +b[4]) >> 1}`);
    else for (const k of [61, 61, 66]) adb(`shell input keyevent ${k}`); // klavyeyle: sekme + giriş
    const ok = await waitFor(() => /versionCode=(\d+)/.test(adb('shell dumpsys package com.ortakizle.app')) && +adb('shell dumpsys package com.ortakizle.app').match(/versionCode=(\d+)/)[1] > startCode, 180000, 3000);
    ok ? pass('Güncelleme üstüne kuruldu (eskisi silinmedi)') : fail('Güncelleme kurulmadı');
  }
}

const crash = adb('logcat -d -b crash');
crash.includes('com.ortakizle') ? fail('Çökme kaydı var:\n' + crash.slice(0, 2000)) : pass('Çökme kaydı yok');
for (const e of [...errors, ...ui.errors.map((x) => 'UI: ' + x), ...(player ? player.errors.map((x) => 'Oynatıcı: ' + x) : [])]) fail(e);
kardes.disconnect();

console.log(failed ? `BAŞARISIZ (${failed})` : 'Emülatör testi geçti ✔');
process.exit(failed ? 1 : 0);
