// Ortak dosyaları (web/ altındaki asıl kopyalar) eklenti klasörüne kopyalar.
// Eklenti "paketlenmemiş" olarak tek klasörden yüklendiği için kopyalar depoda durur.
//   node tools/sync-shared.mjs          -> kopyala
//   node tools/sync-shared.mjs --check  -> kopyalar güncel mi? (testlerde)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const DEST = path.join(ROOT, 'extension', 'shared');
const FILES = ['room-client.js', 'engine.js'];
const FONT_RE = /^(big-shoulders-display-latin(-ext)?-800|hanken-grotesk-latin(-ext)?-(400|600|700)|ibm-plex-mono-latin-500)-normal\.woff2$/;

const wanted = [
  ...FILES.map((f) => [path.join(WEB, f), path.join(DEST, f)]),
  ...fs
    .readdirSync(path.join(WEB, 'fonts'))
    .filter((f) => FONT_RE.test(f))
    .map((f) => [path.join(WEB, 'fonts', f), path.join(DEST, 'fonts', f)]),
];

const check = process.argv.includes('--check');
let stale = 0;
for (const [src, dst] of wanted) {
  const a = fs.readFileSync(src);
  const same = fs.existsSync(dst) && Buffer.compare(a, fs.readFileSync(dst)) === 0;
  if (same) continue;
  stale++;
  if (check) console.error('Güncel değil:', path.relative(ROOT, dst));
  else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, a);
    console.log('Kopyalandı:', path.relative(ROOT, dst));
  }
}
if (check && stale) {
  console.error('Çalıştır: node tools/sync-shared.mjs');
  process.exit(1);
}
if (!stale) console.log('Ortak dosyalar güncel.');
