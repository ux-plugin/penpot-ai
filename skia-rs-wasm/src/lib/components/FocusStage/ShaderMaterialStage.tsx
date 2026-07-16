/**
 * ShaderMaterialStage — the shader-authoring consumer of the generic
 * `FocusStage`. Fills the entire center region as a two-pane workbench:
 *
 *   ┌──────────────┬───────────────────────────┐
 *   │  SkSL editor │   isolated live preview   │
 *   │  + status    │   (the shader alone, at   │
 *   │  + uniforms  │    a resolution we pick)  │
 *   └──────────────┴───────────────────────────┘
 *
 * The preview is **isolated**, not the design canvas: it renders this material
 * standalone into its own GL surface (see `focus-preview.ts`), so there's no
 * neighbour-shape noise and resolution/framing are ours. The shader is built
 * by the same Rust compile+bind path the on-canvas render uses, so the preview
 * can't drift from the real thing.
 *
 * **Draft store + idle-coalesced commits.** Keystrokes only touch a local
 * draft, which drives the preview at full rate. The document is committed on a
 * ~1s idle pause (and on exit) — the way an IDE coalesces typing into undo
 * chunks. Previously every keystroke wrote a document change, minting an undo
 * frame per character and re-rendering the main canvas. See
 * [[project_undo_model]] for the full focus-mode undo design.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PenpotNode } from 'penpot-exporter/types'
import type { Material } from '../../renderer/api/material'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../../renderer/properties/commit-node-properties'
import { getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { getWasmModule } from '../../renderer/wasm-module'
import {
  attachPreview,
  detachPreview,
  drawPreview,
  isPreviewSupported,
  resizePreview,
} from '../../renderer/focus-preview'
import { MaterialEditor } from '../RightSidePanel/MaterialEditor'

/** Pause after which the draft is committed to the document as one frame. */
const COMMIT_IDLE_MS = 1000

/**
 * Debounce for redrawing the preview after a *source* edit. Each distinct
 * source is a real SkSL compile on the main thread, so compiling every
 * character would stutter while typing. Uniform-only changes skip this — the
 * source is unchanged so the compile is a cache hit, and a slider needs to
 * feel live.
 */
const PREVIEW_SOURCE_DEBOUNCE_MS = 120

export interface ShaderMaterialStageProps {
  /** The node whose `material` this stage edits (captured at open time). */
  nodeId: string
  /** The material as it was when focus mode opened. */
  initialMaterial: Material
}

export function ShaderMaterialStage({ nodeId, initialMaterial }: ShaderMaterialStageProps) {
  const [draft, setDraft] = useState<Material>(initialMaterial)
  const draftRef = useRef<Material>(initialMaterial)
  const dirtyRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  /** Flush the draft to the document as ONE change. No-op when unchanged. */
  const commitNow = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!dirtyRef.current) return
    const before = getCommittedNodeOnActivePage(nodeId)
    const pid = getActiveOrSinglePageId()
    if (!before || !pid) return
    dirtyRef.current = false
    void commitNodePartialUpdate(
      nodeId,
      before,
      { material: draftRef.current } as Partial<PenpotNode>,
      pid,
    )
  }, [nodeId])

  const applyChange = useCallback(
    (partial: Partial<Material>) => {
      const next = { ...draftRef.current, ...partial }
      draftRef.current = next
      dirtyRef.current = true
      setDraft(next)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        commitNow()
      }, COMMIT_IDLE_MS)
    },
    [commitNow],
  )

  // Flush any pending draft on exit, so closing focus never drops edits.
  useEffect(() => () => commitNow(), [commitNow])

  // Mount the shared preview surface into the pane; keep it sized to the pane.
  useEffect(() => {
    const module = getWasmModule()
    const el = previewRef.current
    if (!module || !el || !isPreviewSupported(module)) return

    const rect = el.getBoundingClientRect()
    if (!attachPreview(module, el, rect.width, rect.height)) return
    drawPreview(module, draftRef.current)

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      resizePreview(module, r.width, r.height)
      drawPreview(module, draftRef.current)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      detachPreview(module)
    }
  }, [])

  // Redraw per edit. A failed compile keeps the last good frame rather than
  // strobing the pane blank (every half-typed line is a compile error).
  const lastSourceRef = useRef(initialMaterial.source)
  useEffect(() => {
    const module = getWasmModule()
    if (!module || !isPreviewSupported(module)) return
    const sourceChanged = draft.source !== lastSourceRef.current
    lastSourceRef.current = draft.source
    if (!sourceChanged) {
      // Uniform-only edit: same source → cache hit, no compile. Draw now so
      // dragging a slider tracks the pointer.
      drawPreview(module, draft)
      return
    }
    const id = window.setTimeout(() => drawPreview(module, draft), PREVIEW_SOURCE_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [draft])

  return (
    <div className="absolute inset-0 flex">
      {/* Editor pane — opaque, fills height. */}
      <div className="pointer-events-auto flex w-[440px] shrink-0 flex-col overflow-hidden border-r border-border bg-background p-3">
        <MaterialEditor material={draft} onChange={applyChange} fill />
      </div>

      {/* Preview pane — hosts the isolated preview canvas. */}
      <div className="pointer-events-auto relative min-w-0 flex-1 bg-background">
        <span className="pointer-events-none absolute left-3 top-2 z-10 text-[11px] font-medium text-muted-foreground/80">
          Live preview
        </span>
        <div ref={previewRef} className="absolute inset-2 overflow-hidden rounded-lg border border-border/60" />
      </div>
    </div>
  )
}
