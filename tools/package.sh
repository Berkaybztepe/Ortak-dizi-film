#!/usr/bin/env bash
# Dağıtım dosyalarını üretir: dist/OrtakIzle.apk ve dist/OrtakIzle-eklenti.zip
set -euo pipefail
cd "$(dirname "$0")/.."
node tools/sync-shared.mjs
(cd android && ./gradlew --no-daemon -q :app:assembleRelease)
mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk dist/OrtakIzle.apk
rm -f dist/OrtakIzle-eklenti.zip
(cd extension && zip -qr ../dist/OrtakIzle-eklenti.zip . -x '.*')
ls -la dist
