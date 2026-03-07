#!/usr/bin/env bash
# Builds worker and fills cdn/content/ (no Docker). Run from repo root or figma_plugin_fe.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/cdn-lib.sh"

build_worker
prepare_content
echo "[cdn] Done. Content in $CONTENT_DIR. Run cdn:build to build the Docker image."
