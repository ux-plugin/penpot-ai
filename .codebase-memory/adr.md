# Architecture Decision Record — penpot-ai

## Overview
Fork of Penpot (open-source design tool) extended with AI features and a Figma plugin bridge. Polyglot monorepo: Clojure/ClojureScript (Penpot core), Rust/WASM (render engine), Node (exporter), Java/Kotlin Spring (Figma plugin API), JS/TS (Figma plugin FE + companion app), plus an MCP server for agent integration.

## Top-level components

| Path | Stack | Purpose |
|------|-------|---------|
| `common/` | Clojure (cljc) | Shared geom, schema, types, SVG, paths between backend + frontend |
| `backend/` | Clojure | RPC API, auth, db (postgres), http, storage, worker, migrations, audit logs |
| `frontend/` | ClojureScript | Workspace UI, viewer, dashboard, data layer, worker, `render_wasm` bridge, design system (`ui.ds`), tokens management |
| `render-wasm/` | Rust → WASM | Canvas/Skia render engine. Submodules: `shapes` (paths, modifiers), `render`, `wasm` (text, fills, layouts, paths), `state`, `math` |
| `skia-rs-wasm/` | Rust | Skia bindings packaged for WASM target |
| `exporter/` | Node | Headless rendering service (`handlers`, `renderer`) for export pipelines |
| `figma_plugin_api/` | Java/Kotlin + Gradle (Spring) | Plugin backend — OAuth (GitHub/Figma/Auth0), JDBC + R2DBC postgres |
| `figma_plugin_fe/` | TS/JS | Figma plugin UI (FillEditor, StrokeEditor, RightSidePanel, LayersPanel, EditorShell, etc.) |
| `figma_plugin_companion_app/` | TS/JS | Local companion app exposing `ws://localhost:{port}/companion` |
| `mcp/` | — | MCP server (`/sse`, `/messages`, `/execute`) for AI agent integration |
| `sdk/` | — | Public SDK |
| `docs/` | Markdown | Project docs |

## Key external dependencies
- **Datastores:** PostgreSQL (`penpot-postgres`, also `figma_plugin` DB), Redis/Valkey (`penpot-valkey`)
- **AI:** local AI server `http://localhost:8002`, Fireworks API (`https://api.fireworks.ai`, `https://audio-prod.api.fireworks.ai`), OpenAI-compatible `/v1/chat/completions`
- **OAuth providers:** GitHub, Figma, Auth0
- **Penpot upstream:** forked from `https://github.com/penpot/penpot`; vendored forks of `svgo` and `draft-js` via `codeload.github.com/penpot/...`

## Routes (selected)
- Penpot OAuth/login: `POST /v1/oauth/token`, `GET /v1/me`, `GET /user`
- AI: `POST /v1/chat/completions`
- Figma OAuth bridge: `https://api.figma.com/v1/oauth/token`, callbacks at `/auth/figma/callback`, `/auth/figma/connect/callback`
- GitHub OAuth: `https://github.com/login/oauth/authorize|access_token`, callbacks at `/auth/github/...`
- MCP: `GET /sse`, `POST /messages`, `POST /execute`
- Companion: `ws://localhost:{port}/companion`, `/user/key`, `/user/info`

## Graph stats
- 33,090 nodes / 55,297 edges
- Dominant labels: Variable 15.5k, File 3.7k, Module 3.7k, Function 2.7k, Method 2.3k, Class 545, Interface 696, Type 662, Route 92
- Edge mix: DEFINES 28.7k, CALLS 12.0k, USAGE 4.9k, IMPORTS 1.1k, HTTP_CALLS 45

## Architectural notes / decisions to remember
1. **Render split:** Heavy 2D rendering offloaded to WASM (`render-wasm/`) called from CLJS via `frontend/.../render_wasm/api` + `mem` bridge. Skia bindings come through `skia-rs-wasm/`.
2. **Code sharing via cljc:** `common/` is dual-targeted Clojure/ClojureScript — geom and types must stay platform-neutral.
3. **Two distinct backends:** Penpot's own Clojure backend (RPC, auth, storage) and a separate Spring Boot service `figma_plugin_api/` for the Figma integration. They use different postgres databases (`penpot` vs `figma_plugin`).
4. **AI integration is OpenAI-compatible:** routes follow `/v1/chat/completions` shape, backed by Fireworks + a local AI server on `:8002`. Configurable via `AI_SERVER_URL` / `FIREWORKS_API_BASE_URL` env vars.
5. **MCP server is first-class:** SSE + messages + execute endpoints suggest agent tool-use is wired into the product, not a side experiment.
6. **Active perf work in render-wasm:** Untracked planning docs `render-wasm/docs/per-effect-refactor-v2-plan.md` and `render-wasm/docs/perf-tile-scheduler-refactor.md`; current modified files include `render-wasm/src/render/surfaces.rs` and `render-wasm/src/tile_grid.rs`.
7. **Vendored upstream forks:** `svgo` and `draft-js` are pinned to penpot/* forks via tarball URLs — do not bump to upstream npm releases.

## Open questions for future ADRs
- Boundary contract between MCP server and AI features in frontend/backend.
- Companion app trust model (it speaks plain `ws://` on localhost).
- Migration ownership: who owns schema for `figma_plugin` DB vs the existing `backend/src/app/migrations`.
