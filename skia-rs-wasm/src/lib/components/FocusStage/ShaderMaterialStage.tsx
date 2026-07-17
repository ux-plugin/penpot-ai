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
import { Pause, Play, Repeat, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Material, MaterialCompileResult } from '../../renderer/api/material'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../../renderer/properties/commit-node-properties'
import { getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import { getWasmModule } from '../../renderer/wasm-module'
import { Ticker } from '../../renderer/anim/ticker'
import {
  attachPreview,
  detachPreview,
  drawPreview,
  drawPreviewFrame,
  isPreviewSupported,
  resizePreview,
} from '../../renderer/focus-preview'
import { MaterialEditor } from '../RightSidePanel/MaterialEditor'

/** Pause after which the draft is committed to the document as one frame. */
const COMMIT_IDLE_MS = 1000

/**
 * Default loop length. The clock is ALWAYS bounded — there's no free-running
 * mode, because a long duration approximates one indistinguishably (nobody
 * watches a preview for an hour, and a page load resets it long before the
 * wrap) while keeping one code path and making f32 precision safe by
 * construction: `u_time <= MAX_LOOP_SECONDS` caps the error a shader can ever
 * see. Dial the duration up to `MAX_LOOP_SECONDS` for effectively free-running.
 */
const DEFAULT_LOOP_SECONDS = 4
const MAX_LOOP_SECONDS = 3600

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

  // Clock. `u_time` is engine-owned, so whether this material animates is only
  // knowable from the compile — hence observing MaterialEditor's result.
  //
  // Track the last GOOD compile, not the latest: the result is `null` while
  // recompiling and carries `ok: false` for every half-typed line, so keying
  // off it directly would tear the transport away and stall the loop on each
  // keystroke. Holding the last good answer keeps the preview animating while
  // you type — the same keep-last-good the pixels already get.
  const [lastGood, setLastGood] = useState<MaterialCompileResult | null>(null)
  const handleCompiled = useCallback((r: MaterialCompileResult | null) => {
    if (r?.ok) setLastGood(r)
  }, [])
  const usesTime = lastGood?.usesTime === true
  const [playing, setPlaying] = useState(true)
  const [loop, setLoop] = useState(true)
  const [durationSec, setDurationSec] = useState(DEFAULT_LOOP_SECONDS)

  // Time lives outside React: the clock advances it every frame, and
  // re-rendering the stage (textarea included) at 60fps just to move a readout
  // would be wasted work. The readout and scrubber are written to the DOM.
  const timeRef = useRef(0)
  const timeLabelRef = useRef<HTMLSpanElement>(null)
  const scrubRef = useRef<HTMLInputElement>(null)

  const paintTime = useCallback(() => {
    if (timeLabelRef.current) timeLabelRef.current.textContent = `${timeRef.current.toFixed(2)}s`
    // Don't fight the user's own drag.
    if (scrubRef.current && document.activeElement !== scrubRef.current) {
      scrubRef.current.value = String(timeRef.current)
    }
  }, [])

  /**
   * The clock. A plain `Ticker` — the same one Motion's PlaybackController
   * drives its timelines from — so the rAF loop, gating, loop/clamp and seek
   * live in one tested place rather than in a component. React only flips
   * play/pause/loop/duration; the tick itself never touches React.
   */
  const tickerRef = useRef<Ticker | null>(null)
  if (tickerRef.current === null) {
    tickerRef.current = new Ticker({
      onTick: (timeMs) => {
        timeRef.current = timeMs / 1000 // u_time is seconds
        const module = getWasmModule()
        if (module && isPreviewSupported(module)) {
          drawPreviewFrame(module, draftRef.current, timeRef.current)
        }
        paintTime()
      },
    })
    tickerRef.current.setDuration(DEFAULT_LOOP_SECONDS * 1000)
    tickerRef.current.setLoop(true)
  }
  const ticker = tickerRef.current

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
    drawPreview(module, draftRef.current, timeRef.current)

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      resizePreview(module, r.width, r.height)
      drawPreview(module, draftRef.current, timeRef.current)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      detachPreview(module)
    }
  }, [])

  // Redraw per edit, at the CURRENT time so a paused frame doesn't snap back
  // to 0 while you tweak. A failed compile keeps the last good frame rather
  // than strobing the pane blank (every half-typed line is a compile error).
  const lastSourceRef = useRef(initialMaterial.source)
  useEffect(() => {
    const module = getWasmModule()
    if (!module || !isPreviewSupported(module)) return
    const sourceChanged = draft.source !== lastSourceRef.current
    lastSourceRef.current = draft.source
    if (!sourceChanged) {
      // Uniform-only edit: same source → cache hit, no compile. Draw now so
      // dragging a slider tracks the pointer.
      drawPreview(module, draft, timeRef.current)
      return
    }
    const id = window.setTimeout(
      () => drawPreview(module, draft, timeRef.current),
      PREVIEW_SOURCE_DEBOUNCE_MS,
    )
    return () => clearTimeout(id)
  }, [draft])

  // Run the clock only for a clock-driven material that's playing. The Ticker
  // schedules nothing while idle, so a static shader (or a paused one) costs
  // exactly zero — and rAF is throttled to nothing while the tab is hidden.
  useEffect(() => {
    if (usesTime && playing) ticker.play()
    else ticker.pause()
    return () => ticker.pause()
  }, [ticker, usesTime, playing])

  useEffect(() => {
    ticker.setDuration(durationSec * 1000)
  }, [ticker, durationSec])

  useEffect(() => {
    ticker.setLoop(loop)
  }, [ticker, loop])

  const resetTime = useCallback(() => ticker.seek(0), [ticker])

  return (
    <div className="absolute inset-0 flex">
      {/* Editor pane — opaque, fills height. */}
      <div className="pointer-events-auto flex w-[440px] shrink-0 flex-col overflow-hidden border-r border-border bg-background p-3">
        <MaterialEditor material={draft} onChange={applyChange} fill onCompiled={handleCompiled} />
      </div>

      {/* Preview pane — hosts the isolated preview canvas. */}
      <div className="pointer-events-auto relative flex min-w-0 flex-1 flex-col bg-background">
        <div className="relative min-h-0 flex-1">
          <span className="pointer-events-none absolute left-3 top-2 z-10 text-[11px] font-medium text-muted-foreground/80">
            Live preview
          </span>
          <div ref={previewRef} className="absolute inset-2 overflow-hidden rounded-lg border border-border/60" />
        </div>

        {/* Transport — only for a clock-driven material (one that declares
            `u_time`). A static shader has nothing to play. */}
        {usesTime && (
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={resetTime}
              aria-label="Reset time"
              title="Reset time to 0"
            >
              <RotateCcw className="size-3.5" />
            </Button>

            {/* Scrub — the reason the clock is bounded: a range makes any frame
                reachable and reproducible. Seeking renders one frame without
                disturbing play/pause. */}
            <input
              ref={scrubRef}
              type="range"
              className="min-w-0 flex-1 accent-accent"
              min={0}
              max={durationSec}
              step={0.01}
              defaultValue={0}
              aria-label="Scrub u_time"
              onChange={(e) => ticker.seek(Number(e.target.value) * 1000)}
            />

            <span
              ref={timeLabelRef}
              className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground"
            >
              0.00s
            </span>

            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn('shrink-0', loop ? 'text-foreground' : 'text-muted-foreground/50')}
              onClick={() => setLoop((l) => !l)}
              aria-label={loop ? 'Disable loop' : 'Enable loop'}
              title={loop ? 'Looping — click to play once' : 'Play once — click to loop'}
            >
              <Repeat className="size-3.5" />
            </Button>

            {/* Loop length. Raise it toward an hour for an effectively
                free-running clock; the bound is what keeps u_time's f32
                precise and every frame reachable. */}
            <Input
              type="number"
              className="h-7 w-16 shrink-0 px-1.5 text-xs"
              min={0.1}
              max={MAX_LOOP_SECONDS}
              step={0.1}
              value={durationSec}
              aria-label="Loop duration (seconds)"
              title="Loop length in seconds"
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v > 0) {
                  setDurationSec(Math.min(MAX_LOOP_SECONDS, v))
                }
              }}
            />
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">s</span>
          </div>
        )}
      </div>
    </div>
  )
}
