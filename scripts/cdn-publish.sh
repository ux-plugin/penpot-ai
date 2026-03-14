#!/usr/bin/env bash
# Builds WASM, skia-rs-wasm, plugin and fills cdn/content/ (no Docker).
# Run from repo root or figma_plugin_fe.
# After changing render-wasm (e.g. adding radial gradient), run this to avoid WASM/JS mismatch.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/cdn-lib.sh"

build_wasm
build_skia_rs_wasm
build_exporter
build_figma_adapter
build_plugin
prepare_content
echo "[cdn] Done. Content in $CONTENT_DIR."
echo "[cdn] To serve: pnpm run cdn:up  (restart if already running to pick up new content)"
