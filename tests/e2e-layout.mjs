// İZLEME PANELİ yerleşimi ve kaydırma: telefon yatay / dikey / klavye açık boyutlarında sohbete yer
// kalıyor mu, panel kaydırınca kapanıyor mu, bildirim kaydırınca gidiyor mu, düğmeler hâlâ çalışıyor mu.
//   node tests/e2e-layout.mjs            (OUT=klasör verilirse ekran görüntüsü de alır)
import { loadPlaywright, chromeOptions, testVideo, startServer, startBroker, TEST_CODE, sleep } from './helpers.mjs';
import { makeApp, waitFor } from './app-harness.mjs';
const OUT = process.env.OUT;
const { chromium } = await loadPlaywright();
const PORT = 8797;
const broker = await startBroker(18960, 18961);
const srv = await startServer(PORT, { ODA_KODU: TEST_CODE, ARACI: broker.ws });
await sleep(800);
const browser = await chromium.launch(chromeOptions({ args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] }));
let bad = 0;
const ok = (c, m) => { console.log((c ? '✔ ' : '✘ ') + m); if (!c) bad++; };
try {
  const A = await makeApp(browser, { label: 'A', port: PORT, brokerWs: broker.ws, video: testVideo(), w: 380, h: 410 });
  await A.ui.fill('#nameInput', 'Berkay'); await A.ui.click('#nameForm button');
  await A.ui.click('#moreWays summary'); await A.ui.fill('#addrInput', `127.0.0.1:${PORT}`); await A.ui.click('#joinForm button');
  await sleep(1500);
  await A.ui.locator('.pf[data-p="disney"]').click();
  await sleep(500);
  await A.player.goto('https://www.disneyplus.com/play/loki');
  await A.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
  await A.ui.locator('#chatInput').fill('ilk mesaj'); await A.ui.locator('#chatInput').press('Enter');
  await A.ui.locator('#chatInput').fill('ikinci mesaj biraz daha uzun bir mesaj'); await A.ui.locator('#chatInput').press('Enter');
  await A.ui.locator('#chatInput').fill('üçüncü'); await A.ui.locator('#chatInput').press('Enter');
  await sleep(1200);
  for (const [name, w, h, mode] of [['yan-telefon', 380, 410, 'side'], ['yan-klavye', 380, 190, 'side'], ['alt-dikey', 410, 640, 'bottom'], ['alt-klavye', 410, 230, 'bottom'], ['yan-tablet', 380, 760, 'side']]) {
    await A.ui.setViewportSize({ width: w, height: h });
    await A.ui.evaluate((m) => OI.setLayout({ mode: m }), mode);
    await sleep(400);
    if (OUT) await A.ui.screenshot({ path: `${OUT}/${name}.png` });
    const m = await A.ui.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const msgs = r('#watchChatSlot .msgs'), comp = r('.composer');
      return { msgsH: Math.round(msgs.height), compBottom: Math.round(comp.bottom), vh: innerHeight, scrollW: document.documentElement.scrollWidth, vw: innerWidth };
    });
    ok(m.compBottom <= m.vh + 1 && m.scrollW <= m.vw, `${name}: yazı alanı görünür (alt ${m.compBottom}/${m.vh}), mesaj alanı ${m.msgsH}px, taşma yok`);
  }
  // Kaydırma: yanda sağa sürükle → panel kapanır
  await A.ui.setViewportSize({ width: 380, height: 410 });
  await A.ui.evaluate(() => OI.setLayout({ mode: 'side' }));
  await sleep(300);
  const n0 = A.called('setPanel').length;
  await A.ui.mouse.move(150, 120); await A.ui.mouse.down(); await A.ui.mouse.move(200, 125, { steps: 4 }); await A.ui.mouse.move(330, 130, { steps: 8 }); await A.ui.mouse.up();
  ok(await waitFor(() => A.called('setPanel').slice(n0).includes('closed'), 2000), 'Yan panel sağa kaydırınca kapandı');
  await A.ui.evaluate(() => OI.setLayout({ mode: 'side' })); await sleep(300);
  await A.ui.bringToFront(); // arka plandaki sekmede geçişler (transition) ilerlemez
  // Küçük kaydırma: geri döner
  const n1 = A.called('setPanel').length;
  await A.ui.mouse.move(150, 120); await A.ui.mouse.down(); await A.ui.mouse.move(190, 122, { steps: 4 }); await A.ui.mouse.up();
  await sleep(400);
  const dbg = { calls: A.called('setPanel').slice(n1), tf: await A.ui.evaluate(() => getComputedStyle(document.getElementById('vWatch')).transform + ' ' + document.body.className) };
  ok(dbg.calls.length === 0 && dbg.tf.startsWith('none'), 'Az kaydırınca panel yerine döndü ' + JSON.stringify(dbg));
  // Dikey kaydırma (mesajlar) paneli kapatmaz
  await A.ui.mouse.move(150, 300); await A.ui.mouse.down(); await A.ui.mouse.move(155, 200, { steps: 6 }); await A.ui.mouse.up();
  await sleep(300);
  ok(A.called('setPanel').length === n1, 'Yukarı-aşağı hareket paneli kapatmadı');
  // Düğmeye dokunmak hâlâ çalışıyor
  const p0 = A.called('toPlayer').filter((x) => /toggle/.test(JSON.stringify(x))).length;
  await A.ui.locator('#tPlay').click();
  ok(await waitFor(() => A.called('toPlayer').filter((x) => /toggle/.test(JSON.stringify(x))).length > p0, 2000), 'Oynat düğmesi dokunuşla çalışıyor');
  // Altta: aşağı kaydır → kapanır
  await A.ui.setViewportSize({ width: 410, height: 640 });
  await A.ui.evaluate(() => OI.setLayout({ mode: 'bottom' })); await sleep(300);
  const n2 = A.called('setPanel').length;
  await A.ui.mouse.move(200, 30); await A.ui.mouse.down(); await A.ui.mouse.move(202, 80, { steps: 4 }); await A.ui.mouse.move(205, 400, { steps: 10 }); await A.ui.mouse.up();
  ok(await waitFor(() => A.called('setPanel').slice(n2).includes('closed'), 2000), 'Alt panel aşağı kaydırınca kapandı');
  // Bildirim kaydırınca kapanır
  await A.ui.evaluate(() => OI.setLayout({ mode: 'side' })); await A.ui.setViewportSize({ width: 380, height: 410 }); await sleep(300);
  await A.ui.locator('#tCall').click();
  await sleep(300);
  const tb = await A.ui.locator('#toasts .toast').last().boundingBox();
  ok(!!tb, 'Bildirim göründü');
  if (tb) {
    await A.ui.mouse.move(tb.x + 30, tb.y + tb.height / 2); await A.ui.mouse.down(); await A.ui.mouse.move(tb.x + 80, tb.y + tb.height / 2, { steps: 4 }); await A.ui.mouse.move(tb.x + 300, tb.y + tb.height / 2, { steps: 8 }); await A.ui.mouse.up();
    await sleep(500);
    ok((await A.ui.locator('#toasts .toast').count()) === 0, 'Bildirim yana kaydırınca kapandı');
  }
  // Yüzen hap: alt yarıda bildirim üstte
  await A.ui.setViewportSize({ width: 360, height: 200 });
  await A.ui.evaluate(() => { OI.setLayout({ mode: 'float' }); OI.setFloatUp(true); });
  await sleep(300);
  const cls = await A.ui.evaluate(() => document.getElementById('vFloat').className);
  ok(/up/.test(cls), 'Yüzen hap alt konumda (bildirimler üstte açılır)');
  // Yüzen hapta kendi kumandamız (oynat/durdur, ±10)
  await A.ui.setViewportSize({ width: 360, height: 90 });
  await A.ui.evaluate(() => OI.setLayout({ mode: 'float' }));
  await sleep(300);
  const k0 = A.called('toPlayer').length;
  for (const id of ['fPlay', 'fBack', 'fFwd']) await A.ui.locator('#' + id).click();
  const cmds = A.called('toPlayer').slice(k0).map((x) => (typeof x === 'string' ? JSON.parse(x) : x)).filter((m) => m.t === 'cmd');
  ok(cmds.some((m) => m.cmd === 'toggle') && cmds.some((m) => m.cmd === 'seekBy' && m.delta === -10) && cmds.some((m) => m.cmd === 'seekBy' && m.delta === 10),
    'Hapta oynat/durdur ve ±10 çalışıyor ' + JSON.stringify(cmds.map((m) => m.cmd + (m.delta || ''))));
  const pillOver = await A.ui.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= 0; });
  ok(pillOver, 'Hap ekrana sığıyor');
  if (OUT) await A.ui.screenshot({ path: `${OUT}/hap.png`, omitBackground: true });

  // İzlerken yazma çubuğu: sohbet düğmesi → video üstte, altta yazı kutusu; mesaj gider, kapanır
  await A.ui.setViewportSize({ width: 800, height: 58 });
  await A.ui.evaluate(() => OI.setLayout({ mode: 'float' }));
  await sleep(300);
  const t0 = A.called('setPanel').length;
  await A.ui.evaluate(() => document.getElementById('fOpen').click());
  ok(await waitFor(() => A.called('setPanel').slice(t0).includes('type'), 2000), 'Sohbet düğmesi yazma çubuğunu açtı (panel değil)');
  await sleep(300);
  const typ = await A.ui.evaluate(() => ({
    bar: !document.getElementById('vType').hidden,
    input: !!document.querySelector('#typeSlot #chatInput'),
    focused: document.activeElement && document.activeElement.id === 'chatInput',
    panel: !document.getElementById('vWatch').hidden,
    over: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
  }));
  ok(typ.bar && typ.input && typ.focused && !typ.panel && !typ.over, 'Yazma çubuğunda yazı kutusu var, odakta, panel kapalı, taşma yok ' + JSON.stringify(typ));
  if (OUT) await A.ui.screenshot({ path: `${OUT}/yazma-cubugu.png` });
  await A.ui.locator('#chatInput').fill('izlerken yazdım');
  await A.ui.locator('#chatInput').press('Enter');
  ok(await waitFor(() => A.overlays('msg').some((m) => m.name === 'Sen' && m.text === 'izlerken yazdım'), 3000), 'Gönderilen mesaj videonun üstünden aktı');
  const t1 = A.called('setPanel').length;
  await A.ui.evaluate(() => OI.onBack());
  ok(await waitFor(() => A.called('setPanel').slice(t1).includes('closed'), 2000), 'Geri tuşu yazma çubuğunu kapattı (bölümden çıkmadı)');
  await sleep(300);
  ok(await A.ui.evaluate(() => !!document.querySelector('#watchChatSlot .chat #chatInput')), 'Yazı kutusu sohbet paneline geri döndü');

  // Katman düğmeleri sitenin düğmelerine değmez (yatay ve dikey)
  for (const [w, hgt] of [[900, 410], [410, 900]]) {
    await A.player.setViewportSize({ width: w, height: hgt });
    await A.player.goto('https://www.disneyplus.com/play/loki?controls=1');
    await A.player.waitForFunction(() => window.v && v.readyState >= 2, null, { timeout: 10000 });
    const z0 = A.posts.length;
    await A.ui.evaluate((b) => OI.setPlayerBox(b), { w, h: hgt });
    // Bu sayfanın düğme haritası gelsin, sonra seçilen yer
    await waitFor(() => A.posts.slice(z0).some((m) => m.t === 'zones' && m.land === w > hgt), 8000);
    await sleep(300);
    const sp = A.overlays('spots').at(-1);
    if (process.env.DBG) {
      const z = A.posts.filter((m) => m.t === 'zones').at(-1);
      console.log(JSON.stringify(A.overlays('spots')));
      if (z) for (let r = 0; r < z.rows; r++) console.log(z.bits.slice(r * z.cols, (r + 1) * z.cols), z.land);
    }
    const rects = await A.player.evaluate(() => [...document.getElementById('p').shadowRoot.querySelectorAll('#ctl > *')].map((e) => {
      const r = e.getBoundingClientRect();
      return { n: e.getAttribute('aria-label') || e.tagName, l: r.left, t: r.top, r: r.right, b: r.bottom };
    }));
    const hit = (cx, cy, half) => rects.filter((r) => cx + half > r.l && cx - half < r.r && cy + half > r.t && cy - half < r.b).map((r) => r.n);
    if (!sp || !sp.back) {
      ok(false, `${w}x${hgt}: yer seçilmedi ${JSON.stringify(sp)}`);
      continue;
    }
    const bx = sp.back[0] * w, by = sp.back[1] * hgt;
    const cy = sp.chat * hgt, cx = w - 10 - 27;
    const hb = hit(bx, by, 23), hc = hit(cx, cy, 27);
    ok(!hb.length, `${w}x${hgt}: geri düğmesi (${Math.round(bx)},${Math.round(by)}) sitenin düğmelerine değmiyor ${hb.join(',')}`);
    ok(sp.chat !== null && !hc.length, `${w}x${hgt}: sohbet düğmesi (sağ, y=${Math.round(cy)}) sitenin düğmelerine değmiyor ${hc.join(',')}`);
  }
  for (const l of A.log) ok(false, l);
} catch (e) { ok(false, e.stack); } finally { srv.kill(); await browser.close(); await broker.close(); }
console.log(bad ? `BAŞARISIZ (${bad})` : 'Panel yerleşimi ve kaydırma testi geçti ✔');
process.exit(bad ? 1 : 0);
