# Build Mode — Implementation Plan

> Status: **PLAN** · Branch: `worktree-interactions-phase-0` · Scope: `skia-rs-wasm`
>
> A VS Code–style second mode of the *same document*. An activity bar switches
> Design ↔ Build. Build mode = component tree + chat (left), live app preview +
> code (center), inspector with **Parameters / Interactions / Code** tabs (right).
> It is a UI face over the interactions engine built in Phase 0/1 — not a new system.

## 1. Principles

- **One document, two views — not two apps.** Build and Design share the document
  model and the selection signal. Switching modes changes *what you edit*
  (behavior vs geometry), never *what exists*. (Same as Figma Design/Prototype/Dev.)
- **Reuse the engine.** tree = nodes/anchors · inspector = `PageInteractions` IR ·
  preview = the runtime interpreter · code = the React emitter · chat = AI → IR.
- **Reuse the existing UI.** Component tree adapts `LayersPanel`; selection is the
  shared signal; the inspector follows `RightSidePanel`'s section pattern.
- **Additive.** Build mode is new components + a mode signal. Design mode untouched.

## 2. Where it plugs into the app

- **Mode state** — a new signal `editorMode: 'design' | 'build'` (preact
  signals-core, like `signals/selection.ts`).
- **`App.tsx`** — render the `ActivityBar` always; switch the overlay set by mode.
  Design → existing overlays (`LayersPanel`, `RightSidePanel`, toolbars). Build →
  `BuildWorkspace` (tree+chat | preview | inspector). The `CanvasWrapper`/WASM
  canvas stays mounted underneath (Build's preview is a DOM layer over it).
- **Selection** — shared `selectedIds` set. Clicking a component row OR a preview
  element calls `setSelectedIds`; the inspector reads `getSelectedNodes` + the IR
  for that node. Tree/preview/inspector stay in sync with zero new plumbing.
- **IR storage** — per-page `PageInteractions` on `IndexedPage` (the deferred
  serialization task becomes a prerequisite here — see M0).
- **Edits are undoable** — inspector mutations route through the existing
  `commitChanges` pipeline, so Build edits join the same undo/redo history as Design.

## 3. New components

| Component | Responsibility | Built from |
|---|---|---|
| `ActivityBar` | vertical mode switch (Design · App · later Interactions/Data · Settings) | new, ~small |
| `BuildWorkspace` | the 3-column build layout | new |
| `ComponentTree` | node hierarchy: chevrons, type icons, repeater `×N` badge, interaction bolt marker; selection-synced | adapt `LayersPanel`/`LayerRow` |
| `ChatPanel` | message list + input; NL → IR patch | new (stub → real AI) |
| `PreviewStage` | center: Preview/Code toggle. Preview = `InteractionRuntime`; Code = `emitReactComponent` | generalize the Phase-1 harness |
| `BuildInspector` | right: selected-component header + 3 tabs | new, follows `RightSidePanel` pattern |
| ↳ Parameters tab | component props + in-scope variables/derived/ports | reads/writes IR `variables` |
| ↳ Interactions tab | When/Do trigger-action rows + bindings | reads/writes IR `interactions`/`bindings` |
| ↳ Code tab | emitter output scoped to the selected component | `emit-react` |

## 4. Reuse map (engine + existing UI)

| Need | Reuse |
|---|---|
| Component tree | `components/LayersPanel/*` |
| Selection sync | `signals/selection.ts` + `workspace-store.setSelectedIds` + `DocumentModel.getSelectedNodes` |
| Live preview | `interactions/preview/InteractionRuntime` |
| Code generation | `interactions/compile/emit-react` |
| Inspector data + validation | `interactions/{ir,addressing,catalog,expression}` |
| Trigger/action dropdowns | catalog `listTriggers`/`listActions`, platform-filtered |
| Undo/redo | `store/commit.commitChanges` |
| Section/field UI patterns | `components/RightSidePanel/Sections/*` |

## 5. The linchpin: `nodesToPresentation`

Today the preview/emitter consume a hand-written `PNode` tree
([preview/demo.ts](../../src/lib/renderer/interactions/preview/demo.ts)). For a
**real** document, we need an adapter:

```
nodesToPresentation(page: IndexedPage): PNode   // shapes → tag + data-node-id + children
```

This is what turns "a design" into "an app the engine can render and compile." It
maps each shape to an element (frame→div/section, text→span/heading, rect→div,
image→img, a shape tagged 'button'→button), carrying the shape id as the anchor,
and nests by the shape hierarchy. **Everything visible in Build mode depends on
it**, so it's the first thing to de-risk (M0). It's also the precise point where
the "AI generates idiomatic JSX" path slots in later (AI replaces/augments the
naive tag mapping while preserving anchors — the anchor contract already guards this).

## 6. Decisions to settle

1. **Presentation source** — start with a deterministic `nodesToPresentation`
   (naive tag mapping). AI-authored presentation is a later swap behind the anchor
   contract. *(recommended: deterministic first.)*
2. **Two Code scopes** — center Code = whole-app source; inspector Code tab =
   selected component slice. Keep both (zoom-out vs zoom-in) or collapse to the
   center only. *(recommended: keep both; the inspector slice is cheap.)*
3. **Chat backend** — stub (phrase → IR patch) to build the loop, real AI
   (NL → DSL → IR) later. The DSL grammar already exists as the AI target.
4. **Parameters scope** — the tab shows the selected component's props *and* the
   page/global variables it reads, grouped. Global state authored here too.
5. **Activity-bar granularity** — ship 2 modes (Design, Build); Interactions/Data
   are panels *inside* Build, not top-level icons yet.

## 7. Milestones

| # | Milestone | Deliverable | Verify |
|---|---|---|---|
| **M0** | Prereqs | `PageInteractions` ↔ `IndexedPage` serialization (flatten/unflatten); `nodesToPresentation` adapter | node tests |
| **M1** | Shell + mode switch | `editorMode` signal; `ActivityBar`; `App.tsx` switches overlays; empty `BuildWorkspace` | browser: toggle modes |
| **M2** | Component tree | `ComponentTree` (adapt LayersPanel): markers + selection sync | browser |
| **M3** | Preview + Code center | `PreviewStage`: live `InteractionRuntime` over the real page IR+presentation; Code from emitter | browser |
| **M4** | Inspector tabs | `BuildInspector` + Parameters/Interactions/Code; Interactions tab edits IR via commit | node + browser |
| **M5** | Chat | `ChatPanel` UI + stub NL→IR patch (real AI later) | browser |
| **M6** | Polish | cross-pane selection, undo/redo, empty states, platform badges | browser |

Engine-facing work (M0, M3, M4 logic) is unit-testable in node; UI shells (M1, M2,
M5) verified in the browser preview.

## 8. Critical path & risk

`nodesToPresentation` (M0) is the linchpin and the main risk — it's the bridge
from the document to the engine, and the quality of the generated app/preview
rides on it. Build and de-risk M0 before the UI shells. Everything else is
assembling existing pieces (engine + LayersPanel + selection + emitter) behind a
new layout.

## 9. Reused vs new (summary)

- **Reused:** the whole engine (`interactions/*`), `LayersPanel`, selection
  signals, `commitChanges` undo/redo, `RightSidePanel` section patterns.
- **New:** `editorMode` signal, `ActivityBar`, `BuildWorkspace`, `ComponentTree`
  (adapter), generalized `PreviewStage`, `BuildInspector` + 3 tabs, `ChatPanel`,
  `nodesToPresentation`, `IndexedPage.interactions` serialization.
