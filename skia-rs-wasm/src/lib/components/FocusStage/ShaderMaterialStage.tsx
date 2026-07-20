/**
 * ShaderMaterialStage — the shader-authoring consumer of the generic
 * `FocusStage`. Fills the entire center region as a two-pane workbench, and
 * overrides the right rail (inspector) with the uniform controls:
 *
 *   ┌──────────────┬───────────────────────┬──────────┐
 *   │  SkSL editor │  isolated live preview │ uniforms │
 *   │  + status    │  (the shader alone, at │  (right  │
 *   │              │   a resolution we pick)│   rail)  │
 *   └──────────────┴───────────────────────┴──────────┘
 *      center slot                            right slot
 *
 * The uniform controls sit in the right rail (`ShaderUniformsRail`, a separate
 * focus-stage slot) — the "two-persona bridge": source on the left for the
 * coder, knobs on the right where a designer expects the inspector. That slot
 * can't share React props with this one, so the draft is published through
 * `shaderUniformsBridge`; this component stays authoritative.
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
import type { EditorView } from '@codemirror/view'
import { Pause, Play, Repeat, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Material, MaterialUniform } from '../../renderer/api/material'
import type { ShaderCompileOutput } from '../../renderer/shader-lang'
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
import { ShaderGraphEditor } from './ShaderGraphEditor'
import { shaderLanguage } from '../../renderer/shader-lang'
import { compileGraphToSksl } from '../../renderer/shader-lang/graph/compile'
import { starterGraph } from '../../renderer/shader-lang/graph/starter'
import type { ShaderGraph } from '../../renderer/shader-lang/graph/types'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { shaderUniformsBridge } from '../../renderer/signals/shader-uniforms-bridge'
import { shaderConsoleBridge } from '../../renderer/signals/shader-console-bridge'
import { registerFocusFlush } from '../../history/focus-pending'
import { onChangesApplied } from '../../changes/change-emitter'

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
  /**
   * The session's undo `groupId` (owned by the opener, so it can also seed the
   * session's `undoScope`). Every idle-coalesced commit carries it, so the
   * canvas collapses this whole session into one undo step while the focus
   * reader steps through the frames individually.
   */
  groupId: string
}

export function ShaderMaterialStage({ nodeId, initialMaterial, groupId }: ShaderMaterialStageProps) {
  const [draft, setDraft] = useState<Material>(initialMaterial)
  const draftRef = useRef<Material>(initialMaterial)
  const dirtyRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  // The code editor's CodeMirror view, for jump-to-line from the console.
  const editorViewRef = useRef<EditorView | null>(null)

  // Clock. `u_time` is engine-owned, so whether this material animates is only
  // knowable from the compile — hence observing MaterialEditor's result.
  //
  // Track the last GOOD compile, not the latest: the result is `null` while
  // recompiling and carries `ok: false` for every half-typed line, so keying
  // off it directly would tear the transport away and stall the loop on each
  // keystroke. Holding the last good answer keeps the preview animating while
  // you type — the same keep-last-good the pixels already get.
  const [lastGood, setLastGood] = useState<ShaderCompileOutput | null>(null)
  // The LATEST compile (incl. failures) drives the console: it must show the
  // errors on a broken shader, unlike `lastGood`. `null` = a recompile is in
  // flight (source changed, no result yet) → the console shows "Compiling…".
  const [latest, setLatest] = useState<ShaderCompileOutput | null>(null)
  const [compiling, setCompiling] = useState(false)
  const handleCompiled = useCallback((r: ShaderCompileOutput | null) => {
    if (r?.ok) setLastGood(r)
    setCompiling(r == null)
    if (r != null) setLatest(r)
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

  // `u_phase` is `u_time` over the loop length, in [0, 1). The loop length is
  // ours (the transport duration), so we do the division here and hand Rust the
  // ready value. A ref so the ticker's once-built onTick reads it live.
  const durationRef = useRef(DEFAULT_LOOP_SECONDS)
  useEffect(() => {
    durationRef.current = durationSec
  })
  const phaseOf = (time: number) => (durationRef.current > 0 ? time / durationRef.current : 0)

  /**
   * The clock. A plain `Ticker` — the same one Motion's PlaybackController
   * drives its timelines from — so the rAF loop, gating, loop/clamp and seek
   * live in one tested place rather than in a component. React only flips
   * play/pause/loop/duration; the tick itself never touches React.
   */
  // Built once via a lazy `useState` initializer rather than a null-ref check, so
  // nothing is written during render. `onTick` reads everything it needs through
  // refs (`draftRef`, `timeRef`, `durationRef` via `phaseOf`) and `paintTime` is
  // dep-free, so the once-built closure always sees live values.
  //
  // The rule sees `draftRef.current` lexically inside the initializer and calls it
  // a render-phase read. It isn't: it lives in `onTick`, which only ever runs from
  // the Ticker's rAF loop.
  // eslint-disable-next-line react-hooks/refs
  const [ticker] = useState(() => {
    const t = new Ticker({
      onTick: (timeMs) => {
        timeRef.current = timeMs / 1000 // u_time is seconds
        const module = getWasmModule()
        if (module && isPreviewSupported(module)) {
          drawPreviewFrame(module, draftRef.current, timeRef.current, phaseOf(timeRef.current))
        }
        paintTime()
      },
    })
    t.setDuration(DEFAULT_LOOP_SECONDS * 1000)
    t.setLoop(true)
    return t
  })

  /**
   * Flush the draft to the document as ONE change. No-op when unchanged.
   * Returns the commit promise so callers that must observe the recorded frame
   * (the focus-undo flush) can await it — the frame lands synchronously inside
   * `commitChanges`, but `commitChanges` itself is async.
   */
  const commitNow = useCallback(async (): Promise<void> => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!dirtyRef.current) return
    const before = getCommittedNodeOnActivePage(nodeId)
    const pid = getActiveOrSinglePageId()
    if (!before || !pid) return
    dirtyRef.current = false
    await commitNodePartialUpdate(
      nodeId,
      before,
      { material: draftRef.current } as Partial<PenpotNode>,
      pid,
      groupId,
    )
  }, [nodeId, groupId])

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
  useEffect(() => () => void commitNow(), [commitNow])

  // Expose the pending-draft flush to the focus-undo reader: a Cmd+Z fired
  // moments after typing must first commit that draft so the freshest edit is a
  // history frame the walk can see. One slot — only one focus stage is open.
  useEffect(() => registerFocusFlush(() => commitNow()), [commitNow])

  // Re-seed the draft when the committed material changes UNDER us — a focus
  // undo/redo, a canvas undo, or token propagation on a bound uniform. Guarded
  // on `!dirtyRef` so it never clobbers in-flight typing: the focus reader
  // flushes the pending draft first, so by the time its revert lands we're
  // clean. Compared by value, so our own just-landed commit is a no-op.
  useEffect(() => {
    return onChangesApplied((event) => {
      if (dirtyRef.current) return
      const touched = event.redoChanges.some(
        (ch) =>
          (ch as { type?: string }).type === 'mod-obj' &&
          (ch as { id?: string }).id === nodeId,
      )
      if (!touched) return
      const node = getCommittedNodeOnActivePage(nodeId)
      const mat = (node as { material?: Material } | null)?.material
      if (!mat || JSON.stringify(mat) === JSON.stringify(draftRef.current)) return
      draftRef.current = mat
      setDraft(mat)
      const module = getWasmModule()
      if (module && isPreviewSupported(module)) {
        drawPreviewFrame(module, mat, timeRef.current, phaseOf(timeRef.current))
      }
    })
  }, [nodeId])

  // Commit one uniform, merging against the ALWAYS-fresh draft ref (not the
  // rendered snapshot), so the rail — which reads state through an rAF-gated
  // signal — can never drop a sibling uniform changed in the same frame.
  const setUniform = useCallback(
    (u: MaterialUniform) => {
      const others = (draftRef.current.uniforms ?? []).filter((x) => x.name !== u.name)
      applyChange({ uniforms: [...others, u] })
    },
    [applyChange],
  )

  // ---- Graph authoring -----------------------------------------------------
  // A material either carries a graph (visual authoring; `source` is generated)
  // or not (hand-written code). Both feed the exact same draft/commit/preview
  // machinery above — the graph only changes how `source` is produced.
  const hasGraph = draft.graph != null
  const [mode, setMode] = useState<'code' | 'graph'>(initialMaterial.graph ? 'graph' : 'code')

  /**
   * Edit the graph → recompile → one draft change carrying both. A `layoutOnly`
   * edit (node positions, committed on drag stop) leaves the shader untouched, so
   * it skips codegen — dragging a node must not recompile SkSL.
   */
  const applyGraph = useCallback(
    (next: ShaderGraph, opts?: { layoutOnly?: boolean }) => {
      if (opts?.layoutOnly) applyChange({ graph: next })
      else applyChange({ graph: next, source: compileGraphToSksl(next).source })
    },
    [applyChange],
  )

  const startGraph = useCallback(() => {
    const g = starterGraph()
    applyChange({ graph: g, source: compileGraphToSksl(g).source })
  }, [applyChange])

  /** Keep the generated source, drop the graph — it becomes hand-authored code. */
  const detachGraph = useCallback(() => {
    applyChange({ graph: undefined })
    setMode('code')
  }, [applyChange])

  // With a graph, `MaterialEditor` isn't mounted — so it can't own the compile.
  // Run it here (debounced like the editor does) so the transport, uniforms rail
  // and console keep working exactly as in code mode.
  useEffect(() => {
    if (!hasGraph || !getWasmModule()) return
    const id = window.setTimeout(() => {
      handleCompiled(shaderLanguage(draft.language).compile(draft.source))
    }, PREVIEW_SOURCE_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [hasGraph, draft.source, draft.language, handleCompiled])

  // Publish the draft + reflected uniforms to the right rail. The rail lives in
  // a different focus-stage slot, so it reads this instead of props. Uniforms
  // come from the last GOOD compile (same keep-last-good the preview uses), so
  // the knobs don't vanish on every half-typed line.
  useEffect(() => {
    shaderUniformsBridge.value = {
      material: draft,
      uniforms: lastGood?.uniforms ?? [],
      ok: lastGood != null,
      setUniform,
    }
  }, [draft, lastGood, setUniform])
  useEffect(() => () => void (shaderUniformsBridge.value = null), [])

  // Jump the editor caret to a diagnostic's (1-based) line/column, from a
  // console row click. Clamped so a stale diagnostic can't point off the doc.
  const reveal = useCallback((line: number, column?: number) => {
    const view = editorViewRef.current
    if (!view) return
    const doc = view.state.doc
    const info = doc.line(Math.min(Math.max(line, 1), doc.lines))
    const pos = column != null ? Math.min(info.from + (column - 1), info.to) : info.from
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    view.focus()
  }, [])

  // Publish the latest compile's diagnostics to the console strip (bottom slot).
  useEffect(() => {
    shaderConsoleBridge.value = {
      diagnostics: latest?.diagnostics ?? [],
      status: compiling ? 'compiling' : latest?.ok ? 'ok' : latest ? 'error' : 'compiling',
      reveal,
    }
  }, [latest, compiling, reveal])
  useEffect(() => () => void (shaderConsoleBridge.value = null), [])

  // Mount the shared preview surface into the pane; keep it sized to the pane.
  useEffect(() => {
    const module = getWasmModule()
    const el = previewRef.current
    if (!module || !el || !isPreviewSupported(module)) return

    const rect = el.getBoundingClientRect()
    if (!attachPreview(module, el, rect.width, rect.height)) return
    drawPreview(module, draftRef.current, timeRef.current, phaseOf(timeRef.current))

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      resizePreview(module, r.width, r.height)
      drawPreview(module, draftRef.current, timeRef.current, phaseOf(timeRef.current))
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
      drawPreview(module, draft, timeRef.current, phaseOf(timeRef.current))
      return
    }
    const id = window.setTimeout(
      () => drawPreview(module, draft, timeRef.current, phaseOf(timeRef.current)),
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
    <ResizablePanelGroup orientation="horizontal" className="absolute inset-0">
      {/* Editor pane — opaque, fills height. Drag the handle to trade room
          between the SkSL source and the live preview; the preview's GL surface
          follows via its ResizeObserver, CodeMirror reflows to its container. */}
      <ResizablePanel
        id="shader-editor"
        minSize={22}
        defaultSize={32}
        className="pointer-events-auto flex min-h-0 min-w-0 flex-col overflow-hidden bg-background p-3"
      >
        {/* Authoring mode. Code and Graph are two ways to produce ONE `source`;
            they are not a round-trip — a graph generates code, never the reverse. */}
        <div className="mb-2 flex shrink-0 items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            {(['code', 'graph'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] font-medium capitalize transition',
                  mode === m ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
          {hasGraph && mode === 'code' && (
            <>
              <span className="text-[10px] text-muted-foreground/80">Generated from graph</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-6 px-2 text-[11px]"
                onClick={detachGraph}
                title="Keep this source and edit it by hand — the graph is discarded"
              >
                Detach
              </Button>
            </>
          )}
        </div>

        {mode === 'graph' ? (
          hasGraph && draft.graph ? (
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60">
              <ShaderGraphEditor graph={draft.graph} onChange={applyGraph} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60 p-6 text-center">
              <p className="text-xs text-muted-foreground">
                Build this shader visually by wiring nodes together.
              </p>
              <Button type="button" size="sm" onClick={startGraph}>
                Start a graph
              </Button>
              <p className="max-w-[16rem] text-[10px] text-muted-foreground/70">
                Replaces the current source, which is then generated from the graph.
              </p>
            </div>
          )
        ) : hasGraph ? (
          // Read-only: the graph owns this source. Detach to take it over.
          <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {draft.source}
          </pre>
        ) : (
          <MaterialEditor
            material={draft}
            onChange={applyChange}
            fill
            showUniforms={false}
            onCompiled={handleCompiled}
            onEditorReady={(view) => (editorViewRef.current = view)}
          />
        )}
      </ResizablePanel>

      <ResizableHandle withHandle className="pointer-events-auto" />

      {/* Preview pane — hosts the isolated preview canvas. */}
      <ResizablePanel
        id="shader-preview"
        minSize={30}
        defaultSize={68}
        className="pointer-events-auto relative flex min-h-0 min-w-0 flex-col bg-background"
      >
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
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
