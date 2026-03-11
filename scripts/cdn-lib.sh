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
  if [ -f "$PLUGIN_DIR/dist/index.html" ]; then
    cp "$PLUGIN_DIR/dist/index.html" "$CONTENT_DIR/"
    echo "[cdn] Copied index.html (plugin UI)"
  fi
  if [ -f "$PLUGIN_DIR/dist/redirect.html" ]; then
    cp "$PLUGIN_DIR/dist/redirect.html" "$CONTENT_DIR/"
    echo "[cdn] Copied redirect.html"
  fi
  if [ -d "$PLUGIN_DIR/dist/wasm" ]; then
    cp -r "$PLUGIN_DIR/dist/wasm/"* "$CONTENT_DIR/wasm/"
    echo "[cdn] Copied wasm/ from figma_plugin_fe/dist/wasm"
  elif [ -d "$SKIA_DIR/public/wasm" ]; then
    cp -r "$SKIA_DIR/public/wasm/"* "$CONTENT_DIR/wasm/"
    echo "[cdn] Copied wasm/ from skia-rs-wasm/public/wasm"
  fi
  if [ -f "$SKIA_DIR/dist/worker.js" ]; then
    cp "$SKIA_DIR/dist/worker.js" "$CONTENT_DIR/worker.js"
    echo "[cdn] Copied worker.js"
  else
    echo "[cdn] ERROR: skia-rs-wasm/dist/worker.js not found. Run: pnpm -F skia-rs-wasm run build:worker" >&2
    return 1
  fi
}

build_docker() {
  echo "[cdn] Building Docker image..."
  docker build -t figma-plugin-cdn -f "$PLUGIN_DIR/cdn/Dockerfile" "$PLUGIN_DIR/cdn"
}
