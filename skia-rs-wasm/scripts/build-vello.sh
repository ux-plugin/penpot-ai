#!/usr/bin/env bash
#
# Build the Vello backend and publish it where the app can fetch it.
#
# Separate from `build:wasm` on purpose: the two backends are different targets and different
# toolchains (D2). render-wasm needs emscripten and prebuilt Skia, which is why it goes through
# Docker; render-vello is plain `wasm32-unknown-unknown` plus wasm-bindgen and builds on the
# host in seconds. Exactly one artifact is downloaded at runtime, chosen by `?renderer=vello`.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEST="$SCRIPT_DIR/../public/wasm-vello"

# The **library**, not the bin. `render-vello/dev/build.sh` builds the bin, whose `main()` is a
# mock host: it creates its own full-screen canvas, status overlay and rAF loop. Loaded into a
# real app that hijacks the page — the app's canvas ends up underneath a second one, and the
# only thing on screen is the mock's status line. The cdylib has no `main`, so the app stays in
# control and reaches the module through `create_focus_renderer` and the C ABI.
echo "[build:vello] Building render-vello (cdylib)…"
cd "$REPO_ROOT/render-vello"
cargo build --target wasm32-unknown-unknown --release --lib

echo "[build:vello] Publishing to public/wasm-vello/"
mkdir -p "$DEST"
wasm-bindgen --target web --no-typescript --out-dir "$DEST" \
  "$REPO_ROOT/render-vello/target/wasm32-unknown-unknown/release/render_vello.wasm"
mv "$DEST/render_vello.js" "$DEST/render-vello.js"
mv "$DEST/render_vello_bg.wasm" "$DEST/render-vello_bg.wasm"
# wasm-bindgen writes the wasm filename into the glue; keep them in step after the rename.
sed -i '' "s/render_vello_bg\.wasm/render-vello_bg.wasm/g" "$DEST/render-vello.js" 2>/dev/null \
  || sed -i "s/render_vello_bg\.wasm/render-vello_bg.wasm/g" "$DEST/render-vello.js"

echo "[build:vello] Done. Load the app with ?renderer=vello to use it."
ls -lh "$DEST"
