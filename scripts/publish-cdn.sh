#!/usr/bin/env bash
# Builds worker, copies content into cdn/content, and builds the Docker CDN image.
# Run from repo root: pnpm -F figma_plugin_fe run cdn:build
# Or from figma_plugin_fe: ./scripts/publish-cdn.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/cdn-lib.sh"

build_worker
prepare_content
build_docker
echo "[cdn] Done. Run: docker run -p 8080:8080 figma-plugin-cdn"
