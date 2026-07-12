# Porting Plan — Design Tokens (with Library Styles as a view)

Status: **Phase 1 shipped** (commit `97fd7a039e`, merged to `develop`). **Phase 2 (tokens) — planned, tokens-only.** Target: `skia-rs-wasm` only. `render-wasm` requires **no changes**.

> **Architecture update — supersedes the original two-systems framing.**
> After validating against Penpot's schemas and the exporter, we collapsed "styles" and
> "tokens" into **one system: tokens.** A *color token* is what we called a paint style; a
> *composite typography token* is what we called a text style. "Styles" survive only as a
> **named / grouped VIEW** (the Assets panel) over color + typography tokens — not a separate
> data type. A token is a strict superset of a style for every style type that exists. The one
> genuine style-only case — multi-paint / effect *stacks* — has no token type and is out of
> scope for v1. Round-trip provenance is a deferred 1-bit concern: no export exists yet.

## 0. Context & principles

`DocumentMeta = Omit<PenpotDocument,'children'>` lives in `docProxy.meta` (Valtio proxy,
`src/lib/renderer/store/doc-proxy.ts`). It is reactive — any panel reads it via `useSnapshot`.

### Three load-bearing facts (validated against the code)

1. **The WASM renderer only ever sees resolved concrete values.** `writeSolidFill(color, opacity)`
   and `writeSpans(...)` take hex strings / numbers, never refs or token names.
   ⇒ **All token resolution happens in the TS layer; render-wasm is untouched.**
2. **A token stores only its *name* on the shape** (`appliedTokens: { fill: "color.brand.primary" }`),
   resolved through active sets + aliasing into concrete values that get written into the normal
   shape props on every token change / theme switch. ⇒ tokens need a resolver + a propagation pass.
3. **Drift is computable without a separate ref field.** A shape is "in sync" when its concrete prop
   equals the resolved value of its `appliedTokens` entry; "drifted" otherwise (Figma model A —
   edit-while-linked allowed, amber dot). Detach = drop the `appliedTokens` entry, keep the value.

---

## Phase 1 — Library styles (colors + typographies) — ✅ SHIPPED

Committed `97fd7a039e`, merged to `develop`. Delivered colors + typographies end-to-end:

- **`src/lib/library/types.ts`** — `LibraryColor = FillStyle`, `LibraryTypography = TypographyStyle`;
  factories, fill/textStyle conversions, drift helpers (`isFillInSync` / `isStrokeInSync` /
  `isTextStyleInSync`).
- **`src/lib/changes/doc-meta-change.ts`** — `DocMetaChange` union (Add/Mod/Del × Paint/Text style)
  + pure reducers; carried alongside page `Change[]` in one `CommitFrame` for unified undo.
- **`src/lib/library/apply.ts`** — CRUD via the doc-meta arm; apply/detach via `commitNodePartialUpdate`;
  `modify*` folds the sync cascade into the same frame (atomic undo).
- **`src/lib/library/sync.ts`** — `collectPaintStyleSync` / `collectTextStyleSync` per-page fan-out.
- **`src/lib/components/AssetsPanel/`** + applied-style chips (drift dot + detach) in the right rail.
- 48 library tests / 424 total green.

> **These become the substrate for Phase 2.** The doc-meta change arm, the per-page fan-out shape,
> the Assets panel shell, and the chip component all survive. Phase 2 re-points the *storage* (token
> sets instead of `paintStyles`/`textStyles`) and the *applied link* (`appliedTokens` instead of
> inline `*RefId` fields). See §2.6.

---

## Phase 2 — Design tokens (tokens-only)

One source of truth — `docProxy.meta.tokens`. Decisions locked: resolver = **style-dictionary +
@tokens-studio/sd-transforms** (eager-bundled, browser programmatic API, no fs); **modes ship in v1**
with a working theme switcher.

### Data flow

```
                    meta.tokens  (sets / themes / activeThemes)
                          │
      ┌────────────────────┼─────────────────────┐
 token CRUD           theme switch            apply token to shape
 (doc-meta arm)      (SetActiveThemes)     (appliedTokens[attr]=name)
      └────────────────────┴─────────────────────┘
                          ▼
                  resolve()  ── active-set merge + {alias} graph + composite decomposition
                          ▼   Map<name → {value, type, errors}>
                  propagate() ── for each shape's appliedTokens, write resolved
                          ▼        concrete value into the normal prop (per-page ModObjChange)
                  docProxy.pageMap (fillColor, r1, fontSize, … = concrete)
                          ▼
                  render-wasm   ← UNCHANGED
```

### Dependency graph

```
P2.1 token types ──┬──► P2.2 resolver ──┬──► P2.4 apply/detach ──┬──► P2.6 migrate styles→view
                   │                     │                        ├──► P2.8 inline row pickers
                   ├──► P2.3 doc-meta ───┼──► P2.5 propagation ───┘
                   │    token CRUD       │         │
                   │                     └─────────┴──► P2.6 migrate
                   └──► P2.7 Tokens panel (needs 2.3 + 2.4)
   P2.9 tests run alongside every task
```

### 2.1 Token model — `src/lib/tokens/types.ts`

Port the Penpot `TokensLib` shape (reuse exporter `tokens.ts` types where they exist):

```ts
type TokenType =
  | 'color' | 'typography'                                   // the "styles" view
  | 'dimension' | 'spacing' | 'sizing' | 'borderRadius' | 'opacity'  // tokens > styles
// (~12 more — fontFamily/fontWeight/letterSpacing/boxShadow/number/… — DEFERRED)

interface Token { id: string; name: string; type: TokenType; value: string | string[]; description?: string }
interface TokenSet { id: string; name: string; tokens: Record<string, Token> }   // "brand/light"
interface TokenTheme { id: string; name: string; group: string; sets: string[] } // modes = active sets
interface TokensLib { sets: TokenSet[]; themes: TokenTheme[]; activeThemes: string[] }
```

Plus the **attr→token-type table** (which shape props accept which token type: `fill`/`strokeColor` ←
`color`; `r1..r4` ← `borderRadius`/`dimension`; gaps/padding ← `spacing`; `fontSize` ← `dimension`;
text node ← `typography`). Shapes carry `appliedTokens: Partial<Record<attr, tokenName>>` (already
typed in the exporter), keyed by attr → token **name** (never the resolved value).

### 2.2 Resolver — `src/lib/tokens/resolve.ts`

`style-dictionary` v4 + `@tokens-studio/sd-transforms`, **programmatic in-browser** (feed token sets
as an in-memory source object; read the resolved dictionary — no file writes). Responsibilities:

- **Active-set merge** — fold `activeThemes → sets` in order; later set overrides earlier (= modes).
- **Aliasing** — `{color.blue.500}` resolved via SD's reference engine; cycle + missing-ref → errors.
- **Composite decomposition** — typography token → font-* props; (shadow deferred).
- Output: `Map<tokenName, { value, type, errors }>`.

> Browser integration note: SD is Node-oriented. Use the transform/format API directly on an
> in-memory dictionary; do **not** touch `fs`/`platforms` file output. Register sd-transforms once.

### 2.3 Token CRUD — extend `src/lib/changes/doc-meta-change.ts`

New doc-meta variants, same paired-undo arm as Phase 1: `Add/Mod/DelToken`,
`Add/Mod/DelTokenSet`, `Add/Mod/DelTheme`, `SetActiveThemes`. Reducer mutates `meta.tokens`.

### 2.4 Apply / detach token — `src/lib/tokens/apply.ts`

Mirrors Phase 1 `apply.ts`. `applyToken(nodeId, attr, tokenName)`: set `appliedTokens[attr] = name`
**and** write the currently-resolved concrete value into the normal prop via `commitNodePartialUpdate`
(color → fill/stroke, typography → spans, dimension → radius/spacing/fontSize). `detachToken(nodeId,
attr)`: remove the `appliedTokens` entry, keep the concrete value.

### 2.5 Propagation — `src/lib/tokens/propagation.ts`

On `ModToken` / `SetActiveThemes`: re-resolve the graph, scan every shape's `appliedTokens`, write
resolved concrete values into props via batched **per-page `ModObjChange`** — reusing Phase 1
`sync.ts`'s fan-out shape — folded into the **same commit frame** as the CRUD edit so Cmd+Z reverts
the token edit and every shape it touched atomically (exactly as `modifyPaintStyle` does today).

### 2.6 Migrate styles → view (the "Phase 1 isn't wasted" task)

- Convert `meta.paintStyles` / `meta.textStyles` into a default color / typography **token set**.
- Re-point the Assets panel Colors / Typographies tabs to read `meta.tokens` filtered by type.
- Re-point the chips: read `appliedTokens[attr]` instead of inline `*RefId`; drift = concrete ≠
  resolved. Detach = remove the `appliedTokens` entry.
- Retire the inline-ref apply/sync (`fillColorRefId` etc.). The fields stay tolerated in the schema
  (harmless optional JSON) but are no longer authored — revisit only when DTCG export needs the
  provenance bit.

### 2.7 Tokens panel — `src/lib/components/TokensPanel/` (3rd left-rail tab)

Token tree grouped by name-path (`color.brand.primary`); create/edit token (type + value + alias
picker with live-resolved preview + error surfacing); **theme/mode switcher** (toggles
`activeThemes` → triggers propagation); apply-to-selection per attribute. Tab styled like the
existing `Design` / `Assets` pill tabs.

### 2.8 Inline token pickers on right-panel rows

Fill, stroke, radius, and spacing rows get an inline "apply token" affordance — the UX win over
Penpot, which buries styles behind a library dropdown defaulting to "Recent" and never puts them on
the fill row.

### 2.9 Tests

- **Resolver** — aliasing, cycle detection, missing ref, active-set override / mode switch picks the
  right set, composite typography decomposition.
- **Apply / detach** — writes `appliedTokens` + resolved value; detach keeps value, drops entry.
- **Propagation** — only shapes with the edited token update; undo restores token + shapes in one
  frame.
- **Migration** — Phase 1 library tests adapted to token storage; Assets view renders tokens.

---

## Deferred (explicitly out of v1 scope)

DTCG JSON import / export + the round-trip provenance bit; sd-transforms math / color-modifier
fidelity beyond aliasing; the ~12 long-tail token types; multi-paint / effect **stacks**;
cross-file shared libraries.

## Locked decisions

- **D1** One source of truth: **tokens**. Styles are a filtered view; no separate style data type.
- **D2** Unified undo via the doc-meta change arm (carried over from Phase 1).
- **D3** Resolver: **`style-dictionary` + `@tokens-studio/sd-transforms`**, eager-bundled, browser
  programmatic API (no fs). *(Chosen over an in-house resolver to keep DTCG semantics for the
  eventual round-trip.)*
- **D4** Assets + Tokens panels live in the **left rail** alongside Layers (Design / Assets / Tokens
  pill tabs).
- **D5** Modes/themes **ship in v1** (data model + working theme switcher; full theme-management UI
  stays modest).

**Boundary discipline:** every layer stays in `skia-rs-wasm/src/lib`. `render-wasm` and the Penpot
frontend are not touched.
