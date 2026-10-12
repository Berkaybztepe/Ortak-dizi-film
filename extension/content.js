// Ortak İzle — platform sayfasında çalışır: senkron motorunu (shared/engine.js) ve
// sayfa içi paneli (overlay.js) arka plandaki oda bağlantısına bağlar.

(() => {
  if (window.top !== window || window.__ortakIzle) return;
  window.__ortakIzle = true;
  const api = globalThis.browser ?? globalThis.chrome;

  // Sohbete yazarken oynatıcının kısayolları (boşluk = durdur gibi) tetiklenmesin.
  // Sayfanın kendi dinleyicilerinden önce, document_start'ta kaydedilir.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(
      type,
      (e) => {
        const host = document.querySelector('[data-ortak-izle="overlay"]');
        if (host && e.composedPath().includes(host)) e.stopImmediatePropagation();
      },
      true
    );
  }

  // Panel ve sahne için yazı tipleri. FontFace ile ikili veriden yüklemek sayfanın
  // güvenlik politikasına (CSP) takılmaz.
  const FONTS = [
    ['OI Sans', 500, 'plus-jakarta-sans', 'latin'],
    ['OI Sans', 500, 'plus-jakarta-sans', 'latin-ext'],
    ['OI Sans', 600, 'plus-jakarta-sans', 'latin'],
    ['OI Sans', 600, 'plus-jakarta-sans', 'latin-ext'],
    ['OI Sans', 700, 'plus-jakarta-sans', 'latin'],
    ['OI Sans', 700, 'plus-jakarta-sans', 'latin-ext'],
    ['OI Sans', 800, 'plus-jakarta-sans', 'latin'],
    ['OI Sans', 800, 'plus-jakarta-sans', 'latin-ext'],
    ['OI Mono', 600, 'ibm-plex-mono', 'latin'],
  ];
  const RANGES = {
    latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212,U+FEFF,U+FFFD',
    'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+2020,U+20A0-20AB,U+20AD-20C0,U+2C60-2C7F,U+A720-A7FF',
  };
  async function loadFonts() {
    for (const [family, weight, file, subset] of FONTS) {
      try {
        const url = api.runtime.getURL(`shared/fonts/${file}-${subset}-${weight}-normal.woff2`);
        const buf = await (await fetch(url)).arrayBuffer();
        const face = new FontFace(family, buf, { weight: String(weight), unicodeRange: RANGES[subset] });
        await face.load();
        document.fonts.add(face);
      } catch {}
    }
  }

  let port = null;
  let engine = null;
  let overlay = null;

  function post(m) {
    if (m.t === 'engine') return overlay && overlay.engine(m);
    if (m.t === 'notice') return overlay && overlay.toast(m.text);
    if ((m.t === 'sync' || m.t === 'tick') && overlay) {
      overlay.localState({ paused: m.t === 'sync' ? m.action === 'pause' || (m.action === 'seek' && m.paused) : false, time: m.time, at: Date.now(), url: location.href, by: null });
    }
    if (!port) return;
    try {
      port.postMessage(m);
    } catch {}
  }

  function connectPort() {
    try {
      port = api.runtime.connect({ name: 'ortak-izle' });
    } catch {
      return; // eklenti güncellendi ya da kaldırıldı
    }
    port.onMessage.addListener((m) => {
      engine && engine.receive(m);
      overlay && overlay.receive(m);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 1000); // servis çalışanı uyutulduysa yeniden bağlan
    });
    if (engine) port.postMessage({ t: 'hello' });
  }

  function start() {
    connectPort();
    loadFonts();
    engine = OrtakIzleEngine.create({ post, onNotice: (t) => overlay && overlay.toast(t), displayFont: 'OI Sans' });
    overlay = OrtakIzleOverlay.create({
      send: post,
      command: (cmd, arg) => engine.command(cmd, arg),
      sameContent: OrtakIzleEngine.sameContent,
    });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
