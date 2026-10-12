// Oda kodu (aracı üzerinden) protokol testi: yerel MQTT aracısı başlatır, odayı kodla açan
// sunucuya (Node ya da Kotlin) sunucu testlerinin tamamını aracı üzerinden çalıştırır.
//   node tests/relay.mjs              -> Node sunucusu
//   KOTLIN_SERVER=android/core/build/install/ortak-izle-sunucu/bin/ortak-izle-sunucu node tests/relay.mjs
import { spawn } from 'child_process';
import path from 'path';
import { ROOT, startBroker, TEST_CODE, sleep } from './helpers.mjs';

const broker = await startBroker(18860, 18861);
const PORT = 8797;
const env = { ...process.env, PORT: String(PORT), ODA_SIFRE: 'gizli', ODA_KODU: TEST_CODE, ASSETS_DIR: path.join(ROOT, 'web') };
const kotlin = process.env.KOTLIN_SERVER;
const host = kotlin
  ? spawn(path.resolve(ROOT, kotlin), [], { env: { ...env, ARACI: broker.tcp } })
  : spawn(process.execPath, [path.join(ROOT, 'server/server.js')], { env: { ...env, ARACI: broker.ws } });
let out = '';
host.stdout.on('data', (d) => (out += d));
host.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 60 && !/Oda kodu hazır/.test(out); i++) await sleep(250);
if (!/Oda kodu hazır/.test(out)) {
  console.error('Sunucu aracıya bağlanamadı:\n' + out);
  process.exit(1);
}

let code = 0;
for (let run = 1; run <= 2; run++) {
  code = await new Promise((resolve) => {
    const t = spawn(process.execPath, ['test.js'], {
      cwd: path.join(ROOT, 'server'),
      env: { ...process.env, TEST_PORT: String(PORT), TEST_RELAY_CODE: 'k7m-4qx', TEST_RELAY_BROKER: broker.ws },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    t.stdout.on('data', (d) => process.stdout.write(String(d).split('\n').filter((l) => !/^\d\d:/.test(l)).join('\n')));
    t.on('exit', resolve);
  });
  if (code) break;
}
host.kill();
await broker.close();
console.log(code ? 'Oda kodu testi BAŞARISIZ' : `Oda kodu testi geçti ✔ (${kotlin ? 'Kotlin' : 'Node'} sunucusu)`);
process.exit(code);
