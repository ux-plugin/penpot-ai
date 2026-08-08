#!/usr/bin/env bash
#
# Build the classic-Vello (WebGPU compute) backend and publish it where the app can fetch it.
#
# Sibling of build-vello.sh (the vello_hybrid backend). Same toolchain — plain
# wasm32-unknown-unknown + wasm-bindgen, builds on the host in seconds — but a different artifact:
# vello-gpu-renderer (classic vello) instead of render-vello (hybrid). The app downloads exactly one,
# chosen by `?renderer=vello-gpu` (classic, WebGPU-only) vs `?renderer=vello` (hybrid).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEST="$SCRIPT_DIR/../public/wasm-vello-gpu"

echo "[build:vello-gpu] Building vello-gpu-renderer (cdylib)…"
cd "$REPO_ROOT/vello-gpu-renderer"
cargo build --target wasm32-unknown-unknown --release --lib

echo "[build:vello-gpu] Publishing to public/wasm-vello-gpu/"
mkdir -p "$DEST"
wasm-bindgen --target web --no-typescript --out-dir "$DEST" \
  "$REPO_ROOT/vello-gpu-renderer/target/wasm32-unknown-unknown/release/vello_gpu_renderer.wasm"
mv "$DEST/vello_gpu_renderer.js" "$DEST/render-vello-gpu.js"
mv "$DEST/vello_gpu_renderer_bg.wasm" "$DEST/render-vello-gpu_bg.wasm"
# wasm-bindgen writes the wasm filename into the glue; keep them in step after the rename.
sed -i '' "s/vello_gpu_renderer_bg\.wasm/render-vello-gpu_bg.wasm/g" "$DEST/render-vello-gpu.js" 2>/dev/null \
  || sed -i "s/vello_gpu_renderer_bg\.wasm/render-vello-gpu_bg.wasm/g" "$DEST/render-vello-gpu.js"

echo "[build:vello-gpu] Done. Load the app with ?renderer=vello-gpu to use it."
ls -lh "$DEST"
