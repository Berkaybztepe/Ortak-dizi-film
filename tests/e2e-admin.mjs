// YÖNETİCİ ve KATMAN testi (uygulama benzetimi): odayı açan yönetici, bölüm kilidi, geri düğmesi,
// kazara çıkınca videonun durması, Android katmanına giden tepki / akan mesaj / 3-2-1 / uyarılar.
//   node tests/e2e-admin.mjs
import { loadPlaywright, chromeOptions, testVideo, startServer, startBroker, TEST_CODE, reporter, sleep } from './helpers.mjs';
import { makeApp, waitFor } from './app-harness.mjs';

const { chromium } = await loadPlaywright();
const VIDEO = testVideo();
const PORT = 8799;
const broker = await startBroker(18900, 18901);
const srv = await startServer(PORT, { ODA_KODU: TEST_CODE, ARACI: broker.ws });
await sleep(800);
const browser = await chromium.launch(chromeOptions({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] }));
const R = reporter();
const { pass, fail } = R;
const vs = (p) => p.evaluate(() => ({ paused: v.paused, t: +v.currentTime.toFixed(2) }));
const LOKI = 'https://www.disneyplus.com/play/loki';
const last = (arr) => arr[arr.length - 1];

try {
  // A odayı açan cihaz gibi doğrudan (yerel) bağlanır → yönetici; B oda koduyla (internetten)
  const A = await makeApp(browser, { label: 'Berkay', port: PORT, brokerWs: broker.ws, video: VIDEO });
  const B = await makeApp(browser, { label: 'Kardeş', port: PORT, brokerWs: broker.ws, video: VIDEO, w: 420, h: 860 });
  await A.ui.fill('#nameInput', 'Berkay');
  await A.ui.click('#nameForm button');
  await A.ui.click('#moreWays summary');
  await A.ui.fill('#addrInput', `127.0.0.1:${PORT}`);
  await A.ui.click('#joinForm button');
  await B.ui.fill('#nameInput', 'Kardeş');
  await B.ui.click('#nameForm button');
  await B.ui.fill('#codeInput', 'k7m4qx');
  await B.ui.click('#codeForm button');
  (await waitFor(async () => /2 kişi/.test(await B.ui.locator('#connText').innerText()), 15000)) ? pass('İkisi bağlandı') : fail('Bağlanamadılar');
  await sleep(1000);

  // ---- Yönetici ve kilit
  /yönetici/.test(await B.ui.locator('#tkSeats').innerText()) ? pass('Oda kartında yönetici görünüyor') : fail('Yönetici görünmüyor: ' + (await B.ui.locator('#tkSeats').innerText()));
  await A.ui.locator('#settingsBtn').click();
  await sleep(300);
  (await A.ui.locator('#lockRow').isVisible()) && (await A.ui.locator('#setLock').isChecked())
    ? pass('Yöneticide "Bölümü sadece ben seçeyim" açık')
    : fail('Kilit ayarı yöneticide görünmüyor');
  (await B.ui.locator('#lockRow').isHidden()) ? pass('Diğer kişide kilit ayarı yok') : fail('Kilit ayarı B\'de görünüyor');
  (await B.ui.locator('.pf[data-p="disney"]').getAttribute('class')).includes('off') ? pass('Kilitliyken B\'de platformlar kapalı') : fail('B\'nin platformları açık');
  await B.ui.locator('.pf[data-p="disney"]').click();
  await sleep(400);
  !B.called('openPlayer').length && /seçiyor/.test(await B.ui.locator('#toasts').innerText())
    ? pass('B bölüm açamadı, "Bölümü Berkay seçiyor" dedi')
    : fail('Kilit B\'yi durdurmadı');

  // ---- Yönetici açınca B kendiliğinden geçer
  await A.ui.locator('.pf[data-p="disney"]').click();
  await sleep(800);
  await A.player.goto(LOKI);
  (await waitFor(() => B.called('openPlayer').some((u) => /play\/loki/.test(u)), 10000))
    ? pass('Yönetici bölümü açınca B\'de de kendiliğinden açıldı')
    : fail('B otomatik geçmedi: ' + JSON.stringify(B.called('openPlayer')));
  await B.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  await A.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  await sleep(2500);
  last(B.overlays('back'))?.show === false ? pass('B\'de geri düğmesi gizli') : fail('B geri düğmesi: ' + JSON.stringify(B.overlays('back')));
  last(A.overlays('back'))?.show !== false ? pass('Yöneticide geri düğmesi görünür') : fail('A geri düğmesi gizli');
  await B.ui.evaluate(() => OI.onBack());
  await sleep(300);
  /yönetiyor/.test(last(B.overlays('notice'))?.text || '') && !B.called('playerBack').length && !B.called('confirm').length
    ? pass('B geri hareketiyle çıkamadı: "' + last(B.overlays('notice')).text + '"')
    : fail('B geri: ' + JSON.stringify(B.overlays('notice')));

  // ---- Oynat; B kazara bölümden çıkarsa video durur ve B geri getirilir
  await A.player.evaluate(() => { tap(); v.currentTime = 20; v.play(); });
  (await waitFor(async () => !(await vs(B.player)).paused, 6000)) ? pass('Oynat ikisinde birden') : fail('B oynamadı');
  await sleep(1500);
  const opens = B.called('openPlayer').length;
  await B.player.goto('https://www.disneyplus.com/home');
  (await waitFor(async () => (await vs(A.player)).paused, 8000)) ? pass('B bölümden çıkınca A\'da video durdu') : fail('A durmadı');
  (await waitFor(() => A.overlays('notice').some((n) => /Kardeş bölümden çıktı/.test(n.text)), 4000))
    ? pass('A\'nın ekranında uyarı: "Kardeş bölümden çıktı · video durduruldu"')
    : fail('A\'ya uyarı gelmedi: ' + JSON.stringify(A.overlays('notice')));
  (await waitFor(() => B.called('openPlayer').length > opens, 9000)) ? pass('Kilitli B yöneticinin bölümüne geri getirildi') : fail('B geri getirilmedi');
  await B.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  await sleep(2500);

  // ---- Tepkiler ve mesajlar Android katmanına gider
  await A.ui.getByRole('button', { name: 'Tepki: 🔥' }).click();
  (await waitFor(() => B.overlays('react').some((r) => r.emoji === '🔥' && r.name === 'Berkay'), 4000))
    ? pass('Tepki karşı tarafın ekranında (yerel katman) uçtu')
    : fail('Tepki B\'ye ulaşmadı: ' + JSON.stringify(B.overlays('react')));
  A.overlays('react').some((r) => r.emoji === '🔥') ? pass('Gönderen kendi tepkisini de görüyor') : fail('Kendi tepkisi görünmedi');
  await B.ui.locator('#collapseBtn').click(); // sadece video
  await sleep(500);
  await A.ui.locator('#chatInput').fill('bu sahne efsane');
  await A.ui.locator('#chatInput').press('Enter');
  (await waitFor(() => B.overlays('msg').some((m) => m.text === 'bu sahne efsane' && m.name === 'Berkay'), 5000))
    ? pass('Sohbet kapalıyken mesaj videonun altından aktı')
    : fail('Akan mesaj yok: ' + JSON.stringify(B.overlays('msg')));
  await B.ui.locator('#fOpen').click();
  await sleep(500);

  // ---- 3-2-1 Android katmanında sayılır
  await A.ui.locator('#tCount').click();
  (await waitFor(() => B.overlays('count').some((c) => c.ms > 1500 && c.ms < 4000), 4000))
    ? pass('3-2-1 geri sayımı B\'nin ekranında')
    : fail('Geri sayım katmana gitmedi: ' + JSON.stringify(B.overlays('count')));
  await sleep(4500);
  let a = await vs(A.player), b = await vs(B.player);
  !a.paused && !b.paused && Math.abs(a.t - b.t) < 0.3 ? pass(`3-2-1 sonrası birlikte (A ${a.t}, B ${b.t})`) : fail(`3-2-1 sonrası ${JSON.stringify([a, b])}`);

  // ---- Yönetici geri düğmesine basar: onay sorulur, onaylayınca önce herkeste durur
  await A.ui.evaluate(() => OI.onBack());
  await sleep(300);
  const conf = last(A.called('confirm'));
  conf && conf.id === 'exit' && /ikinizde de durur/.test(conf.text) ? pass(`Çıkarken onay soruldu: "${conf.title} ${conf.text}"`) : fail('Onay sorulmadı: ' + JSON.stringify(conf));
  await A.ui.evaluate(() => OI.onConfirm('exit', false));
  await sleep(600);
  !(await vs(A.player)).paused ? pass('Vazgeçince izlemeye devam') : fail('Vazgeçince durdu');
  await A.ui.evaluate(() => OI.onBack());
  await sleep(200);
  await A.ui.evaluate(() => OI.onConfirm('exit', true));
  (await waitFor(async () => (await vs(B.player)).paused, 5000)) ? pass('Yönetici çıkınca B\'de video durdu') : fail('B durmadı');
  (await waitFor(async () => A.ui.locator('#vLobby').isVisible(), 3000)) ? pass('Yönetici ana ekrana döndü') : fail('A ana ekrana dönmedi');
  await sleep(1500);
  // Yönetici izlemiyorken B serbest
  (await waitFor(() => last(B.overlays('back'))?.show === true, 4000)) ? pass('Yönetici çıkınca B\'nin geri düğmesi açıldı') : fail('B geri düğmesi hâlâ gizli');

  // ---- Kilit kapatılınca B de bölüm seçebilir
  if (!(await A.ui.locator('#setLock').isVisible())) await A.ui.locator('#settingsBtn').click();
  await A.ui.locator('#setLock').uncheck();
  (await waitFor(async () => !(await B.ui.locator('#wLock').isVisible()), 4000)) ? pass('Kilit kapandı (B\'nin panelinde kilit yazısı gitti)') : fail('Kilit kapanmadı');

  for (const X of [A, B]) for (const l of X.log) fail(`${X.label}: ${l}`);
} catch (e) {
  fail(e.stack);
} finally {
  srv.kill();
  await browser.close();
  await broker.close();
}
console.log(R.failed ? `BAŞARISIZ (${R.failed})` : 'Yönetici ve katman testi geçti ✔');
process.exit(R.failed ? 1 : 0);
