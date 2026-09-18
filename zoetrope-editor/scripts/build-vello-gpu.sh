#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEST="$SCRIPT_DIR/../public/wasm-vello-gpu"

echo "[build:vello-gpu] Building vello-gpu-renderer (cdylib)…"
cd "$REPO_ROOT/renderer/2D/webgpu-vello"
cargo build --target wasm32-unknown-unknown --release --lib

echo "[build:vello-gpu] Publishing to public/wasm-vello-gpu/"
mkdir -p "$DEST"
wasm-bindgen --target web --no-typescript --out-dir "$DEST" \
  "$REPO_ROOT/renderer/2D/webgpu-vello/target/wasm32-unknown-unknown/release/vello_gpu_renderer.wasm"
mv "$DEST/vello_gpu_renderer.js" "$DEST/render-vello-gpu.js"
mv "$DEST/vello_gpu_renderer_bg.wasm" "$DEST/render-vello-gpu_bg.wasm"
sed -i '' "s/vello_gpu_renderer_bg\.wasm/render-vello-gpu_bg.wasm/g" "$DEST/render-vello-gpu.js" 2>/dev/null \
  || sed -i "s/vello_gpu_renderer_bg\.wasm/render-vello-gpu_bg.wasm/g" "$DEST/render-vello-gpu.js"

date +%s > "$DEST/version.txt"

echo "[build:vello-gpu] Done. Load the app with ?renderer=vello-gpu to use it."
ls -lh "$DEST"
