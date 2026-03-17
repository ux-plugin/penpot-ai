# cdn-lib.sh - Shared functions for CDN publish and Docker build.
# Source with: . "$(dirname "$0")/cdn-lib.sh"  (from a script in scripts/)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/.." && pwd)"
SKIA_DIR="$REPO_ROOT/skia-rs-wasm"
CONTENT_DIR="$PLUGIN_DIR/cdn/content"

# Load .env so VITE_* and other vars are used by build_plugin and child processes
if [ -f "$PLUGIN_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$PLUGIN_DIR/.env"
  set +a
fi

# Build render-wasm (Rust + Emscripten) via Docker (penpotapp/devenv has EMSDK).
build_wasm() {
  echo "[cdn] Building render-wasm (WASM + JS glue) via Docker..."
  if ! docker run --rm \
    -e NODE_ENV=production \
    -e CI=true \
    -v "$REPO_ROOT:/home/penpot/penpot:z" \
    -w /home/penpot/penpot/render-wasm \
    penpotapp/devenv:latest \
    sudo -EH -u penpot ./build; then
    echo "[cdn] ERROR: render-wasm Docker build failed." >&2
    echo "[cdn] Run: docker pull penpotapp/devenv:latest" >&2
    return 1
  fi
  echo "[cdn] render-wasm build done"
}


build_skia_rs_wasm() {
  echo "[cdn] Building skia-rs-wasm (library + worker)..."
  (cd "$REPO_ROOT" && pnpm --filter skia-rs-wasm run build)
  echo "[cdn] skia-rs-wasm build done"
}

build_exporter() {
  echo "[cdn] Building penpot-exporter (lib)..."
  (cd "$REPO_ROOT" && pnpm --filter penpot-exporter run build:lib)
  echo "[cdn] penpot-exporter build done"
}

build_figma_adapter() {
  echo "[cdn] Building figma-adapter..."
  (cd "$REPO_ROOT" && pnpm --filter figma-adapter run build)
  echo "[cdn] figma-adapter build done"
}

build_worker() {
  echo "[cdn] Building worker..."
  pnpm --filter skia-rs-wasm run build:worker
}

build_plugin() {
  echo "[cdn] Building plugin UI..."
  local base_url="${VITE_PLUGIN_UI_URL:-http://127.0.0.1:8080}"
  export VITE_PLUGIN_UI_URL="$base_url"
  export VITE_CDN_URL="${VITE_CDN_URL:-$base_url}"
  (cd "$REPO_ROOT" && pnpm --filter figma_plugin_fe run build)
  echo "[cdn] Plugin build done (dist has index.html, redirect.html)"
}

build_plugin_debug() {
  echo "[cdn] Building plugin UI (debug)..."
  local base_url="${VITE_PLUGIN_UI_URL:-http://127.0.0.1:8080}"
  export VITE_PLUGIN_UI_URL="$base_url"
  export VITE_CDN_URL="${VITE_CDN_URL:-$base_url}"
  (cd "$REPO_ROOT" && pnpm --filter figma_plugin_fe run build:debug)
  echo "[cdn] Plugin build done (debug, dist has index.html, redirect.html)"
}

prepare_content() {
  echo "[cdn] Preparing content..."
  mkdir -p "$CONTENT_DIR/wasm"
  local copied_any=0
  if [ -f "$PLUGIN_DIR/dist/index.html" ]; then
    cp "$PLUGIN_DIR/dist/index.html" "$CONTENT_DIR/"
    echo "[cdn] Copied index.html (plugin UI)"
    copied_any=1
  else
    echo "[cdn] WARN: index.html not found (build plugin first)" >&2
  fi
  if [ -f "$PLUGIN_DIR/dist/redirect.html" ]; then
    cp "$PLUGIN_DIR/dist/redirect.html" "$CONTENT_DIR/"
    echo "[cdn] Copied redirect.html"
    copied_any=1
  else
    echo "[cdn] WARN: redirect.html not found (build plugin first)" >&2
  fi
  # WASM artifacts: canonical source is skia-rs-wasm/public/wasm (populated by render-wasm build)
  if [ -f "$SKIA_DIR/public/wasm/render-wasm.js" ] && [ -f "$SKIA_DIR/public/wasm/render-wasm.wasm" ]; then
    cp -r "$SKIA_DIR/public/wasm/"* "$CONTENT_DIR/wasm/"
    echo "[cdn] Copied wasm/ from skia-rs-wasm/public/wasm (render-wasm build output)"
    copied_any=1
  else
    echo "[cdn] WARN: WASM artifacts not found in $SKIA_DIR/public/wasm (run wasm build first)" >&2
  fi
  if [ -f "$SKIA_DIR/dist/worker.js" ]; then
    cp "$SKIA_DIR/dist/worker.js" "$CONTENT_DIR/worker.js"
    echo "[cdn] Copied worker.js"
    copied_any=1
  else
    echo "[cdn] WARN: skia-rs-wasm/dist/worker.js not found (run skia build first)" >&2
  fi
  if [ "$copied_any" -eq 0 ]; then
    echo "[cdn] WARN: No content was copied; build at least wasm+skia or plugin first" >&2
  fi
}

build_docker() {
  echo "[cdn] Building Docker image..."
  docker build -t figma-plugin-cdn -f "$PLUGIN_DIR/cdn/Dockerfile" "$PLUGIN_DIR/cdn"
}
