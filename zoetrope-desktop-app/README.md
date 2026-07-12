# zoetrope-desktop-app

Electron desktop shell for Zoetrope.

Electron was chosen over Tauri for **engine consistency**: it ships its own Chromium, so
the Skia GL / WebGL2 / WASM renderer (`skia-rs-wasm` → `render-wasm`) behaves identically
on every machine — dev == prod — instead of running on three different OS webviews
(WKWebView / WebView2 / WebKitGTK).

## Architecture: thin shell

The desktop app is a **thin shell**. It does not re-bundle the renderer — it loads
`skia-rs-wasm`'s own Vite app, which already owns a bespoke build (Tailwind, an ES web
worker bundled via `?worker`, and WASM served from `public/wasm/`). Re-implementing that
inside electron-vite would be brittle.

- **Dev:** the window loads `skia-rs-wasm`'s dev server (`http://localhost:5173`) — full
  app, HMR, WASM, worker, and fonts all work as-is.
- **Prod (offline):** `skia-rs-wasm`'s `build:app` target produces a static bundle
  (`dist-app`); the desktop `build` copies it into `out/renderer` and serves it over the
  `app://` protocol. Bundled locally = launches offline, no CDN dependency for the
  app/WASM. (See _Next slices_ for the remaining offline-fonts gap.)

The main process (`app://` protocol, GPU + security setup) and preload (`window.desktop`)
are the durable shell; only what the window loads changes between dev and prod.

## Run (dev)

```bash
pnpm install                                   # from the repo root (pnpm workspace)
pnpm --filter zoetrope-desktop-app dev         # starts skia-rs-wasm dev + Electron
```

`dev` runs `skia-rs-wasm`'s dev server and the Electron shell together (via
`concurrently`); the window retries the load until the dev server answers. To run only
the shell against an already-running dev server, use `dev:shell`. Point at a different
dev server with `ZOETROPE_APP_URL`.

> The app needs the WASM glue in `skia-rs-wasm/public/wasm`. Produce it once with
> `pnpm --filter skia-rs-wasm build:wasm` (a Docker `render-wasm` build) — without it the
> dev server and the app build both fail to resolve `render-wasm.js`.

## Build / package (offline bundle)

```bash
pnpm --filter skia-rs-wasm build:wasm              # one-time: WASM glue (Docker)
pnpm --filter zoetrope-desktop-app build           # skia app + shell, bundled into out/
pnpm --filter zoetrope-desktop-app package:mac      # or package:win / package:linux
```

`build` runs `skia-rs-wasm build:app` → static `dist-app`, builds the Electron
main/preload, then `scripts/bundle-renderer.mjs` copies the app into `out/renderer` for
`app://`.

## Layout

```
src/main/index.ts          Main process: app:// protocol, window, GPU + security, load target
src/preload/index.ts       contextBridge — exposes a minimal sandboxed `window.desktop`
src/renderer/              Boot-diagnostics splash (placeholder; overwritten by skia's app at build)
scripts/bundle-renderer.mjs  Copies skia-rs-wasm/dist-app -> out/renderer
electron.vite.config.ts    Build config for main / preload / renderer
electron-builder.yml       Packaging config (asarUnpack **/*.wasm)
```

## How the shell maps to the skia-rs-wasm integration landmines

1. **Custom protocol, not `file://`** — `src/main/index.ts` registers a privileged
   `app://` scheme that serves with correct MIME types (`application/wasm`, query strings
   stripped) and a CSP allowing `wasm-unsafe-eval` + blob workers. This is the prod path;
   in dev the window leans on skia-rs-wasm's own dev server.
2. **GPU** — `ignore-gpu-blocklist` is set and the splash requests
   `powerPreference: 'high-performance'` and prints the unmasked GL renderer to catch a
   SwiftShader software fallback.
3. **Security** — `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`;
   external links open in the OS browser.
4. **Packaging** — `asarUnpack: **/*.wasm` keeps the wasm payload streamable.

## Next slices

- **Offline fonts:** the app fetches fonts from `VITE_FONT_BACKEND_URL` / Google's CDN at
  runtime, so true offline needs a local font strategy (bundle or cache-on-first-use).
- `electron-updater` for differential app/shell updates, once a release/signing target
  exists.
- Add a `webglcontextrestored` recovery path (a GPU-process crash otherwise blanks the
  canvas permanently).
- App icon under `build/`, pnpm + electron-builder hoisting (`node-linker=hoisted`),
  code signing / notarization.

> Note: dependency version ranges in `package.json` (electron / electron-vite / vite) are
> set to recent stable releases — confirm them on first `pnpm install`.
