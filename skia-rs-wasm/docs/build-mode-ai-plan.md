# Build-mode AI Chat — Implementation Plan

Status: **planned** (not started). Owner: AI-chat / Build-mode track.
Companion: [`build-mode-session-handoff.md`](./build-mode-session-handoff.md) (current code state, slices 1–4a).

This plan supersedes the earlier OpenRouter-BYOK-in-browser approach. It is the
canonical target after the architecture discussion that settled the decisions below.

---

## 1. Core decision

The chat product lives in the **frontend**; the backend is a thin, authenticated
**LLM provider**. The user's own key (BYOK) is only offered on surfaces that have
**real OS-level secret storage** — desktop and terminal — never in a plain browser.

Two things must be true and the design makes both true:
- A **platform** provider key (ours, which we pay for) is **never** exposed to the browser.
- A **user** provider key (BYOK) is only stored where the OS can protect it.

---

## 2. Architecture

### 2.1 Backend = authenticated, OpenAI-compatible LLM provider
- One SSE route in `figma_plugin_api`: `POST /v1/chat/completions` (OpenAI-compatible:
  `model`, `messages[]`, `tools?`, `stream:true`; chunks carry `choices[].delta.content`,
  `tool_calls`, `finish_reason`).
- Normalizes across providers (OpenAI / Anthropic / Gemini) via **LangChain4j** — our
  own "house provider", so the frontend can use a standard client.
- Holds the **platform key server-side** (config). Knows **nothing** about Build-mode IR.
- This facade exists **only for the web/platform path** (see §3).

### 2.2 Frontend = the whole chat product (`skia-rs-wasm`)
- Owns conversation history, system prompt, the **IR tool schema**, prompt-building,
  the **validate → repair loop** (required by the recursive IR), and apply-to-doc.
- Driven by the **Vercel AI SDK**. Same orchestration regardless of which provider it
  talks to — only the provider instance changes (§3).
- Most of this already exists in `ConversationSession` / `ApiSession` / the capability layer.

### 2.3 Decoupled transports (no shared socket)
| Concern | Transport | Notes |
|---|---|---|
| **Chat** | SSE (provider facade) or local IPC (desktop) | one-directional stream; standard provider protocol |
| **Collaborative doc-sync** | its own WebSocket / CRDT stack | stateful, sticky, room-affine — kept separate to scale/fail independently |
| **Audio transcription** (if it returns) | HTTP batch `POST /transcribe`; live captions only → dedicated streaming-STT | a front-stage (voice→text), not a reason to change the chat transport |

Rationale: the original RSocket request-channel existed solely to stream audio **up** from
the **desktop app**. With audio gone (and, if it returns, captured in-process), there is no
bidirectional requirement for chat, so SSE wins. Collab needs a socket, but the LLM stream
is stateless and standard-protocol — coupling them is a scaling/failure-domain mistake.

---

## 3. Per-surface key model (the BYOK split)

BYOK is offered **only where a real secret store exists**. A browser has none (all storage
is JS-readable); desktop and terminal do. This eliminates the browser-secret problem rather
than mitigating it.

| Surface | Real secret store? | Key model | Key storage | Who calls the provider |
|---|---|---|---|---|
| **Web (browser)** | ❌ all JS-readable | **Platform key only** | none (browser holds only our auth token) | our **backend facade** |
| **Desktop (Electron)** | ✅ `safeStorage` (Keychain / DPAPI / libsecret) | **BYOK** | OS-encrypted on disk, in the **main process** | **main process**, directly to provider |
| **Terminal** | ✅ env / local config / file perms | **BYOK** | local env/config | local (existing `claude -p`/terminal path) |

Capability gating: extend `SessionCaps` with `canBYOK` / `keyStore`. The desktop preload
bridge (and terminal backend) set it; the web build does not. BYOK affordances in the UI
are shown only when the capability is present.

### Desktop BYOK design (Electron)
- Store the key with `safeStorage.encryptString` → ciphertext on disk, decryptable only on
  that machine/user via the OS keychain; **never enters renderer JS**.
- The **main process** holds the key and makes the direct provider call (Node — no CORS
  gating); the renderer (`skia-rs-wasm`) sends prompts over **IPC** and receives the stream.
- This is strictly safer than browser BYOK *and* avoids per-provider browser-CORS issues.
- (Tauri equivalent, if any surface is Tauri: `tauri-plugin-stronghold` / keyring.)

### Frontend provider resolution (one seam, all surfaces)
```ts
// chat orchestration is identical; only the provider instance differs
const provider =
  caps.canBYOK && hasUserKey   ? localProvider(/* desktop IPC / terminal */)
                               : openaiCompatible({ baseURL: BACKEND_URL, headers: auth })
streamText({ model: provider(model), messages, tools })   // AI SDK
```

---

## 4. What this design drops (explicitly out of scope)

- **Browser key storage** of any kind (localStorage / IndexedDB / Web-Crypto). The web path
  is platform-only, so there is nothing to store in the browser. Remove the BYOK Settings
  field + `ai-settings-store` from the web build (or gate behind `canBYOK`).
- **Server-side per-user key vault** — AES-GCM at rest, KEK rotation, KMS/Vault, Portkey,
  `llm_provider_keys` table. All moot: BYOK never reaches our backend (it's local), and the
  platform key lives in backend config, not a per-user store.
- **RSocket for chat**, the audio request-channel pipeline, OpenRouter-BYOK-in-browser, and
  any provider key in the browser.

---

## 5. Open decision (gates the platform/web path only)

**First-cut auth for the web SSE endpoint.** The backend already has an **API-key filter
chain** for HTTP (`ApiKeyAuthentication`, `ROLE_API_KEY`) — no login port needed.
- **Recommended first cut:** guard `/v1/chat/completions` with **API-key auth**; the web
  build holds a scoped app key. Caveat: a shared app key is JS-readable and can't meter/
  revoke per user — acceptable internally (it only reaches *our* rate-limited relay, never
  the provider key), but the real answer is per-user **Auth0 JWT** (Phase 3).
- This affects **web users only** — BYOK (desktop/terminal) users never touch the backend.

---

## 6. Phased slices

### Phase 1 — Backend provider facade (`figma_plugin_api`) — platform path
New module `features/llm/` (leave `features/completions/` audio code aside).
- **B1** — SSE route: `LlmController` `POST /v1/chat/completions` → `Flux<ServerSentEvent>`;
  OpenAI-shaped request/response DTOs.
- **B2** — Normalized call: refactor `config/ai/FigmaDesignModelProvider.kt` from singleton
  beans to a per-request factory `streamingModel(provider, apiKey, model)`; `LlmService`
  maps LangChain4j stream callbacks → OpenAI SSE chunks. Platform key from config.
- **B3** — Auth + safety: permit the route under the **API-key chain** in `SecurityConfig`;
  add per-call **rate-limit + token-budget cap** (runaway-loop protection on our key).
- **B4** — Config + errors: `agent.*` provider/model/key; clean SSE error events; `curl -N` test.

**Verify:** `curl -N` streams tokens; bad key → clean error; over-budget → 429.

### Phase 2 — Frontend chat on the AI SDK (`skia-rs-wasm`)
- **F1** — Add `ai` SDK; OpenAI-compatible provider at `VITE_AI_BACKEND_URL` + auth header.
- **F2** — Provider resolver (the §3 seam): `canBYOK && hasUserKey` → local/IPC provider;
  else → backend facade. Rewire `session/api-session.ts` + `nl/ai-cli.ts`; keep prompt-build,
  parse, and the offline `interpret` fallback.
- **F3** — IR tools as AI-SDK tool/structured-output defs; keep the validate→repair loop.
- **F4** — Capability gating: add `SessionCaps.canBYOK`; web build = platform-only (hide BYOK
  UI, drop `ai-settings-store`); remove the `__ai-chat` vite bridge. Stream into `ChatPanel`.
- **F5** — typecheck + lint + `vitest` + verify a real Build interaction.

**Verify:** web build → platform path streams; no provider key in the browser; IR applies.

### Phase 3 — Desktop BYOK (Electron shell)
- **D1** — Preload bridge exposes a `keyStore` + `chat` IPC API; sets `SessionCaps.canBYOK`.
- **D2** — Main process: `safeStorage`-backed key persistence (save/load/clear); BYOK Settings
  UI wired to it (key never in renderer JS).
- **D3** — Main process makes the direct provider call (AI SDK/provider SDK in Node);
  renderer streams via IPC. Provider resolver (F2) routes to the IPC provider when `canBYOK`.
- **D4** — verify on desktop: enter key once → persists across restarts via OS keychain →
  chat routes BYOK→provider directly; web build unaffected.

### Phase 4 — Deferred (pull in when needed)
- Per-user **Auth0 JWT** for the platform path (per-user metering/revocation) — replaces the
  first-cut shared API-key.
- Server-side richness behind the same API (conversation persistence, guardrails, per-
  conversation budgets) — only if the web/platform path needs it.
- **Voice:** batch `POST /transcribe` (record→upload→text) → text into the same chat; live
  captions only via a dedicated streaming-STT subsystem.
- **Shared orchestration package** if the Figma plugin frontend also needs the chat brain
  (avoids drift between clients).

---

## 7. Rough effort
- Phases 1–2 (web/platform path working, keys server-side): **~2–3 days**.
- Phase 3 (desktop BYOK via `safeStorage` + main-process call): **~1–2 days**.
- Phase 4 items: independent; scheduled when their need arrives.

---

## 8. Detailed design (researched against the code)

Two refinements from reading both codebases, which **simplify the first cut**:

- **First cut needs NO provider tool-calling.** The frontend already encodes the IR as a
  `{reply, ir}` JSON envelope (`nl/ai-cli.ts` `buildPrompt`/`parseResult`). Keep it. The
  backend is a **plain text relay** (messages in → token stream out); the AI SDK accumulates
  the stream and `parseResult` extracts the envelope. Provider-native tool-calls /
  structured-output move to **P4**.
- **Backend uses the LOW-LEVEL `StreamingChatModel`, not the `@AiService`.** Because the
  prompt+contract live in the frontend, the relay must NOT bake a system prompt. Inject the
  existing `figmaDesignStreamingChatModel` bean and call
  `StreamingChatModel.chat(ChatRequest, StreamingChatResponseHandler)` (LangChain4j 1.9.1) —
  do **not** reuse `FigmaDesignAssistant` (it templates `@SystemMessage`/`@UserMessage`).

### 8.1 Backend (`figma_plugin_api`) — file-level

New module `api/src/main/kotlin/com/plugin/api/features/llm/`:

- **`LlmDTO.kt`** — OpenAI-shaped request: `ChatCompletionRequest(model, messages: List<ChatMessage{role,content}>, stream=true, temperature?, maxTokens?)`. Response chunks are emitted as raw OpenAI SSE JSON strings (`{choices:[{delta:{content}}]}` … then `[DONE]`) so any OpenAI-compatible client (the AI SDK) works unchanged.
- **`LlmController.kt`** — `@RestController @RequestMapping("/api/llm")`. Route:
  `@PostMapping("/v1/chat/completions", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])`
  returning **`Flux<ServerSentEvent<String>>`** (a streaming `Flux` return, *not* a `suspend`
  fun — that's the SSE shape this codebase lacks today). Map client `messages[]` →
  `dev.langchain4j.data.message.ChatMessage` list.
- **`LlmService.kt`** — injects `@Qualifier("figmaDesignStreamingChatModel") StreamingChatModel`.
  Builds `ChatRequest.builder().messages(...).build()`, bridges the streaming handler
  (`onPartialResponse`/`onCompleteResponse`/`onError`) into a `Sinks.many().unicast()` →
  `Flux`, emitting each token as an OpenAI delta chunk. Mirror the `callbackFlow` bridge in
  `CompletionsRSocketController.kt`. Platform key/model from existing `agent.figma-design.*`.
- **Auth** — in `config/SecurityConfig.kt` (the `authorizeExchange` block ~L51–70) add
  `.pathMatchers("/api/llm/**").hasAuthority("ROLE_API_KEY")`. Web client sends
  `Authorization: Bearer pk_live_…`. The resolved `ApiKeyAuthentication` carries `orgId`/
  `userId` → enables per-org metering.
- **Budget/limit** — wrap the stream with a max-output-token cap + a simple per-key rate
  limit (Redis is already wired for the api-key cache) so a runaway client loop can't burn
  the platform key.
- **CORS** — `config/WebConfig.kt` already maps `/**` with `*` origins; confirm `Authorization`
  is in allowed headers for the cross-origin (`:5173` → `:8003`) dev call.
- **Config** — no new properties required for the platform first cut (reuse
  `agent.figma-design.*` in `api/src/main/resources/application.yaml`). Optional `agent.llm.*`
  later if the relay wants its own model default.

**Verify:** `curl -N -H "Authorization: Bearer pk_test_…" -d '{...}' …/api/llm/v1/chat/completions`
streams `data:` chunks then `[DONE]`; missing/invalid key → 401; over-budget → 429.

### 8.2 Frontend (`skia-rs-wasm`) — file-level

- **Deps** — add `ai` + `@ai-sdk/openai-compatible` to `package.json`. Env
  `VITE_AI_BACKEND_URL` (e.g. `http://localhost:8003/api/llm/v1`) + `VITE_AI_BACKEND_KEY`
  (the `pk_*` web key) read via `import.meta.env`.
- **`interactions/session/types.ts`** — add `canBYOK: boolean` to `SessionCaps`.
- **`interactions/session/api-session.ts`** — set `API_CAPS.canBYOK = false` (web/platform);
  flip `streaming` to `true` if we surface incremental text. The `try/catch` seam (L53–64,
  `aiChat` → `interpret` fallback) is unchanged.
- **`interactions/nl/ai-cli.ts`** — replace the two transports (BYOK OpenRouter fetch L115–131
  and `/__ai-chat` bridge L136–157) with **one** AI-SDK call: a provider resolver
  `caps.canBYOK && hasUserKey ? localProvider : openaiCompatible({ baseURL: VITE_AI_BACKEND_URL, apiKey: VITE_AI_BACKEND_KEY })`, then `streamText({ model, messages:[{role:'user',content: buildPrompt(ctx)}] })`, accumulate `textStream`, pass the full text to the **unchanged** `parseResult`. `buildPrompt`/`parseResult`/`looksLikeIR` stay as-is.
- **Settings / store** — `store/ai-settings-store.ts` + the "AI (Build mode)" section in
  `components/Settings/SettingsDialog.tsx` (L187–225) become **gated behind `canBYOK`**
  (hidden on web). Not deleted — they're the BYOK path reused by the desktop shell (P3).
- **`vite.config.ts`** — the `aiChatPlugin()` `/__ai-chat` bridge (L51–171, registered L230)
  can stay for offline dev or be removed once the backend route works.

**Verify:** web build → typed Build prompt streams from `/api/llm/...` → `parseResult` yields
`{reply, ir}` → IR applies; no provider key anywhere in the browser; `vitest` green.

### 8.3 Desktop BYOK (P3) — file-level (deferred)
- Electron preload `contextBridge` exposes `window.zoetrope.keyStore` (save/load/clear via
  `safeStorage`) and `window.zoetrope.chat` (IPC streaming); sets a runtime flag the renderer
  reads to set `SessionCaps.canBYOK = true`.
- Main process holds the key (`safeStorage.encryptString` on disk) and runs the provider call
  (AI SDK in Node — no CORS); renderer's provider resolver routes to the IPC provider.
- The BYOK Settings UI (gated by `canBYOK`) writes to the keyStore IPC, never to renderer JS.

### 8.4 Gotchas captured from the research
- SSE is **new** to this backend — return a `Flux<ServerSentEvent>` (streaming), not a
  `suspend … ResponseEntity`. Don't try to make it a coroutine handler.
- `TokenStream` is callback-based (not Flux/Flow) — bridge via `Sinks`/`Flux.create`.
- API-key filter returns empty (falls through to JWT) when the token lacks the `pk_` prefix —
  fine; just ensure the web key uses the configured prefix.
- The IR `looksLikeIR` guard is shallow (shape only); deep validation/repair is still a P4
  item — first cut relies on the prompt contract + downstream compile-time expr parsing.
