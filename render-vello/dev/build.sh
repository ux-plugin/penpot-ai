#!/usr/bin/env bash
#
# Build render-vello to wasm and run wasm-bindgen over it.
#
# This replaces `cargo run_wasm`, which built and served this crate while it was
# a member of the vello workspace. D15 moved the crate out, which orphaned that
# alias (it lives in vello/.cargo/config.toml, so it only resolves inside the
# submodule). Phase 3 needs an explicit wasm-bindgen step for the real build
# pipeline anyway, so this is not throwaway.
#
# The wasm-bindgen CLI version MUST match the resolved `wasm-bindgen` crate
# version in Cargo.lock, or it fails with a schema-mismatch error. Check with:
#   grep -A2 '^name = "wasm-bindgen"' ../Cargo.lock
#
# Usage: dev/build.sh [--debug]

set -euo pipefail

cd "$(dirname "$0")/.."

PROFILE="release"
PROFILE_FLAG="--release"
if [[ "${1:-}" == "--debug" ]]; then
  PROFILE="debug"
  PROFILE_FLAG=""
fi

TARGET="wasm32-unknown-unknown"
OUT="dev/pkg"

echo "==> cargo build ($PROFILE)"
# shellcheck disable=SC2086
cargo build --target "$TARGET" $PROFILE_FLAG --bin render-vello

WASM="target/$TARGET/$PROFILE/render-vello.wasm"
if [[ ! -f "$WASM" ]]; then
  echo "expected artifact not found: $WASM" >&2
  echo "artifacts present:" >&2
  ls -1 "target/$TARGET/$PROFILE/"*.wasm >&2 || true
  exit 1
fi

echo "==> wasm-bindgen -> $OUT"
rm -rf "$OUT"
wasm-bindgen --target web --no-typescript --out-dir "$OUT" "$WASM"

echo "==> done"
ls -lh "$OUT"
