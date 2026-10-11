// Android uygulamasının JavaScript tarafının uçtan uca testi. Yerel (Kotlin) köprüyü
// taklit eder: arayüz sayfası + oynatıcı sayfası, aradaki mesajlar MainActivity'deki gibi
// (OrtakNative.toPlayer / OI.fromPlayer) taşınır.
//   node tests/e2e-app.mjs
import os from 'os';
import { loadPlaywright, chromeOptions, testVideo, startServer, startBroker, TEST_CODE, reporter, sleep } from './helpers.mjs';
import { makeApp } from './app-harness.mjs';

const { chromium } = await loadPlaywright();
const VIDEO = testVideo();
const SHOTS = process.env.SHOTS_DIR || os.tmpdir();

const PORT = 8794;
const broker = await startBroker(18880, 18881);
const srv = await startServer(PORT, { ODA_KODU: TEST_CODE, ARACI: broker.ws });
await sleep(800);
const browser = await chromium.launch(chromeOptions({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] }));
const app = (label, w, h) => makeApp(browser, { label, port: PORT, brokerWs: broker.ws, video: VIDEO, w, h });

const R = reporter();
const { pass, fail } = R;
const vs = (p) => p.evaluate(() => ({ paused: v.paused, t: +v.currentTime.toFixed(2) }));

try {
  const A = await app('Berkay', 1280, 800);
  const B = await app('Kardeş', 400, 860);

  for (const X of [A, B]) {
    await X.ui.fill('#nameInput', X.label);
    await X.ui.click('#nameForm button');
    await X.ui.fill('#codeInput', 'k7m4qx');
    await X.ui.click('#codeForm button');
  }
  await sleep(4000);
  const chipA = await A.ui.locator('#connText').innerText();
  /Bağlı · 2 kişi/.test(chipA) ? pass('İkisi de oda koduyla bağlandı: ' + chipA) : fail('Bağlantı: ' + chipA);
  const seats = await A.ui.locator('#tkSeats').innerText();
  /Kardeş/.test(seats) ? pass('Oda kartında iki kişi görünüyor') : fail('Oda kartı: ' + seats);
  const codeShown = await A.ui.locator('#tkAddrs').innerText();
  /K7M-4QX/.test(codeShown) ? pass('Oda kartında kod görünüyor: K7M-4QX') : fail('Kod görünmüyor: ' + codeShown);
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

  await A.player.evaluate(() => { window.tap && tap(); v.currentTime = 20; v.play(); });
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

  // Paneldeki oynat/durdur ve 10 sn atlama düğmeleri ikisinde birden çalışmalı
  await B.ui.locator('#tPlay').click();
  await sleep(1500);
  a = await vs(A.player); b = await vs(B.player);
  a.paused && b.paused ? pass(`Paneldeki durdur düğmesi ikisini de durdurdu (A ${a.t}, B ${b.t})`) : fail(`Panel durdur: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
  const before10 = b.t;
  await B.ui.locator('#tFwd').click();
  await sleep(1500);
  a = await vs(A.player); b = await vs(B.player);
  Math.abs(b.t - (before10 + 10)) < 0.6 && Math.abs(a.t - b.t) < 0.3 ? pass(`10 sn ileri ikisinde birden (A ${a.t}, B ${b.t})`) : fail(`10 sn ileri: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
  await B.ui.locator('#tPlay').click();
  await sleep(1500);
  a = await vs(A.player); b = await vs(B.player);
  !a.paused && !b.paused ? pass('Paneldeki oynat düğmesi ikisini de oynattı') : fail(`Panel oynat: ${JSON.stringify(a)} ${JSON.stringify(b)}`);

  await B.ui.locator('#chatInput').fill('çay hazır');
  await B.ui.locator('#chatInput').press('Enter');
  await sleep(700);
  const msgsA = await A.ui.locator('#vWatch').innerText().catch(() => '');
  /çay hazır/.test(msgsA) ? pass('Mesaj A\'nın panelinde') : fail('Mesaj gelmedi');
  await B.ui.getByRole('button', { name: 'Tepki: 😂' }).click();
  await sleep(800);
  A.overlays('react').some((r) => r.emoji === '😂' && r.name === 'Kardeş') ? pass('Tepki A\'nın videosunda (yerel katman) uçtu') : fail('Tepki yok: ' + JSON.stringify(A.overlays('react')));

  // B sol üstteki geri düğmesiyle salona döner (onaylayarak)
  await B.ui.evaluate(() => OI.onBack());
  await sleep(200);
  await B.ui.evaluate(() => OI.onConfirm('exit', true));
  await sleep(1200);
  (await B.ui.locator('#vLobby').isVisible()) ? pass('Geri düğmesiyle ana ekrana dönüş çalışıyor') : fail('Ana ekrana dönülemedi');
  (await vs(A.player)).paused ? pass('B çıkınca A\'da video durdu') : fail('B çıkınca A durmadı');

  for (const X of [A, B]) for (const l of X.log) fail(`${X.label}: ${l}`);
} catch (e) {
  fail(e.stack);
} finally {
  srv.kill();
  await browser.close();
  await broker.close();
}
console.log(R.failed ? `BAŞARISIZ (${R.failed})` : 'Uygulama benzetim testi geçti ✔');
process.exit(R.failed ? 1 : 0);
