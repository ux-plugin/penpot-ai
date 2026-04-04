# Agent guide for `figma_plugin_fe`

AI-assistant Figma plugin. Provides a React UI (iframe) + Figma plugin main-thread code (widget). Lets designers interact with an AI backend through voice/text, renders a live Penpot canvas via `skia-rs-wasm`, and manages Figma node synchronisation.

## Commands

```bash
npm run dev            # Vite dev server (dev.html), HMR on :5173
npm run build          # Full production build → dist/
npm run build:debug    # Build with inline sourcemaps, no minification
npm run build:watch    # Continuous watch build
npm run bundle:prod    # esbuild: minified widget IIFE → dist/code.js
npm run bundle:debug   # esbuild: unminified widget IIFE with sourcemaps
npm run preview        # Preview built artifacts locally
npm run cdn:publish    # Build + publish WASM/worker assets to CDN
npm run cdn:up         # Spin up local nginx CDN container (docker-compose)
```

## Build system

- **UI** (`vite.config.ts`): Vite 6 + React + Tailwind 4 + `vite-plugin-singlefile` (bundles UI into a single `dist/index.html`). CSS via `lightningcss`; JS via Terser (2 compression passes). Custom plugins: `copy-wasm` (copies WASM from `skia-rs-wasm`), `remote-ui-artifacts`, `bundle-size-logger`.
- **Widget** (main thread): esbuild bundles `src/widget/code.ts` → `dist/code.js` (ES2015 IIFE, minified in prod).
- **TypeScript**: `tsconfig.json` (strict, ES2022, ESNext modules).
- **Environment** (`.env.development.local`):
  ```
  VITE_BACKEND_URL=http://localhost:8003    # Backend API + RSocket
  VITE_CDN_URL=http://localhost:8080        # WASM + worker assets
  VITE_PLUGIN_UI_URL=http://localhost:8082  # Remote UI origin (optional)
  VITE_PLUGIN_ID=1412919504924588284
  VITE_SENTRY_DSN=...
  VITE_ENABLE_BUILD_DEBUG=true
  ```

## Architecture

### Two execution contexts

1. **Plugin UI** (`src/plugin-ui/`) — React app running in Figma's sandboxed iframe.
2. **Widget / main thread** (`src/widget/`) — TypeScript code bundled to `dist/code.js`, runs in the privileged Figma plugin thread with full API access.

Communication between them is message-passing only (`postMessage`) — see `src/shared/messaging/`.

### Platform abstraction (`src/widget/platform/`)

```
IDesignPlatform          ← interface
├── FigmaImplementation  ← wraps Figma Plugin API
├── PenpotImplementation ← upcoming Penpot support
└── DevImplementation    ← mock for dev mode
```

All widget code interacts through this interface; never use `figma.*` APIs directly outside `FigmaImplementation`.

### Message routing (`src/shared/messaging/`)

- `MessageDispatcher` — universal request/response registry.
- `UIMessageDispatcher` (UI side) and `CodeMessageDispatcher` (widget side) register handlers by message type.
- `StoreMessaging` — syncs Zustand store slices across the iframe boundary.
- Message types defined in `src/shared/types/messageTypes.ts`.

## Module layout

| Path | Role |
|------|------|
| `src/index.tsx` | React app entry (mounted by Figma in the UI iframe) |
| `src/plugin-ui/App.tsx` | Main router + auth layout |
| `src/plugin-ui/UIMessageDispatcher.ts` | Message handler registry (UI side) |
| `src/plugin-ui/api/` | Backend comms: HTTP fetch, RSocket client, WebSocket completions, auth |
| `src/plugin-ui/stores/` | Zustand state stores (see below) |
| `src/plugin-ui/components/` | React components (SkiaCanvas, chat, auth, debug) |
| `src/plugin-ui/views/` | Page-level components (`Login.tsx`, `HomePixi.tsx`) |
| `src/plugin-ui/hooks/` | Custom hooks (`useFigmaViewportSync.ts`) |
| `src/plugin-ui/providers/` | Context providers: Router, React Query, Toaster |
| `src/plugin-ui/utils/` | Helpers: style conversions, canvas sync, node loading, Sentry |
| `src/widget/code.ts` | Plugin main-thread entry point |
| `src/widget/CodeMessageDispatcher.ts` | Message handler registry (widget side) |
| `src/widget/platform/` | `IDesignPlatform` + Figma/Penpot/Dev implementations |
| `src/widget/stores/` | Widget-side state (`AuthStateManagementClass`) |
| `src/shared/types/` | `messageTypes.ts`, `authTypes.ts`, `types.ts` (design node types) |
| `src/shared/messaging/` | `MessageDispatcher`, `StoreMessaging` |
| `src/dev/` | Mock Figma API host, mock worker, dev utilities |

## State management

All state lives in **Zustand stores** (`src/plugin-ui/stores/`). No Redux, no Context for data.

| Store | Contents |
|-------|----------|
| `useAuthenticationStore` | Auth tokens, user ID, provider (Figma/GitHub), RSocket lifecycle |
| `useConversationStore` | Chat messages, reasoning text, audio data (base64), streaming state |
| `useUserSettingsStore` | User preferences fetched from backend |
| `usePortUpdatesStore` | WebSocket port for companion app, reconnection state |
| `NodeManager` | Design node cache; create/delete/update; Figma ↔ Penpot node mapping |

Async data fetching uses **TanStack React Query** (configured in `src/plugin-ui/providers/queryClient.tsx`).

Store slices that must stay in sync across the iframe boundary are bridged via `StoreMessaging`.

## Backend communication

| Channel | Library | Purpose |
|---------|---------|---------|
| HTTP | `api-fetcher.ts` | Auth, user config, node operations |
| RSocket | `api/rsocket.ts` | Real-time backend updates, port subscription |
| WebSocket | `api/completions/` | Streaming AI completions (audio + text) |
| Companion | `api/companion/` | Optional companion app connection |

RSocket connection lifecycle is managed inside `useAuthenticationStore` (connect on login, disconnect on logout).

## WASM canvas (`src/plugin-ui/components/SkiaCanvas.tsx`)

Embeds the `skia-rs-wasm` renderer. Syncs pan/zoom with the Figma viewport via `useFigmaViewportSync`. Receives incremental changes from the AI backend (add pages, modify nodes) and applies them through the `skia-rs-wasm` commit pipeline.

## Key technologies

| Category | Libraries |
|----------|-----------|
| UI framework | React 19, React Router 7, React Hook Form |
| State | Zustand 5, TanStack React Query 5 |
| Styling | Tailwind CSS 4, shadcn/ui, Lucide React |
| Build | Vite 6.3, esbuild 0.25, TypeScript 5.5, Terser |
| Real-time | RSocket, WebSockets |
| Rendering | skia-rs-wasm (WASM Penpot renderer) |
| Error tracking | Sentry |
| Security | @noble/ciphers (encryption) |

## Tests

No test suite currently configured in this package. Add Vitest + React Testing Library if tests are needed.
