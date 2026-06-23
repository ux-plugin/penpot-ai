# Porting Plan — Library Styles & Design Tokens (Variables)

Status: **plan / not started**. Target: `skia-rs-wasm` only. `render-wasm` requires **no changes**.

## 0. Context & principles

Figma's design-system layer is two distinct systems; Penpot mirrors them, and our codebase
already reserves the schema slots for both (currently empty/dormant):

| Figma term | Penpot term | Our schema slot (already declared) |
|---|---|---|
| **Styles** (paint/text) | Library assets `:colors` / `:typographies` | `DocumentMeta.paintStyles`, `DocumentMeta.textStyles` |
| **Variables** | Design tokens (`tokens-lib`) | `DocumentMeta.tokens?` + shape `appliedTokens` |

`DocumentMeta = Omit<PenpotDocument,'children'>` lives in `docProxy.meta` (Valtio proxy,
`src/lib/renderer/store/doc-proxy.ts:6`). It is reactive — any panel can read it via
`useSnapshot(docProxy)`.

### Three load-bearing facts (validated against the code)

1. **The WASM renderer only ever sees resolved concrete values.** `writeSolidFill(color, opacity)`
   (`src/lib/renderer/api/fills.ts:145`) and `writeSpans(...)` (`src/lib/renderer/api/text.ts:409`)
   take hex strings / numbers, not refs or token names. ⇒ **All style/token resolution happens in
   the TS layer; render-wasm is untouched.**
2. **Styles store a ref + a cached value on the shape** (Penpot model). A fill keeps its concrete
   `fillColor`/`fillOpacity` *and* `fillColorRefId`/`fillColorRefFile`. The renderer reads the
   cached value; the ref is metadata for sync/detach. ⇒ no resolver needed for styles.
3. **Tokens store only the token *name* on the shape** (`appliedTokens: { fill: "color.primary" }`),
   resolved through sets/themes/aliasing into concrete values that get written into the normal
   shape props on every token change. ⇒ tokens need a resolver + a propagation pass.

### Reuse

- Lift the Penpot schema TS types the bundled exporter already defines
  (`packages/penpot-exporter/ui-src/lib/types/shapes/tokens.ts`, `.../utils/fill.ts`,
  `.../shapes/textShape.ts`, `.../types/penpotDocument.ts`) so `.penpot` import/export round-trips.
- Reuse the existing commit path (`commitNodePartialUpdate`) for *applying* a style/token to a
  shape — it's just a fill/content edit that additionally carries ref fields.

---

## Phase 1 — Library styles (colors + typographies)

Smaller, no resolver, slots already exist. Delivers shared colors + text styles.

### 1.1 Data model

Library asset shapes (store on `DocumentMeta`, keyed by uuid). Define in
`src/lib/renderer/types.ts` (or a new `src/lib/common/library-types.ts`):

```ts
export interface ColorStyle {        // ≈ Penpot library-color / Figma paint style
  id: string
  name: string
  path?: string                      // "Brand/Primary" grouping
  color?: string                     // hex; OR
  gradient?: Gradient                // OR
  opacity?: number
  modifiedAt: number
}
export interface TypographyStyle {   // ≈ Penpot typography / Figma text style
  id: string
  name: string
  path?: string
  fontId: string; fontFamily: string; fontVariantId: string
  fontSize: string; fontWeight: string; fontStyle: string
  lineHeight: string; letterSpacing: string; textTransform: string
  modifiedAt: number
}
```

Ref fields added to fills/strokes/text spans. To avoid editing the vendored
`packages/penpot-exporter` types (separate git), define **editor-local extended types** and cast at
the boundary (WASM ignores the extra optional fields):

```ts
export type RefFill = Fill & { fillColorRefId?: string; fillColorRefFile?: string }
export type RefStroke = Stroke & { strokeColorRefId?: string; strokeColorRefFile?: string }
// text spans/paragraphs: typographyRefId?, typographyRefFile?
```

> Decision D1: editor-local extended types vs. editing the vendored exporter package. Recommend
> editor-local — keeps the exporter submodule clean; the fields are optional JSON that survive
> serialization untouched.

### 1.2 Document-level CRUD (the one real gap)

The Change system (`src/lib/changes/`) is **page-scoped** (`ModObjChange { pageId, operations }`).
Library CRUD edits `DocumentMeta`, not a page. Add doc-meta change variants handled with paired
undo so library edits join the unified undo stack:

- New change types: `AddColorStyle | ModColorStyle | DelColorStyle | AddTypographyStyle |
  ModTypographyStyle | DelTypographyStyle` (mirror Penpot's `add-color` / `mod-typography`).
- Handle them in `processChanges` (`src/lib/worker/process-changes`) and in
  `applyChangesLocally` (`src/lib/renderer/store/commit.ts:84`) so they mutate `docProxy.meta`
  instead of `docProxy.pageMap`.
- Add builder helpers in `src/lib/changes/changes-builder.ts` (e.g. `appendDocMetaPair`) producing
  redo/undo pairs.

> Decision D2: unified undo (doc-meta change variants) vs. a separate metadata commit path.
> Recommend unified — one undo stack, consistent with everything else.

### 1.3 Apply / detach (reuses existing commit path)

- **Apply color style → fill**: build `next` fills with the style's concrete `color/opacity/gradient`
  copied in **plus** `fillColorRefId = style.id`, then
  `commitNodePartialUpdate(nodeId, before, { fills: next }, pid)`
  (`src/lib/renderer/properties/commit-node-properties.ts:192`). Same for strokes.
- **Apply typography → text**: patch every span/paragraph with the typography's concrete props +
  `typographyRefId`, via existing `patchContent(...)` + `commitNodePartialUpdate({ content })`
  (`src/lib/components/RightSidePanel/Sections/text-typography.ts`).
- **Detach**: drop the `*RefId/*RefFile` fields, keep the concrete value. Single
  `commitNodePartialUpdate`.

### 1.4 Sync on style edit (fan-out across pages)

When a `ColorStyle`/`TypographyStyle` value changes: scan every page's shapes for fills/strokes/spans
whose `*RefId` matches, rewrite the cached concrete value, emit a batched `ModObjChange` **per page**
(changes are page-scoped). Implement as `syncColorStyle(styleId)` / `syncTypographyStyle(styleId)`
in a new `src/lib/library/sync.ts`, invoked from the ModColorStyle/ModTypographyStyle handler.
Build one `ChangesBuilder` per affected page, commit each.

### 1.5 UI

- **Assets panel** (the library browser): new collapsible "Assets" section in the **left rail**,
  alongside `LayersPanel` (`src/lib/components/LayersPanel/`) — locked (D4). Reads
  `useSnapshot(docProxy).meta.paintStyles/textStyles`. Supports create/rename/group/edit/delete
  (→ the 1.2 change ops) and drag-or-click to apply to selection.
- **Applied-style affordance** in `FillsSection.tsx` / `StrokesSection.tsx` / `TypographySection.tsx`:
  when a fill/stroke/text carries a `*RefId`, show the style name + a detach button + an
  "out of sync" indicator (cached value ≠ library value).
- **"Create style from selection"**: button in the fill/typography editor that lifts the current
  concrete value into a new library asset and immediately applies it (sets the ref).

### 1.6 Round-trip

Populate `paintStyles`/`textStyles` on `.penpot` import; emit on export. The exporter package's
`buildAssets.ts` / `processAssets.ts` already document the shape — mirror it.

### 1.7 Tests

- Unit: apply→detach keeps value; sync rewrites only matching refs; undo/redo of CRUD + apply.
- Visual (existing harness under `test/visual/`): a frame whose rects reference one color style;
  edit the style → all update.

---

## Phase 2 — Design tokens (variables)

Builds on Phase 1's apply/commit/sync plumbing; adds a resolver + themes/modes + aliasing.

### 2.1 Runtime model

Port the Penpot `TokensLib` shape (reuse exporter `tokens.ts` types):

```ts
type TokenType = 'color'|'dimension'|'sizing'|'spacing'|'borderRadius'|'opacity'
  |'fontSize'|'fontFamily'|'fontWeight'|'letterSpacing'|'textCase'|'textDecoration'
  |'typography'|'number'|'boolean'|'rotation'|'strokeWidth'|'string'  // ~20
interface Token { name: string; type: TokenType; value: string|string[]; description?: string }
interface TokenSet { name: string; tokens: Record<string, Token> }   // "brand/colors/light"
interface TokenTheme { id: string; name: string; group: string; sets: string[] } // modes = active sets
interface TokensLib { sets: TokenSet[]; themes: TokenTheme[]; activeThemes: string[] }
```

Store as `docProxy.meta.tokens`. Shapes carry `appliedTokens: Partial<Record<TokenProperty, string>>`
(already typed in the exporter), keyed by attr (`fill`, `strokeColor`, `r1`, `fontSize`, …) → token
*name*.

### 2.2 Apply a token

Set `appliedTokens[attr] = tokenName` on the shape (a `ModObjChange` assign) **and** write the
currently-resolved concrete value into the normal prop — reuse the Phase 1 apply path. Never store
the resolved value in `appliedTokens`.

### 2.3 Resolver

Aliasing (`{color.blue.500}`) + modes (active sets per theme). Two options:

- **Reuse the JS libs Penpot uses**: `style-dictionary` + `@tokens-studio/sd-transforms`. Fastest to
  parity; matches DTCG semantics; handles composite (typography/shadow) decomposition.
- **Minimal in-house resolver**: a dependency graph over the active sets, topological resolve,
  cycle + missing-ref detection. Less surface area, more code to own.

> Decision D3: recommend `style-dictionary` + `sd-transforms` for Phase 2 v1 (parity + DTCG
> round-trip for free); revisit if bundle size matters.

Output: `Map<tokenName, { value, errors }>`. Implement in `src/lib/tokens/resolve.ts`.

### 2.4 Propagation

On any token edit / theme switch: resolve the whole graph, then for every shape scan
`appliedTokens`, map each `(attr → tokenName)` to its resolved value, and write concrete values into
shape props via batched per-page `ModObjChange`s (same fan-out shape as 1.4). Implement
`propagateTokens()` in `src/lib/tokens/propagation.ts`. Renderer path is unchanged.

### 2.5 UI

Tokens panel: token tree (sets → tokens), theme/mode switcher, create/edit token (with type +
value + reference picker), apply-to-selection per attribute. New section near the Assets panel.

### 2.6 Import / export

DTCG JSON (the multi-set + `$themes` + `$metadata` format the exporter already documents). Implement
`importDtcg()` / `exportDtcg()` in `src/lib/tokens/dtcg.ts`.

### 2.7 Tests

- Resolver: aliasing, cycle detection, missing ref, mode switch picks the right set.
- Propagation: token edit updates only shapes with that `appliedToken`; undo restores.
- DTCG round-trip equality.

---

## Cross-cutting decisions

- **D1** ref fields: editor-local extended types *(recommended)* vs. edit vendored exporter package.
- **D2** library CRUD undo: unified doc-meta change variants *(recommended)* vs. separate path.
- **D3** token resolver: `style-dictionary` + `sd-transforms` *(recommended)* vs. in-house. Bundle-size is not a constraint — load eagerly, no dynamic `import()`.
- **D4** assets/tokens panel home: **LOCKED → left rail**, alongside Layers (industry-standard).
- **D5** Phase 1 scope: **LOCKED → colors + typographies together** (full Phase 1, no thin slice).

## Sequencing (locked: full Phase 1, then full Phase 2)

**Phase 1 — library styles (colors + typographies together, D5)**

1. **Types** — `ColorStyle`, `TypographyStyle`; editor-local `RefFill`/`RefStroke` + span `typographyRefId`/`typographyRefFile`. (`src/lib/renderer/types.ts`, new `src/lib/common/library-types.ts`)
2. **DocMeta change ops** — `AddColorStyle | ModColorStyle | DelColorStyle | AddTypographyStyle | ModTypographyStyle | DelTypographyStyle` with paired undo. Handled in `processChanges` + `applyChangesLocally` (`src/lib/renderer/store/commit.ts`); builder helper `appendDocMetaPair` in `src/lib/changes/changes-builder.ts`.
3. **Apply / detach** — reuse `commitNodePartialUpdate`. For fills: write next fills with cached value **+** `fillColorRefId`. For text: `patchContent` + `typographyRefId` on every span/paragraph. Detach = drop the ref fields, keep value.
4. **Sync fan-out** — new `src/lib/library/sync.ts`: `syncColorStyle(id)` / `syncTypographyStyle(id)` scan every page, build one `ChangesBuilder` per affected page, commit each via the existing path.
5. **UI — left rail (D4)** — new `src/lib/components/AssetsPanel/AssetsPanel.tsx` alongside `LayersPanel`. Reads `useSnapshot(docProxy).meta.paintStyles/textStyles`. Sections: Colors, Typographies. Per asset: rename, group (path), edit, delete, drag-to-apply, "create from selection". Wire `EditorShell` to add it under Layers.
6. **Applied-style chips** — in `FillsSection.tsx` / `StrokesSection.tsx` / `TypographySection.tsx`: when a fill/stroke/span carries a `*RefId`, render the style name + detach icon + out-of-sync indicator (cached ≠ library).
7. **Round-trip** — populate `paintStyles`/`textStyles` on `.penpot` import; emit on export. Mirror the exporter package's `buildAssets.ts`/`processAssets.ts` shapes.
8. **Tests** — unit (apply / detach / sync / undo); visual (one frame referencing one color style, edit propagates).

**Phase 2 — design tokens (variables)**

9. **Model** — port `TokensLib` (sets, themes, activeThemes) + `appliedTokens` map onto `docProxy.meta.tokens`. (`src/lib/common/tokens-types.ts`)
10. **CRUD change ops** — `AddTokenSet | ModTokenSet | DelTokenSet | AddToken | ModToken | DelToken | AddTheme | ModTheme | DelTheme | SetActiveThemes`, same paired-undo pattern as Phase 1.2.
11. **Resolver** — `src/lib/tokens/resolve.ts` using `style-dictionary` + `@tokens-studio/sd-transforms` (D3). Output: `Map<tokenName, { value, errors }>`. Handles aliasing, modes (= active sets), composite types (typography, shadow), cycle / missing-ref detection.
12. **Apply token** — set `appliedTokens[attr] = tokenName` **and** write current resolved value into the normal prop via the Phase 1 apply path.
13. **Propagation** — `src/lib/tokens/propagation.ts`: on token edit / theme switch → resolve full graph → for each shape's `appliedTokens` → write concrete values via batched per-page `ModObjChange`s.
14. **UI — left rail (D4)** — new `src/lib/components/TokensPanel/TokensPanel.tsx` next to `AssetsPanel`: token tree (set → token), theme/mode switcher, create/edit (type + value + ref picker), apply-to-selection per attribute.
15. **DTCG round-trip** — `src/lib/tokens/dtcg.ts`: import / export multi-set + `$themes` + `$metadata`.
16. **Tests** — resolver (aliasing, cycles, missing, mode switch); propagation (only matching `appliedTokens` updated; undo restores); DTCG round-trip equality.

**Boundary discipline:** every layer above stays in `skia-rs-wasm/src/lib`. `render-wasm` and the Penpot frontend are not touched.

## Locked decisions (recap)

- **D1** editor-local extended types (keep `packages/penpot-exporter` clean).
- **D2** unified undo via doc-meta change variants.
- **D3** resolver: `style-dictionary` + `@tokens-studio/sd-transforms`, eagerly bundled (bundle size not a constraint).
- **D4** assets + tokens panels live in the **left rail** alongside Layers.
- **D5** Phase 1 ships colors **and** typographies together; then Phase 2 ships tokens.
