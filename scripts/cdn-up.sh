#!/usr/bin/env bash
# Build Docker and run the CDN container only if not already running (idempotent).
# If container exists but is stopped, start it. Run from repo root or figma_plugin_fe.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/cdn-lib.sh"

CONTAINER_NAME="figma-plugin-cdn"
IMAGE_NAME="figma-plugin-cdn"

if [ -n "$(docker ps -a -q -f "name=^${CONTAINER_NAME}$")" ]; then
  echo "[cdn] Container $CONTAINER_NAME already exists."
  if [ -z "$(docker ps -q -f "name=^${CONTAINER_NAME}$")" ]; then
    echo "[cdn] Starting existing container..."
    docker start "$CONTAINER_NAME"
  fi
  echo "[cdn] CDN available at http://localhost:8080"
  exit 0
fi

echo "[cdn] Creating new container..."
build_plugin
build_worker
prepare_content
build_docker
docker run -d --name "$CONTAINER_NAME" -p 8080:8080 "$IMAGE_NAME"
echo "[cdn] CDN available at http://localhost:8080"
