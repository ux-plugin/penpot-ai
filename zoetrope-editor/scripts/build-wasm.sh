#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "[build:wasm] Building render-wasm (WASM + JS glue) via Docker..."
if ! docker run --rm \
  -e NODE_ENV=production \
  -e CI=true \
  -v "$REPO_ROOT:/home/penpot/penpot:z" \
  -w /home/penpot/penpot/render-wasm \
  penpotapp/devenv:latest \
  sudo -EH -u penpot ./build; then
  echo "[build:wasm] ERROR: render-wasm Docker build failed." >&2
  echo "[build:wasm] Run: docker pull penpotapp/devenv:latest" >&2
  exit 1
fi
# Cache-bust: the Docker build hard-codes `render-wasm.wasm?version=develop`, a
# STATIC query, so browsers keep serving a stale .wasm across rebuilds. Rewrite it
# to a unique value each build so a normal reload always fetches the fresh wasm.
VERSION="$(date +%s)"
bust() {
  local js="$1"
  [ -f "$js" ] || return 0
  sed -i '' "s/render-wasm\.wasm?version=[A-Za-z0-9]*/render-wasm.wasm?version=$VERSION/g" "$js" 2>/dev/null \
    || sed -i "s/render-wasm\.wasm?version=[A-Za-z0-9]*/render-wasm.wasm?version=$VERSION/g" "$js"
}
bust "$SCRIPT_DIR/../public/wasm/render-wasm.js"
echo "[build:wasm] Cache-busted wasm URL → ?version=$VERSION"

# Keep the production-build output (`dist/wasm`, served by `vite preview`) in sync
# so preview never serves a stale pre-built wasm. `vite build` snapshots public/,
# but a wasm-only rebuild doesn't re-run it — copy + cache-bust here too.
DIST="$SCRIPT_DIR/../dist/wasm"
if [ -d "$DIST" ]; then
  cp "$SCRIPT_DIR/../public/wasm/render-wasm.wasm" "$DIST/render-wasm.wasm"
  cp "$SCRIPT_DIR/../public/wasm/render-wasm.js" "$DIST/render-wasm.js"
  bust "$DIST/render-wasm.js"
  echo "[build:wasm] Synced dist/wasm (preview) → ?version=$VERSION"
fi
echo "[build:wasm] Done. Artifacts in public/wasm/"
