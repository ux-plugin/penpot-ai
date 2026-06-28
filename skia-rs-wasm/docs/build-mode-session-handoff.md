# Build Mode — ConversationSession unification (agent handoff)

A brief for the next agent. Goal: host **one chat interface backed by two engines** —
a user-driven terminal (the user's Claude subscription) and an app-directed API chat
(your Anthropic API key) — behind a single `ConversationSession` port, plus a shared
capability layer and (eventually) an MCP server so a terminal-run `claude` can see and
act on the canvas.

Branch: `worktree-interactions-phase-0`. Package: `skia-rs-wasm/`.

---

## 0. READ FIRST — the hard constraint (Anthropic ToS, Feb 2026)

Do **not** build anything that routes the user's (or other users') Claude **subscription**
through the app to power a product feature. Per Anthropic's Claude Code "Legal and
compliance → Authentication and credential use": OAuth/subscription auth (Free/Pro/Max)
is only for ordinary use of native Anthropic apps; **products must use API-key auth**;
Anthropic does not permit third parties to "route requests through Free, Pro, or Max plan
credentials on behalf of their users." Also, programmatic `claude -p` is metered as
**Agent SDK credits at API rates**, not the cheap interactive pool — so there's no cost
win either.

The dividing line is **agency — who composes/directs the request:**

- **User types / the user hits submit** → user-driven → the terminal on their own
  subscription is fine (ordinary use).
- **The app generates the request to deliver a feature** → app-directed → must use an
  **API key** (your platform key or the user's BYOK), via the Messages API / Agent SDK.

Consequences baked into the design:
- `ApiSession` (API key) is the **shipped product engine**.
- `TerminalSession` is **user-driven and LOCAL/desktop only** — the PTY must run on the
  user's own machine with their own login. A hosted browser app gets API only.
- The terminal Claude perceives/acts via an **MCP server** (the model *pulls* context and
  calls tools — sanctioned), **never** by the app injecting prompts into stdin.
- "Attach canvas context to a message" is fine because the **user** composes + submits it
  (like @-mention / drag-drop), not the app auto-injecting per turn.

See also the repo owner's memory note `project_ai_bridge_auth_constraint`.

---

## 1. Architecture (the seam)

```
ChatPanel ─▶ ConversationSession (port) ─▶ ApiSession ──▶ /__ai-chat bridge ──▶ claude -p
                     │                       (caps: structuredOutput, history)
                     └─(later)──────────────▶ TerminalSession ──▶ node-pty + xterm
                                              (user-driven, subscription, local only)
Capability layer (over docProxy) ── read getNodes/getSelection/getInteractions
                                  └ write commitInteractions  ── reused by ApiSession-context
                                                                 gathering AND the future MCP server
```

- One `ConversationSession` port; the UI knows only it. `SessionCaps` gates affordances so
  one panel serves both backends without branching on type.
- The capability layer is the single read/write surface over the live document. Both the
  API context-gathering (today) and the MCP server (slice 6) use it.
- The existing `aiChatPlugin` in `vite.config.ts` (POST `/__ai-chat` → spawns `claude -p`)
  is a **dev-only** transport for `ApiSession`. The real shipped backend is the Agent
  SDK / Messages API with an API key (not yet built).

---

## 2. Build plan (6 slices) and status

| # | Slice | Status | Commit |
|---|-------|--------|--------|
| 1 | `ConversationSession` port + `SessionCaps` | ✅ done | `b67a569623` |
| 2 | `ApiSession` (refactor existing bridge) + status chip | ✅ done | `b67a569623` |
| 3 | Capability layer over docProxy | ✅ done | `b67a569623` |
| 4a | Compose box — selection chip | ✅ done | `a268c69714` |
| 4b | Compose box — snapshot/drawing chip | ⏭ NEXT (blocked, see §5) | — |
| 5 | PTY + WebSocket + xterm `TerminalSession` | ⬜ pending | — |
| 6 | MCP server over the capability layer | ⬜ pending | — |

---

## 3. Key files

- `src/lib/renderer/interactions/session/types.ts` — `ConversationSession`, `SessionCaps`,
  `Turn`, `SendInput` (`{ text, nodes?, selection?, ir? }`), `SendResult`
  (`{ reply, ir?, offline? }`), `Backend = 'api' | 'terminal'`.
- `src/lib/renderer/interactions/session/api-session.ts` — `ApiSession` owns history; `send()`
  tries `aiChat` (live), falls back to `interpret` (offline → `offline: true`). Caps:
  `structuredOutput: true, streaming: false`.
- `src/lib/renderer/interactions/capabilities/index.ts` — `getNodes`, `getSelection`,
  `getInteractions`, `getActivePageId` (IMPERATIVE valtio reads — call from event handlers,
  NOT render), `commitInteractions`.
- `src/lib/components/BuildMode/ChatPanel.tsx` — the composer. Talks only to the port; renders
  `session.history()` + a `bump` counter; backend/caps status chip; slice-4a selection chip
  (`dismissedKey` keyed to the selection signature; reactive display reads the snapshot).
- `vite.config.ts` — `aiChatPlugin` (`/__ai-chat`, spawns `claude -p` with `cwd: tmpdir()`,
  prompt as positional arg, parses the JSON envelope). Dev-only.
- `src/lib/renderer/interactions/nl/ai-cli.ts` — `aiChat`, `buildPrompt`, `parseResult`.
- `src/lib/renderer/interactions/nl/interpret.ts` — rule-based offline stub (`interpret`).

---

## 4. Repo gotchas (will bite you)

- **Git safety:** never a bare `git stash pop` (unrelated stashes exist, e.g.
  `v8-newscheduler-rework-backup-pre-revert`). The shell cwd resets to the MAIN repo — always
  use `git -C /Users/.../.claude/worktrees/interactions-phase-0 …` absolute paths.
- **Dev server:** `cd skia-rs-wasm && pnpm dev --port 5188`. Run only **one** vite instance per
  worktree — a second one makes the WASM renderer panic (`Aborted(native code called abort())`),
  worst on the text-shape / `setDocument` path. The owner usually runs 5188 themselves.
- **Verification:** you usually can't drive their 5188 with a preview tool, and you must not spin
  a competing server. Verify with: `npx tsc --noEmit` (exit 0), `npx eslint <files>`,
  `curl -s -o /dev/null -w '%{http_code}' http://localhost:5188/<src-path>` (expect 200), and
  `npx vitest run src/lib/renderer/interactions test/lib/renderer`. Then hand the owner a click
  recipe for the visual part.
- **Tests:** the suite has ONE pre-existing failure — `test/lib/renderer/store/commit-pipeline.test.ts`
  (vitest doesn't resolve the `@` alias for `google-fonts.ts`). Unrelated; ignore it. Expect
  `99 passed` in the interactions+renderer subset.
- **React Compiler is on:** do NOT add manual `useMemo`/`useCallback` — use plain consts/state.
- **Code style:** TypeScript, no semicolons, single quotes, 2-space indent, `import type`.
- **Expression DSL uses `==`/`!=`, NOT `===`** (they lower to `===`). `x === 0` fails to parse.
- **Read-tool hook:** a `cbm-code-discovery-gate` hook may block `Read` on code files — just
  retry the same Read once (or use Bash). Use codebase-memory MCP tools for code discovery.
- **Scope:** work only in `render-wasm` + `skia-rs-wasm`. The `skia-rs-wasm` React UI (Build mode)
  IS in scope; the Penpot Clojure frontend is OUT. No new Liquibase changesets.

---

## 5. Immediate next task — slice 4b (snapshot / "drawing")

Attach the canvas drawing to the **first** message (seed once, then rely on history / MCP pulls).
Two things must be resolved IN ORDER before writing feature code:

1. **Probe (blocker): can we read pixels back from the WASM canvas?**
   The renderer draws to a WebGL canvas; `canvas.toDataURL('image/png')` commonly returns blank
   unless the context was created with `preserveDrawingBuffer: true` or the renderer exposes a
   snapshot/export hook. Investigate the render-wasm canvas setup and any existing export API
   FIRST. If readback is blank, the options are: add a small renderer snapshot hook, or defer the
   drawing until the API backend exists. Do not build the chip before confirming capture works.

2. **Decision (ask the owner): how does the image reach the model?**
   `claude -p` is a TEXT bridge — a PNG can't be inlined. Either (a) the bridge writes the PNG to
   a temp file and the prompt references the path so `claude -p` reads it (best-effort, may disturb
   JSON-only output / add tool calls), or (b) wait for the API-key Messages backend (clean image
   blocks). Plumb `SendInput.screenshot?: string` (data-URL) through the port now; pick the
   transmission route with the owner.

Then: add `getScreenshot(pid?)` to the capability layer, a snapshot chip with a thumbnail in the
composer (attach on first message only), and carry `screenshot` through `ApiSession`.

---

## 6. After 4b

- **Slice 5 — `TerminalSession`:** xterm.js front + `node-pty` back (spawns the user's shell; the
  user types `claude`), bridged over a WebSocket attached to the dev server's http server (separate
  path from vite HMR). Caps reflect a real terminal. "Submit a composed message" = bracketed-paste
  to stdin (`\x1b[200~` + msg + `\x1b[201~` then `\r`); image → temp file referenced by path. Keep
  it strictly user-driven (see §0). Adds a native dep (`node-pty`).
- **Slice 6 — MCP server:** expose the capability layer as MCP tools (`get_selection`, `get_nodes`,
  `screenshot`, `commit_interactions`, …) so the terminal `claude` perceives/acts. Topology: the
  MCP server runs in the local backend (dev server / Electron) and RPCs to the browser app over a
  WebSocket. The model PULLS context — never inject prompts into the PTY.

---

## 7. Per-slice "done" checklist

- [ ] `npx tsc --noEmit` exits 0
- [ ] `npx eslint <changed files>` clean
- [ ] `curl` transform of changed modules returns 200 on 5188
- [ ] `npx vitest run src/lib/renderer/interactions test/lib/renderer` → 99 passed (1 known fail)
- [ ] hand the owner a click recipe for anything visual
- [ ] commit with `git -C <worktree-abs-path>`, message `feat(skia-rs-wasm): … (slice N)`,
      trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
