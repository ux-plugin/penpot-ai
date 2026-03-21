#!/usr/bin/env bash
# Builds WASM, skia-rs-wasm, plugin (debug) and fills cdn/content/ (no Docker). Run from repo root or figma_plugin_fe.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/cdn-lib.sh"

build_wasm
verify_wasm_glue
build_skia_rs_wasm
build_exporter
build_plugin_debug
prepare_content
echo "[cdn] Done (debug). Content in $CONTENT_DIR. Run cdn:build to build the Docker image."
