#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEST="$SCRIPT_DIR/../public/wasm-vello"

echo "[build:vello] Building render-vello (cdylib)…"
cd "$REPO_ROOT/renderer/2D/webgl-vello"
cargo build --target wasm32-unknown-unknown --release --lib

echo "[build:vello] Publishing to public/wasm-vello/"
mkdir -p "$DEST"
wasm-bindgen --target web --no-typescript --out-dir "$DEST" \
  "$REPO_ROOT/renderer/2D/webgl-vello/target/wasm32-unknown-unknown/release/render_vello.wasm"
mv "$DEST/render_vello.js" "$DEST/render-vello.js"
mv "$DEST/render_vello_bg.wasm" "$DEST/render-vello_bg.wasm"
sed -i '' "s/render_vello_bg\.wasm/render-vello_bg.wasm/g" "$DEST/render-vello.js" 2>/dev/null \
  || sed -i "s/render_vello_bg\.wasm/render-vello_bg.wasm/g" "$DEST/render-vello.js"

echo "[build:vello] Done. Load the app with ?renderer=vello to use it."
ls -lh "$DEST"
