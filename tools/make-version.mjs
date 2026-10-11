// dist/version.json'u üretir: uygulama içi güncelleme bu dosyaya bakar.
//   node tools/make-version.mjs "Bu sürümde neler var"
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle.kts'), 'utf8');
const versionCode = +(gradle.match(/versionCode\s*=.*?(\d+)\s*$/m) || [])[1];
const versionName = (gradle.match(/versionName\s*=\s*"([^"]+)"/) || [])[1];
const apk = path.join(ROOT, 'dist/OrtakIzle.apk');
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
const notes = process.argv[2] || '';
const out = { versionCode, versionName, apk: 'dist/OrtakIzle.apk', sha256, notes };
fs.writeFileSync(path.join(ROOT, 'dist/version.json'), JSON.stringify(out, null, 2) + '\n');
console.log('dist/version.json:', out);
