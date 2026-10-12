// HASSASİYET testi: iki uygulama, internetteki gibi gecikmeli (her adımda 60±25 ms) aracı
// üzerinden. Gerçek iki videonun aynı andaki konum farkını milisaniye düzeyinde ölçer:
// birlikte başlama, durdurunca aynı kare, takılmadan sonra toparlanma, sarma, 3-2-1, bölümün
// gerçek dakikası video zamanından farklı olan (Disney+ gibi) sayfalar ve güvenli mod.
//   node tests/e2e-precision.mjs
import { loadPlaywright, chromeOptions, testVideo, startServer, startBroker, TEST_CODE, reporter, sleep } from './helpers.mjs';
import { makeApp, waitFor } from './app-harness.mjs';

const { chromium } = await loadPlaywright();
const VIDEO = testVideo();

const PORT = 8797;
const broker = await startBroker(18890, 18891);
broker.setDelay(60, 25); // istemci→aracı→oda→aracı→istemci: ~250 ms gidiş-dönüş
const srv = await startServer(PORT, { ODA_KODU: TEST_CODE, ARACI: broker.ws });
await sleep(800);
const browser = await chromium.launch(chromeOptions({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] }));
const app = (label) => makeApp(browser, { label, port: PORT, brokerWs: broker.ws, video: VIDEO, debug: !!process.env.DEBUG });

// Paylaşılan CI makinelerinde zamanlama oynak: sınırlar iki katı
const K = process.env.CI ? 2 : 1;
const R = reporter();
const { pass, fail } = R;

// İki videonun aynı andaki konum farkı (sn). off*: sayfanın "bölüm dakikası = video zamanı + off"
const snap = (p) => p.evaluate(() => ({ paused: v.paused, t: v.currentTime, now: performance.timeOrigin + performance.now(), rate: v.playbackRate }));
async function gap(A, B, offA = 0, offB = 0) {
  const [a, b] = await Promise.all([snap(A.player), snap(B.player)]);
  const at = Math.max(a.now, b.now);
  const ta = a.t + offA + (a.paused ? 0 : ((at - a.now) / 1000) * a.rate);
  const tb = b.t + offB + (b.paused ? 0 : ((at - b.now) / 1000) * b.rate);
  return { d: ta - tb, a, b };
}
const ms = (x) => `${Math.round(x * 1000)} ms`;
// Bir süre boyunca farkın en kötüsü
async function worst(A, B, seconds, offA = 0, offB = 0) {
  let w = 0;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const g = await gap(A, B, offA, offB);
    w = Math.max(w, Math.abs(g.d));
    await sleep(150);
  }
  return w;
}
const tap = (X, fn, arg) => X.player.evaluate(fn, arg);

async function openBoth(A, B, urlA, urlB) {
  for (const X of [A, B]) {
    if (!(await X.ui.evaluate(() => !document.getElementById('vWatch').hidden))) {
      await X.ui.locator('.pf[data-p="disney"]').click();
      await sleep(1200);
    }
  }
  await A.player.goto(urlA);
  await B.player.goto(urlB);
  await A.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  await B.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  await sleep(3000); // motorlar videoyu bulsun, "izliyor" bilgisi gitsin
}

try {
  const A = await app('Berkay');
  const B = await app('Kardeş');
  for (const X of [A, B]) {
    await X.ui.fill('#nameInput', X.label);
    await X.ui.click('#nameForm button');
    await X.ui.fill('#codeInput', 'k7m4qx');
    await X.ui.click('#codeForm button');
  }
  (await waitFor(async () => /2 kişi/.test(await A.ui.locator('#connText').innerText()), 40000)) ? pass('İkisi bağlandı (gecikmeli ağ)') : fail('Bağlanamadılar');
  await sleep(4000); // saat eşitlemesi birkaç ölçüm alsın
  const rtt = await A.ui.evaluate(() => document.getElementById('tkPing').textContent);
  console.log('    gidiş-dönüş:', rtt);

  // ------------------------------------------------ 1) Bölüm dakikası = video zamanı
  console.log('  • Dakika doğrudan okunabilen sayfa');
  await openBoth(A, B, 'https://www.disneyplus.com/play/loki', 'https://www.disneyplus.com/play/loki');
  await tap(A, () => { tap(); v.currentTime = 20; });
  await sleep(1500);
  let g = await gap(A, B);
  g.a.paused && g.b.paused && Math.abs(g.d) < 0.05 * K ? pass(`Durmuşken sarma: aynı kare (fark ${ms(g.d)})`) : fail(`Durmuşken sarma: ${JSON.stringify(g)}`);

  await tap(A, () => (tap(), v.play()));
  await waitFor(async () => !(await snap(B.player)).paused, 4000, 50);
  await sleep(300);
  g = await gap(A, B);
  !g.a.paused && !g.b.paused && Math.abs(g.d) < 0.12 * K ? pass(`Oynat: ikisi aynı anda başladı (fark ${ms(g.d)})`) : fail(`Oynat başlangıcı: ${JSON.stringify(g)}`);
  let w = await worst(A, B, 4);
  w < 0.15 * K ? pass(`Oynarken 4 sn boyunca en büyük fark ${ms(w)}`) : fail(`Oynarken fark ${ms(w)}`);

  // B'nin videosu takılıp geride kalıyor (olay üretmeden)
  await B.player.evaluate(() => stall(1000, 0.3));
  await sleep(1200);
  g = await gap(A, B);
  console.log(`    takılma sonrası fark: ${ms(g.d)}`);
  const healed = await waitFor(async () => Math.abs((await gap(A, B)).d) < 0.08 * K, 10000, 150);
  healed ? pass(`Takılan taraf hızla fark ettirmeden yetişti (başta ${ms(g.d)})`) : fail(`Takılma sonrası fark kapanmadı: ${ms((await gap(A, B)).d)}`);
  const rateNow = (await snap(B.player)).rate;
  await sleep(4000);
  const rateLater = (await snap(B.player)).rate;
  rateLater === 1 ? pass('Yetişince hız normale döndü') : fail(`Hız normale dönmedi: ${rateNow} → ${rateLater}`);

  // B durdurur: ikisi aynı karede durmalı
  await tap(B, () => (tap(), v.pause()));
  await sleep(1500);
  g = await gap(A, B);
  g.a.paused && g.b.paused && Math.abs(g.d) < 0.05 * K ? pass(`Durdur (B'den): aynı kare (fark ${ms(g.d)})`) : fail(`Durdur: ${JSON.stringify(g)}`);

  // B paneldeki oynat düğmesiyle başlatır
  await B.ui.locator('#tPlay').click();
  await waitFor(async () => !(await snap(A.player)).paused, 4000, 50);
  await sleep(300);
  g = await gap(A, B);
  Math.abs(g.d) < 0.12 * K && !g.a.paused ? pass(`Panelden oynat: aynı anda (fark ${ms(g.d)})`) : fail(`Panelden oynat: ${JSON.stringify(g)}`);

  // A oynarken ileri sarar
  for (const [i, to] of [[1, 70], [2, 30]]) {
    await tap(A, (t) => { tap(); v.currentTime = t; }, to);
    await sleep(4000);
    w = await worst(A, B, 2);
    w < 0.15 * K ? pass(`Oynarken sarma (${i}) sonrası fark ${ms(w)}`) : fail(`Sarma (${i}) sonrası fark ${ms(w)}`);
  }

  // 3-2-1: herkes durur, aynı kareye gelir, aynı anda başlar
  await B.ui.locator('#tCount').click();
  await sleep(1500);
  g = await gap(A, B);
  g.a.paused && g.b.paused && Math.abs(g.d) < 0.05 * K ? pass(`3-2-1 sırasında ikisi aynı karede bekliyor (fark ${ms(g.d)})`) : fail(`3-2-1 bekleme: ${JSON.stringify(g)}`);
  await waitFor(async () => !(await snap(A.player)).paused, 5000, 50);
  await sleep(300);
  g = await gap(A, B);
  !g.a.paused && !g.b.paused && Math.abs(g.d) < 0.12 * K ? pass(`3-2-1 sonrası aynı anda başladı (fark ${ms(g.d)})`) : fail(`3-2-1 sonrası: ${JSON.stringify(g)}`);
  await tap(A, () => (tap(), v.pause()));
  await sleep(1500);

  // ------------------------------------------------ 2) Disney+ gibi: dakika yalnızca çubukta
  console.log('  • Dakika yalnızca oynatıcı çubuğunda (video zamanı her cihazda farklı)');
  // Aynı sahne: A'nın video zamanı 30 iken B'ninki 0 (A: dakika = video + 900, B: video + 930)
  await openBoth(A, B, 'https://www.disneyplus.com/play/loki?offset=900', 'https://www.disneyplus.com/play/loki?offset=930');
  await tap(A, () => { tap(); v.currentTime = 40; });
  await sleep(1500);
  await tap(A, () => (tap(), v.play()));
  await sleep(6000); // çubuk okunarak dakika ofseti oturur
  w = await worst(A, B, 4, 900, 930);
  w < 0.2 * K ? pass(`Çubuktan okunan dakikayla oynarken en büyük fark ${ms(w)}`) : fail(`Çubuk modu fark ${ms(w)}`);
  await tap(B, () => (tap(), v.pause()));
  await sleep(1500);
  g = await gap(A, B, 900, 930);
  g.a.paused && g.b.paused && Math.abs(g.d) < 0.2 * K ? pass(`Çubuk modunda durdur: aynı sahne (fark ${ms(g.d)})`) : fail(`Çubuk modu durdur: ${JSON.stringify(g)}`);
  const tc = await B.ui.locator('#wTc').innerText();
  /15:\d\d/.test(tc) ? pass(`Panel gerçek dakikayı gösteriyor (${tc.replace(/\s+/g, ' ')})`) : fail(`Panel dakikası: ${tc}`);

  // ------------------------------------------------ 3) Güvenli mod: dakika hiç okunamıyor
  console.log('  • Güvenli mod (dakika okunamıyor)');
  await openBoth(A, B, 'https://www.disneyplus.com/play/loki?unreliable=1', 'https://www.disneyplus.com/play/loki?unreliable=1');
  // İkisi farklı yerde; kendi videolarını elle aynı sahneye getirirler (paylaşılmaz)
  await tap(A, () => { tap(); v.currentTime = 50; });
  await tap(B, () => { tap(); v.currentTime = 50; });
  await sleep(1500);
  await tap(A, () => (tap(), v.play()));
  await waitFor(async () => !(await snap(B.player)).paused, 4000, 50);
  await sleep(300);
  g = await gap(A, B);
  Math.abs(g.d) < 0.12 * K && !g.b.paused ? pass(`Güvenli mod: aynı anda başladı (fark ${ms(g.d)})`) : fail(`Güvenli mod başlangıç: ${JSON.stringify(g)}`);
  await B.player.evaluate(() => stall(800, 0.3));
  await sleep(1000);
  const healed2 = await waitFor(async () => Math.abs((await gap(A, B)).d) < 0.08 * K, 10000, 150);
  healed2 ? pass('Güvenli modda da takılan taraf yetişti') : fail(`Güvenli mod takılma: ${ms((await gap(A, B)).d)}`);
  await tap(A, () => (tap(), v.pause()));
  await sleep(1500);
  g = await gap(A, B);
  g.a.paused && g.b.paused && Math.abs(g.d) < 0.05 * K ? pass(`Güvenli modda durdur: aynı kare (fark ${ms(g.d)})`) : fail(`Güvenli mod durdur: ${JSON.stringify(g)}`);
  const chip = await B.ui.locator('#wChipTxt').innerText();
  console.log('    B panel durumu:', chip);

  for (const X of [A, B]) for (const l of X.log) fail(`${X.label}: ${l}`);
} catch (e) {
  fail(e.stack);
} finally {
  srv.kill();
  await browser.close();
  await broker.close();
}
console.log(R.failed ? `BAŞARISIZ (${R.failed})` : 'Hassasiyet testi geçti ✔');
process.exit(R.failed ? 1 : 0);
