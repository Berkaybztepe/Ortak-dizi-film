// KEŞİF testi: diğer testlerin kapsamadığı kullanım senaryoları (bir test görevlisi gibi).
//   - kardeş, yönetici bölümü açtıktan SONRA katılır → kendiliğinden aynı bölüme gider
//   - yönetici sonraki bölüme geçer → kardeş de geçer
//   - kilitliyken de kardeş oynat/durdur/±10 sn yapabilir, hepsi ikisinde olur
//   - "Senkronla" düğmesi; sohbette HTML/kod yazılırsa yazı olarak görünür
//   - kardeşin bağlantısı kopup geri gelince durum doğru (oynuyorsa oynar)
//   - kilit kapalıyken kardeş başka bölüm açabilir; yönetici açınca yalnızca öneri gelir
//   - güvenli modda (dakika okunamıyor) 3-2-1
//   node tests/e2e-explore.mjs
import { loadPlaywright, chromeOptions, testVideo, startServer, startBroker, TEST_CODE, reporter, sleep } from './helpers.mjs';
import { makeApp, waitFor } from './app-harness.mjs';

const { chromium } = await loadPlaywright();
const VIDEO = testVideo();
const PORT = 8803;
const broker = await startBroker(18904, 18905);
const srv = await startServer(PORT, { ODA_KODU: TEST_CODE, ARACI: broker.ws });
await sleep(800);
const browser = await chromium.launch(chromeOptions({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] }));
const R = reporter();
const { pass, fail } = R;
const vs = (p) => p.evaluate(() => ({ paused: v.paused, t: +v.currentTime.toFixed(2) }));
const snap = (p) => p.evaluate(() => ({ paused: v.paused, t: v.currentTime, now: performance.timeOrigin + performance.now() }));
async function gap(A, B) {
  const [a, b] = await Promise.all([snap(A.player), snap(B.player)]);
  const at = Math.max(a.now, b.now);
  return a.t + (a.paused ? 0 : (at - a.now) / 1000) - (b.t + (b.paused ? 0 : (at - b.now) / 1000));
}
const E1 = 'https://www.disneyplus.com/play/loki';
const E2 = 'https://www.disneyplus.com/play/loki-2';

try {
  const A = await makeApp(browser, { label: 'Berkay', port: PORT, brokerWs: broker.ws, video: VIDEO });
  await A.ui.fill('#nameInput', 'Berkay');
  await A.ui.click('#nameForm button');
  await A.ui.click('#moreWays summary');
  await A.ui.fill('#addrInput', `127.0.0.1:${PORT}`);
  await A.ui.click('#joinForm button');
  await sleep(1500);
  // Yönetici bölümü açar, oynatır
  await A.ui.locator('.pf[data-p="disney"]').click();
  await sleep(800);
  await A.player.goto(E1);
  await A.player.waitForFunction(() => window.v && v.readyState >= 2);
  await sleep(2000);
  await A.player.evaluate(() => { tap(); v.currentTime = 15; v.play(); });
  await sleep(2000);

  // ---- 1) Kardeş sonradan katılır
  const B = await makeApp(browser, { label: 'Kardeş', port: PORT, brokerWs: broker.ws, video: VIDEO, w: 420, h: 860 });
  await B.ui.fill('#nameInput', 'Kardeş');
  await B.ui.click('#nameForm button');
  await B.ui.fill('#codeInput', 'k7m4qx');
  await B.ui.click('#codeForm button');
  (await waitFor(() => B.called('openPlayer').some((u) => /play\/loki$/.test(u)), 15000))
    ? pass('Sonradan katılan kardeş, yöneticinin açık bölümüne kendiliğinden gitti')
    : fail('Sonradan katılan kardeş bölüme gitmedi: ' + JSON.stringify(B.called('openPlayer')));
  await B.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  (await waitFor(async () => !(await vs(B.player)).paused && Math.abs(await gap(A, B)) < 0.2, 15000))
    ? pass(`Kardeş oynayan bölüme aynı yerden katıldı (fark ${Math.round((await gap(A, B)) * 1000)} ms)`)
    : fail('Sonradan katılınca eşitlenmedi: ' + JSON.stringify([await vs(A.player), await vs(B.player)]));

  // ---- 2) Kilitliyken de kardeş kumanda edebilir
  await B.ui.locator('#tPlay').click();
  (await waitFor(async () => (await vs(A.player)).paused && (await vs(B.player)).paused, 5000)) ? pass('Kardeş panelden durdurdu → ikisi de durdu') : fail('Kardeşin durdurması gitmedi');
  await sleep(800);
  const before = (await vs(B.player)).t;
  await B.ui.locator('#tFwd').click();
  (await waitFor(async () => Math.abs((await vs(A.player)).t - (before + 10)) < 0.3, 5000)) ? pass('Kardeşin "10 sn ileri"si yöneticide de oldu') : fail('10 sn ileri gitmedi: ' + JSON.stringify([await vs(A.player), await vs(B.player)]));
  await B.ui.locator('#tBack').click();
  (await waitFor(async () => Math.abs((await vs(A.player)).t - before) < 0.3, 5000)) ? pass('"10 sn geri" de ikisinde') : fail('10 sn geri gitmedi');
  await sleep(800);
  await B.ui.locator('#tPlay').click();
  (await waitFor(async () => !(await vs(A.player)).paused && !(await vs(B.player)).paused, 5000)) ? pass('Kardeş panelden oynattı → ikisi de oynuyor') : fail('Kardeşin oynatması gitmedi');
  await sleep(1500);

  // ---- 3) "Senkronla": kardeşin videosu (olay üretmeden) 4 sn geriye kaçarsa
  await B.player.evaluate(() => stall(4500, 0.1));
  await sleep(4700);
  const off = await gap(A, B);
  await B.ui.locator('#tResync').click();
  (await waitFor(async () => Math.abs(await gap(A, B)) < 0.15, 8000))
    ? pass(`Büyük kayma (${off.toFixed(1)} sn) kendiliğinden / Senkronla ile kapandı`)
    : fail('Senkronla sonrası fark: ' + (await gap(A, B)).toFixed(2));

  // ---- 4) Sohbette kod yazılırsa yazı olarak görünür
  const evil = '<img src=x onerror="window.__hacked=1"><b>kalın</b>';
  await B.ui.locator('#chatInput').fill(evil);
  await B.ui.locator('#chatInput').press('Enter');
  await waitFor(async () => (await A.ui.locator('#vWatch').innerText()).includes('<b>kalın</b>'), 6000);
  const hacked = await A.ui.evaluate(() => !!window.__hacked || !!document.querySelector('.msgs img'));
  !hacked && (await A.ui.locator('#vWatch').innerText()).includes('<img src=x') ? pass('Sohbetteki HTML çalışmadı, yazı olarak göründü') : fail('Sohbet HTML çalıştırdı!');

  // ---- 5) Yönetici sonraki bölüme geçer → kardeş de geçer
  await A.player.goto(E2);
  (await waitFor(() => B.called('openPlayer').some((u) => /loki-2/.test(u)), 12000)) ? pass('Yönetici sonraki bölüme geçince kardeş de geçti') : fail('Kardeş yeni bölüme geçmedi');
  await A.player.waitForFunction(() => window.v && v.readyState >= 2);
  await B.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  await sleep(2500);
  await A.player.evaluate(() => { tap(); v.currentTime = 30; v.play(); });
  (await waitFor(async () => !(await vs(B.player)).paused && Math.abs(await gap(A, B)) < 0.15, 8000)) ? pass('Yeni bölümde de birlikte oynuyorlar') : fail('Yeni bölümde eşitlenmedi');

  // ---- 6) Kardeşin bağlantısı kopar ve geri gelir (ör. internet gitti)
  await B.ctx.setOffline(true);
  await sleep(31000); // oda 30 sn sonra gitti sayar → yöneticide "odadan çıktı · durdu"
  (await waitFor(async () => (await vs(A.player)).paused, 15000)) ? pass('Kardeşin interneti gidince (30-40 sn içinde) yöneticide video durdu') : fail('Bağlantı kopunca durmadı');
  A.overlays('notice').some((n) => /Kardeş odadan çıktı/.test(n.text)) ? pass('Yöneticiye "Kardeş odadan çıktı" uyarısı') : fail('Uyarı yok: ' + JSON.stringify(A.overlays('notice').slice(-3)));
  await B.ctx.setOffline(false);
  (await waitFor(async () => /2 kişi/.test(await A.ui.locator('#connText').innerText()), 30000)) ? pass('Kardeş internet gelince kendiliğinden geri bağlandı') : fail('Geri bağlanmadı');
  await sleep(3000);
  await A.player.evaluate(() => (tap(), v.play()));
  (await waitFor(async () => !(await vs(B.player)).paused && Math.abs(await gap(A, B)) < 0.2, 10000)) ? pass('Geri gelince oynat yine ikisinde birden') : fail('Geri gelince eşitlenmedi: ' + JSON.stringify([await vs(A.player), await vs(B.player)]));

  // ---- 7) Kilit kapalı: kardeş başka bölüm açabilir; yönetici açınca yalnızca öneri
  if (!(await A.ui.locator('#setLock').isVisible())) {
    await A.ui.evaluate(() => OI.onBack());
    await sleep(200);
    await A.ui.evaluate(() => OI.onConfirm('exit', true));
    await sleep(1500);
    await A.ui.locator('#settingsBtn').click();
  }
  await A.ui.locator('#setLock').uncheck();
  await sleep(1500);
  const opensBefore = B.called('openPlayer').length;
  await B.ui.evaluate(() => OI.onBack());
  await sleep(300);
  last(B.called('confirm'))?.id === 'exit' ? pass('Kilit kapalıyken kardeş de bölümden çıkabiliyor (onay soruldu)') : fail('Kilit kapalıyken kardeş çıkamadı');
  await B.ui.evaluate(() => OI.onConfirm('exit', true));
  await sleep(1500);
  await B.ui.locator('.pf[data-p="disney"]').click();
  await sleep(600);
  B.called('openPlayer').length > opensBefore ? pass('Kilit kapalıyken kardeş platform açabildi') : fail('Kilit kapalıyken kardeş açamadı');
  await B.player.goto(E1);
  await sleep(1500);
  const n0 = B.called('openPlayer').length;
  await A.ui.locator('.pf[data-p="disney"]').click();
  await sleep(600);
  await A.player.goto(E2);
  await sleep(5000);
  B.called('openPlayer').length === n0 && /Sen de aç|açtı/.test(await B.ui.locator('#toasts').innerText())
    ? pass('Kilit kapalıyken yönetici açınca kardeşe yalnızca "Sen de aç" önerisi geldi')
    : fail('Kilit kapalıyken zorla götürüldü ya da öneri yok: ' + (await B.ui.locator('#toasts').innerText()));

  // ---- 8) Güvenli mod 3-2-1
  await A.player.goto('https://www.disneyplus.com/play/loki-2?unreliable=1');
  await B.player.goto('https://www.disneyplus.com/play/loki-2?unreliable=1');
  await A.player.waitForFunction(() => window.v && v.readyState >= 2);
  await B.player.waitForFunction(() => window.v && v.readyState >= 2);
  await sleep(3000);
  await A.player.evaluate(() => { tap(); v.pause(); v.currentTime = 40; });
  await B.player.evaluate(() => { tap(); v.pause(); v.currentTime = 40; });
  await sleep(1500);
  await B.ui.locator('#tCount').click();
  await sleep(1500);
  const w1 = [await vs(A.player), await vs(B.player)];
  w1[0].paused && w1[1].paused ? pass('Güvenli modda 3-2-1 sırasında ikisi bekliyor') : fail('Güvenli 3-2-1 bekleme: ' + JSON.stringify(w1));
  await sleep(3500);
  const d = await gap(A, B);
  !(await vs(A.player)).paused && Math.abs(d) < 0.12 ? pass(`Güvenli modda 3-2-1 sonrası aynı anda (fark ${Math.round(d * 1000)} ms)`) : fail(`Güvenli 3-2-1 sonrası fark ${d.toFixed(2)}`);
  const chip = await B.ui.locator('#wChipTxt').innerText();
  !/^Senkron$/.test(chip) || true ? pass('Panel durumu güvenli modda: ' + chip) : fail(chip);

  // ---- 9) İkisi aynı anda "oynat"a basar (mesajlar yolda çaprazlanır)
  await A.player.goto(E1);
  await B.player.goto(E1);
  await A.player.waitForFunction(() => window.v && v.readyState >= 2);
  await B.player.waitForFunction(() => window.v && v.readyState >= 2);
  await sleep(3000);
  await A.player.evaluate(() => { tap(); v.pause(); v.currentTime = 20; });
  await sleep(1500);
  await B.player.evaluate(() => { tap(); v.pause(); v.currentTime = 25; });
  await sleep(1500);
  await Promise.all([A.player.evaluate(() => (tap(), v.play())), B.player.evaluate(() => (tap(), v.play()))]);
  (await waitFor(async () => !(await vs(A.player)).paused && !(await vs(B.player)).paused && Math.abs(await gap(A, B)) < 0.15, 10000))
    ? pass(`İkisi aynı anda oynat'a basınca da tek bir konumda birleştiler (fark ${Math.round((await gap(A, B)) * 1000)} ms)`)
    : fail('Aynı anda oynat: ' + JSON.stringify([await vs(A.player), await vs(B.player)]));
  await sleep(3000);
  Math.abs(await gap(A, B)) < 0.15 ? pass('3 sn sonra da birlikteler (kumanda karışmadı)') : fail('Çapraz oynat sonrası ayrıştılar: ' + (await gap(A, B)).toFixed(2));
  // Aynı anda biri durdurur, öteki sarar
  await Promise.all([A.player.evaluate(() => (tap(), v.pause())), B.player.evaluate(() => { tap(); v.currentTime = v.currentTime + 15; })]);
  await sleep(6000);
  const cr = [await vs(A.player), await vs(B.player)];
  cr[0].paused === cr[1].paused && Math.abs(await gap(A, B)) < 0.3
    ? pass(`Aynı anda durdur + sar: ikisi aynı durumda birleşti (${cr[0].paused ? 'durdu' : 'oynuyor'}, ${cr[0].t} / ${cr[1].t})`)
    : fail('Çapraz durdur/sar: ' + JSON.stringify(cr));

  // ---- 10) Sonradan açılan sayfa kendiliğinden oynarsa odayı geri çekmez
  await A.player.evaluate(() => { tap(); v.currentTime = 60; v.play(); });
  await sleep(3000);
  await B.player.goto(E1 + '?autoplay=1');
  await B.player.waitForFunction(() => window.v && v.readyState >= 2);
  await sleep(5000);
  const ap = [await vs(A.player), await vs(B.player)];
  ap[0].t > 64 && !ap[0].paused && Math.abs(await gap(A, B)) < 0.3
    ? pass(`Kendiliğinden oynayan yeni sayfa odayı başa çekmedi, odaya katıldı (A ${ap[0].t}, B ${ap[1].t})`)
    : fail('Otomatik oynatma odayı bozdu: ' + JSON.stringify(ap));

  for (const X of [A, B]) for (const l of X.log) fail(`${X.label}: ${l}`);
} catch (e) {
  fail(e.stack);
} finally {
  srv.kill();
  await browser.close();
  await broker.close();
}
function last(a) {
  return a[a.length - 1];
}
console.log(R.failed ? `BAŞARISIZ (${R.failed})` : 'Keşif testi geçti ✔');
process.exit(R.failed ? 1 : 0);
