// Netflix'te video.currentTime'ı doğrudan değiştirmek oynatıcıyı çökertir (M7375 hatası).
// Bu betik sayfanın kendi bağlamında çalışır ve Netflix'in oynatıcı API'si ile sarar.
window.addEventListener('ortak-izle-netflix-seek', (e) => {
  try {
    const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
    const id = vp.getAllPlayerSessionIds().find((s) => s.startsWith('watch')) || vp.getAllPlayerSessionIds()[0];
    vp.getVideoPlayerBySessionId(id).seek(e.detail);
  } catch (err) {
    console.warn('[Ortak İzle] Netflix sarma başarısız', err);
  }
});
