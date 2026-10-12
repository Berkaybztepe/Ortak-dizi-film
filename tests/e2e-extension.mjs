// Eklenti uçtan uca testi: iki ayrı Chromium'a eklentiyi kurar, sahte bir Disney+
// sayfasında oynat/durdur/sar, geri sayım, tepki, bekleme ve sohbeti dener.
//   node tests/e2e-extension.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT, loadPlaywright, chromeOptions, testVideo, routeFakeDisney, startServer, startBroker, TEST_CODE, reporter, sleep } from './helpers.mjs';

const { chromium } = await loadPlaywright();
const EXT = path.join(ROOT, 'extension');
const VIDEO = testVideo();
const SHOTS = process.env.SHOTS_DIR || os.tmpdir();
const PORT = 8799;
// Oda kodu yolu: yerel aracı + kodla açılmış oda (farklı evlerdeki gibi)
const broker = await startBroker(18840, 18841);
const srv = await startServer(PORT, { ODA_KODU: TEST_CODE, ARACI: broker.ws });
await sleep(800);

async function browser(name) {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'oi-')), {
    ...chromeOptions(),
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'],
  });
  await routeFakeDisney(ctx, VIDEO);
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  await sw.evaluate((url) => (globalThis.__ortakIzleBrokers = [url]), broker.ws);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.fill('#serverUrl', 'k7m-4qx');
  await popup.fill('#name', name);
  await popup.click('#toggle');
  await popup.waitForFunction(() => document.getElementById('chip').textContent.startsWith('Bağlı'), null, { timeout: 15000 });
  return { ctx, popup };
}

const R = reporter();
const { pass, fail } = R;
async function waitFor(fn, ms = 10000, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(every);
  }
  return false;
}
const vstate = (p) => p.evaluate(() => ({ paused: v.paused, t: +v.currentTime.toFixed(2) }));

try {
  const A = await browser('Berkay');
  const B = await browser('Kardeş');
  const pa = await A.ctx.newPage();
  const pb = await B.ctx.newPage();
  for (const [n, p] of [['A', pa], ['B', pb]]) p.on('pageerror', (e) => fail(`${n} sayfa hatası: ${e.message}`));

  // Popup üyeleri gösteriyor mu
  await sleep(500);
  const members = await A.popup.locator('#members').innerText();
  members.includes('Kardeş') ? pass('Popup odadakileri gösteriyor') : fail('Popup üyeler: ' + members);
  await A.popup.screenshot({ path: `${SHOTS}/ext-popup.png` });

  await pb.goto('https://www.disneyplus.com/home');
  await sleep(1500);
  await pa.goto('https://www.disneyplus.com/play/loki');
  await pa.waitForFunction(() => window.v && v.readyState >= 1);
  await sleep(3500);
  const ob = pb.locator('[data-ortak-izle="overlay"]');
  const offer = ob.getByRole('button', { name: 'Sen de aç' });
  (await offer.count()) ? pass('B, "Berkay Loki açtı" önerisini gördü') : fail('Öneri gelmedi');
  await offer.click();
  await pb.waitForURL('**/play/loki');
  await pb.waitForFunction(() => window.v && v.readyState >= 1);
  await sleep(2000);

  await pa.evaluate(() => { window.tap && tap(); v.currentTime = 30; });
  await sleep(800);
  await sleep(1600);
  await pa.evaluate(() => (window.tap && tap(), v.play()));
  (await waitFor(async () => !(await vstate(pa)).paused && !(await vstate(pb)).paused, 6000))
    ? pass('Sonra oynatınca ikisi birlikte devam etti')
    : fail(`Yeniden oynatma: A ${JSON.stringify(await vstate(pa))} B ${JSON.stringify(await vstate(pb))}`);
  let a = await vstate(pa), b = await vstate(pb);
  !b.paused && Math.abs(a.t - b.t) < 1.5 ? pass(`Oynat senkron (A ${a.t}, B ${b.t})`) : fail(`Oynat: A ${JSON.stringify(a)} B ${JSON.stringify(b)}`);

  await pb.evaluate(() => (window.tap && tap(), v.pause()));
  await sleep(1500);
  a = await vstate(pa); b = await vstate(pb);
  a.paused && Math.abs(a.t - b.t) < 0.3 ? pass(`Durdur aynı karede (A ${a.t}, B ${b.t})`) : fail(`Durdur: A ${JSON.stringify(a)} B ${JSON.stringify(b)}`);

  await pa.evaluate(() => { window.tap && tap(); v.currentTime = 90; });
  await sleep(1500);
  b = await vstate(pb);
  Math.abs(b.t - 90) < 0.5 && b.paused ? pass('Sarma senkron') : fail('Sarma: ' + JSON.stringify(b));

  // Geri sayım: A'nın panelinden 3-2-1
  const oa = pa.locator('[data-ortak-izle="overlay"]');
  await oa.getByRole('button', { name: 'Ortak İzle panelini aç' }).click();
  await oa.getByRole('button', { name: '3-2-1' }).click();
  await sleep(1500);
  const countShown = await pb.locator('[data-ortak-izle="stage"]').locator('.count').isVisible();
  b = await vstate(pb);
  countShown && b.paused ? pass('Geri sayım B\'de görünüyor, video bekliyor') : fail(`Geri sayım: görünür=${countShown} ${JSON.stringify(b)}`);
  await pb.screenshot({ path: `${SHOTS}/ext-countdown.png` });
  await sleep(3000);
  a = await vstate(pa); b = await vstate(pb);
  !a.paused && !b.paused && Math.abs(a.t - b.t) < 0.5 ? pass(`Geri sayım bitince ikisi birlikte başladı (A ${a.t}, B ${b.t})`) : fail(`Geri sayım sonrası A ${JSON.stringify(a)} B ${JSON.stringify(b)}`);

  // Tepki
  await oa.getByRole('button', { name: 'Tepki: 🔥' }).click();
  await sleep(500);
  const rx = await pb.locator('[data-ortak-izle="stage"]').locator('.r').count();
  rx ? pass('Tepki karşı tarafın videosunun üstünde göründü') : fail('Tepki görünmedi');

  // Yükleniyor (buffer): üçüncü bir katılımcı aynı bölümde yükleniyor
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: 'join', name: 'Kuzen', room: 'salon' })); // üçüncü kişi aynı Wi-Fi'dan, adresle
  await sleep(300);
  ws.send(JSON.stringify({ t: 'nav', url: 'https://www.disneyplus.com/play/loki', title: 'Loki', platform: 'Disney+', watching: true }));
  await sleep(300);
  ws.send(JSON.stringify({ t: 'buffer', on: true }));
  await sleep(1200);
  a = await vstate(pa); b = await vstate(pb);
  const note = await pa.locator('[data-ortak-izle="stage"]').locator('.note').innerText().catch(() => '');
  a.paused && b.paused && /Kuzen/.test(note) ? pass(`Biri yüklenirken ikisi de bekledi ("${note}")`) : fail(`Bekleme: A ${JSON.stringify(a)} B ${JSON.stringify(b)} not="${note}"`);
  await pa.screenshot({ path: `${SHOTS}/ext-waiting.png` });
  ws.send(JSON.stringify({ t: 'buffer', on: false }));
  await sleep(1500);
  a = await vstate(pa); b = await vstate(pb);
  !a.paused && !b.paused ? pass('Yükleme bitince ikisi de devam etti') : fail(`Devam: A ${JSON.stringify(a)} B ${JSON.stringify(b)}`);
  // İzleyen biri odadan çıkınca video herkeste durur
  ws.close();
  (await waitFor(async () => (await vstate(pa)).paused && (await vstate(pb)).paused, 6000))
    ? pass('İzleyen biri çıkınca video ikisinde de durdu')
    : fail(`Çıkınca durma: A ${JSON.stringify(await vstate(pa))} B ${JSON.stringify(await vstate(pb))}`);
  await sleep(1600);
  await pa.evaluate(() => (window.tap && tap(), v.play()));
  (await waitFor(async () => !(await vstate(pa)).paused && !(await vstate(pb)).paused, 6000))
    ? pass('Sonra oynatınca ikisi birlikte devam etti')
    : fail(`Yeniden oynatma: A ${JSON.stringify(await vstate(pa))} B ${JSON.stringify(await vstate(pb))}`);

  // Sohbet + boşluk tuşu videoyu durdurmamalı
  const before = await vstate(pa);
  const input = oa.getByPlaceholder('Mesaj yaz');
  await input.fill('bu bölüm efsane');
  await input.press('Space');
  await input.press('Enter');
  await sleep(800);
  const afterA = await vstate(pa);
  !before.paused && !afterA.paused ? pass('Yazarken boşluk tuşu videoyu durdurmadı') : fail(`Boşluk tuşu videoyu etkiledi: önce ${JSON.stringify(before)} sonra ${JSON.stringify(afterA)}`);
  const bText = await ob.locator('.toasts').innerText();
  /bu bölüm efsane/.test(bText) ? pass('B mesajı bildirim olarak gördü') : fail('B mesajı görmedi: ' + bText);
  await ob.getByRole('button', { name: 'Ortak İzle panelini aç' }).click();
  await sleep(300);
  await pb.screenshot({ path: `${SHOTS}/ext-panel.png` });

  await A.ctx.close();
  await B.ctx.close();
} catch (e) {
  fail(e.stack);
} finally {
  srv.kill();
  await broker.close();
}
console.log(R.failed ? `BAŞARISIZ (${R.failed})` : 'Eklenti uçtan uca testi geçti ✔');
process.exit(R.failed ? 1 : 0);
