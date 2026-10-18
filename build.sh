#!/usr/bin/env bash
# Builds store-ready packages for both browsers into ./dist
set -euo pipefail
cd "$(dirname "$0")"
rm -rf build dist && mkdir -p dist
for b in firefox chrome; do
  mkdir -p "build/$b"
  cp -r src/. "build/$b/"
  rm -f "build/$b/icons/icon.svg"
  cp platform/$b/* "build/$b/"
done
v=$(python3 -c "import json;print(json.load(open('platform/firefox/manifest.json'))['version'])")
(cd build/firefox && zip -qr -X "../../dist/fidelio-$v-firefox.xpi" .)
(cd build/chrome  && zip -qr -X "../../dist/fidelio-$v-chrome.zip" .)
ls -la dist
