#!/usr/bin/env bash
# Builds selected targets (wasm, skia, exporter, adapter, plugin) and optionally prepares cdn/content/.
# Run from repo root or figma_plugin_fe.
# Usage:
#   ./scripts/cdn-publish.sh                    # build all, then prepare_content
#   ./scripts/cdn-publish.sh wasm                 # build only wasm
#   ./scripts/cdn-publish.sh wasm skia exporter   # build only those three
#   ./scripts/cdn-publish.sh wasm skia --publish  # build wasm+skia, then prepare_content
#   ./scripts/cdn-publish.sh --publish            # build all, then prepare_content

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/cdn-lib.sh"

VALID_TARGETS="wasm skia exporter adapter plugin"
ALL_TARGETS="wasm skia exporter adapter plugin"

usage() {
  echo "Usage: $0 [TARGET ...] [--publish]"
  echo "  TARGET: one or more of: $VALID_TARGETS"
  echo "  If no TARGET is given, all targets are built."
  echo "  --publish: after building, run prepare_content (copy artifacts to cdn/content/)."
  echo "Examples:"
  echo "  $0                          # build all, then prepare_content"
  echo "  $0 wasm                     # build only wasm"
  echo "  $0 wasm skia exporter        # build only wasm, skia, exporter"
  echo "  $0 wasm skia plugin --publish  # build those three, then prepare_content"
  exit 1
}

DO_PUBLISH=0
TARGETS=()
HAD_ARGS=0

for arg in "$@"; do
  HAD_ARGS=1
  case "$arg" in
    --publish)
      DO_PUBLISH=1
      ;;
    wasm|skia|exporter|adapter|plugin)
      TARGETS+=("$arg")
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "[cdn] Unknown target or flag: $arg" >&2
      usage
      ;;
  esac
done

# No args at all => build all and prepare_content (backward compatible)
if [ "$HAD_ARGS" -eq 0 ]; then
  for t in $ALL_TARGETS; do
    TARGETS+=("$t")
  done
  DO_PUBLISH=1
fi

# Args given but no targets => build all (user may have passed only --publish)
if [ ${#TARGETS[@]} -eq 0 ]; then
  for t in $ALL_TARGETS; do
    TARGETS+=("$t")
  done
fi

# Run selected build steps
for t in "${TARGETS[@]}"; do
  case "$t" in
    wasm)    build_wasm ;;
    skia)    build_skia_rs_wasm ;;
    exporter) build_exporter ;;
    adapter) build_figma_adapter ;;
    plugin)  build_plugin ;;
  esac
done

if [ "$DO_PUBLISH" -eq 1 ]; then
  prepare_content
  echo "[cdn] Done. Content in $CONTENT_DIR."
  echo "[cdn] To serve: pnpm run cdn:up  (restart if already running to pick up new content)"
else
  echo "[cdn] Done. Built: ${TARGETS[*]}."
  echo "[cdn] To prepare content and serve: $0 ${TARGETS[*]} --publish"
fi
