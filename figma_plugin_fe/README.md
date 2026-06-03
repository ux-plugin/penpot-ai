# Figma Plugin (AI Assistant)

## Environment variables

Copy `.env.example` to `.env.development.local` and set as needed:

- **VITE_BACKEND_URL** – Backend base URL for API and RSocket (e.g. `http://localhost:8003`). No trailing slash. If unset, the plugin still loads; backend features will show "Backend not configured".
- **CDN_PORT** – Port for the CDN container when using `cdn:up` (Docker Compose). Must match the port in `VITE_CDN_URL` and `VITE_PLUGIN_UI_URL`. Default 8080 if unset.
- **VITE_CDN_URL** – Base URL for WASM and worker assets when serving them from a CDN. No trailing slash. If unset, the plugin uses relative paths (may not work in the Figma plugin iframe).
- **VITE_PLUGIN_UI_URL** – When set, the build is for "remote UI": the UI is served from this origin (e.g. nginx). Build writes `dist/redirect.html` and `dist/manifest.json` with `"ui": "redirect.html"`. Use that manifest when installing the plugin so the iframe redirects to this URL (non-null origin; fixes worker load). No trailing slash.
- **VITE_PLUGIN_ID** – Plugin ID for postMessage when using non-null origin. Defaults to `manifest.json` `"id"` when unset.

## Docker CDN (WASM + worker)

- **cdn:up** – Run `docker compose up -d --build` to build and run the CDN container. Compose loads `.env` and uses `CDN_PORT` for the port mapping. Idempotent: no-op if already running.
- **cdn:publish** – Build selected targets and optionally prepare content to `cdn/content/`. Accepts build targets (`wasm`, `skia`, `exporter`, `adapter`, `plugin`) and `--publish` to copy artifacts after building. With no args: build all and prepare content (same as before). Examples:
  - `pnpm run cdn:publish` — build all and prepare content.
  - `pnpm run cdn:publish -- wasm` — build only WASM.
  - `pnpm run cdn:publish -- wasm skia exporter` — build only those three.
  - `pnpm run cdn:publish -- wasm skia plugin --publish` — build those three, then prepare content.
- **cdn:build** – Same as cdn:publish (all + prepare content), then builds the Docker image (no run).

To serve WASM and the worker from a CDN so the plugin can load them in Figma:

1. Build and run the CDN container (one command; skips rebuild if container already exists):
   ```bash
   pnpm -F figma_plugin_fe run cdn:up
   ```
   The CDN listens on `CDN_PORT` from `.env` (default 8080, e.g. `http://localhost:8080`).

2. Build the plugin with the CDN URL:
   ```bash
   VITE_CDN_URL=http://localhost:8080 pnpm -F figma_plugin_fe run build
   ```

3. In production, set **VITE_CDN_URL** to your deployed CDN URL and add that host to the plugin’s `manifest.json` under `networkAccess.allowedDomains` so Figma allows fetching assets from it.

## Remote UI (non-null origin, deploy to nginx)

To run the plugin UI from nginx so the iframe has a real origin (fixes "Script cannot be accessed from origin 'null'" for the worker):

1. **Build for nginx** (build skia-rs-wasm and plugin with remote UI URL). Set **VITE_CDN_URL** to the same URL so the worker and WASM load from the same origin:
   ```bash
   pnpm -F skia-rs-wasm run build
   VITE_PLUGIN_UI_URL=http://localhost:8082 VITE_CDN_URL=http://localhost:8082 pnpm -F figma_plugin_fe run build
   ```
   This produces `dist/index.html`, `dist/redirect.html`, and `dist/manifest.json` (with `"ui": "redirect.html"`).

2. **Publish CDN** (copies plugin UI + WASM + worker into the image):
   ```bash
   pnpm -F figma_plugin_fe run cdn:build
   ```

3. **Run nginx** (e.g. on port 8082):
   ```bash
   docker run -p 8082:8080 figma-plugin-cdn
   ```

4. **Install the plugin in Figma** using the "remote UI" build: the plugin package must include `code.js`, `redirect.html`, and **`dist/manifest.json`** (the generated one with `"ui": "redirect.html"`). When the user opens the plugin, the iframe loads the redirect page, then navigates to `VITE_PLUGIN_UI_URL`, so the UI runs from nginx with a non-null origin and the worker loads correctly. Messages from the UI include `pluginId` per Figma’s non-null origin iframe requirements.

For local dev without nginx, leave **VITE_PLUGIN_UI_URL** unset (null origin; use inlined worker if needed).

## WASM/JS mismatch (invoke_viiiiifffi error)

If you see `LinkError: Import "env" "invoke_viiiiifffi": function import requires a callable`, the WASM binary and JS glue are out of sync (e.g. after changing render-wasm Rust code).

**Fix:** Run the full build so WASM and JS are rebuilt together:

```bash
pnpm -F figma_plugin_fe run cdn:publish
```

With no arguments this runs: render-wasm build (Docker) → skia-rs-wasm → exporter → figma-adapter → plugin → prepare content.

**Then restart the CDN** so it serves the new content:

```bash
pnpm -F figma_plugin_fe run cdn:up   # or: docker compose -f figma_plugin_fe/docker-compose.yml down && ... up
```

In Figma, close and reopen the plugin (or refresh the plugin iframe) to load the new assets.
