// Emülatör testi için sahte dizi sitesi: http://<bilgisayar>:8900/play/loki (emülatörden 10.0.2.2:8900)
//   node tests/fake-site.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';
import { testVideo } from './helpers.mjs';

// Güncelleme testi: UPDATE_DIR=klasör ise /guncelleme/... altında o klasördeki dosyalar sunulur
const UPDATE_DIR = process.env.UPDATE_DIR || '';

const VIDEO = testVideo(720); // 12 dk
const page = (t) => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Watch ${t} | Test</title></head>
<body style="margin:0;background:#000"><test-player id="p"></test-player><script>
const sr = document.getElementById('p').attachShadow({mode:'open'});
sr.innerHTML = '<video id="v" src="/media/v.webm" muted playsinline style="width:100vw;height:100vh"></video>';
window.v = sr.getElementById('v');
window.tap = () => dispatchEvent(new PointerEvent('pointerdown'));
</script></body></html>`;

http
  .createServer((req, res) => {
    if (UPDATE_DIR && req.url.startsWith('/guncelleme/')) {
      const f = path.join(UPDATE_DIR, path.normalize(req.url.split('?')[0].slice('/guncelleme/'.length)));
      if (!f.startsWith(UPDATE_DIR) || !fs.existsSync(f)) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': f.endsWith('.json') ? 'application/json' : 'application/vnd.android.package-archive' });
      return res.end(fs.readFileSync(f));
    }
    if (req.url.startsWith('/media/')) {
      const r = req.headers.range;
      if (r) {
        const [s, e] = r.replace('bytes=', '').split('-');
        const start = +s;
        const end = e ? +e : VIDEO.length - 1;
        res.writeHead(206, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${VIDEO.length}`, 'content-length': end - start + 1 });
        return res.end(VIDEO.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': VIDEO.length });
      return res.end(VIDEO);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(req.url.includes('loki') ? 'Loki' : 'Ana sayfa'));
  })
  .listen(8900, '0.0.0.0', () => console.log('Sahte site: http://127.0.0.1:8900/play/loki'));
