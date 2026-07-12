/**
 * Motion store — app-facing state and controls for timeline playback. Holds the
 * current shape motions and playhead as preact signals and owns a single
 * PlaybackController wired to the WASM canvas via WasmModifierSink. Pivots
 * (shape centres) are recomputed from live geometry before each play/seek so
 * rotation and scale pivot on the shape rather than the world origin.
 *
 * Each `ShapeMotion` is one shape's IR timeline + its rest metadata; the store
 * feeds the raw timelines to the controller. A params provider is wired in so
 * param-domain bindings evaluate against live values (empty until the parameter
 * panel lands).
 */

import { computed, signal } from '@preact/signals-core'
import { useWorkspaceStore } from '../store/workspace-store'
import { querySelectionRect, wasmSelectionRect } from '../signals/selection'
import { getSelectedIdsSet } from '../store/document-selection'
import { getActiveOrSinglePageId } from '../store/doc-proxy'
import { commitNodeGeometry, getCommittedNodeOnActivePage } from '../properties/commit-node-properties'
import { inspectorTab } from '../signals/inspector-tab'
import { PlaybackController } from './playback-controller'
import { WasmModifierSink } from './wasm-sink'
import {
  ensureRestAnchor,
  keyframeDelta,
  moveKeyframe,
  rebaseToRest,
  removeKeyframe,
  setKeyframe,
  setParamKeyframe,
  setPositionKeyframe,
  type ShapeMotion,
} from './edit'
import type { AnimatableProperty } from './props'
import type { AnimDoc, Interp, Param } from '../anim/types'
import { buildAnimDoc, serializeAnimDoc } from '../anim/serialize'
import { rustEval, rustLoadDoc, rustSetParam } from './rust-runtime'
import type { Pivot } from './modifier'
import { nearestKeyframeTime } from './motion-path'
import type { Matrix } from 'penpot-exporter/types'

export const motionShapes = signal<ShapeMotion[]>([])
export const motionTime = signal(0)
export const motionPlaying = signal(false)
export const motionLoop = signal(false)

/** Live parameter values fed to param-domain bindings. Empty until the parameter panel wires it. */
export const motionParams = signal<Record<string, number>>({})

/** Declared number parameters (id, range, current value). Scene-level; bindings reference them by id. */
export const motionParamDefs = signal<Param[]>([])

/**
 * True whenever a motion preview is applied to the canvas (between play/seek and
 * stop, including while paused mid-animation). Editor overlays read this to hide
 * selection chrome that would otherwise sit at the shape's base pose while the
 * shape is displaced.
 */
export const motionPreviewActive = signal(false)

/**
 * Whether the on-canvas motion overlay (path + ghosts + keyframe diamonds) is
 * shown for a selected animated shape. The Motion badge toggles it; defaults on
 * so selecting an animated shape reveals its trajectory. Playback still hides
 * everything regardless (the overlay reads `!motionPlaying`).
 */
export const showMotionPaths = signal(true)

/** All time-domain keyframe times across every track of the given motions. */
function keyframeTimes(shapes: ShapeMotion[]): number[] {
  const set = new Set<number>()
  for (const s of shapes) {
    for (const b of s.timeline.bindings) {
      if (b.curve.domain.kind !== 'time') continue
      for (const k of b.curve.keys) set.add(k.at)
    }
  }
  return [...set]
}

/** Ruler length (ms), floored at 1000 — matches TimelinePanel. */
function motionDuration(shapes: ShapeMotion[]): number {
  return Math.max(1000, ...shapes.map((s) => s.timeline.duration))
}

/**
 * The keyframe time the playhead currently sits on (within a small tolerance), or
 * null between keyframes. Derived from motionTime + the keyframes, so "which
 * keyframe is selected" is ONE computed value every surface reads — nothing to
 * keep in sync. The playhead is NOT snapped: moving it is free; this only lights
 * up a keyframe when the line is on it.
 */
export const selectedKeyframeTime = computed<number | null>(() => {
  const shapes = motionShapes.value
  if (shapes.length === 0) return null
  return nearestKeyframeTime(keyframeTimes(shapes), motionTime.value, motionDuration(shapes))
})

const sink = new WasmModifierSink()
const controller = new PlaybackController(sink, {
  params: () => motionParams.value,
  evaluateFrame: (ctx) => rustEval(ctx),
  onFrame: (t) => {
    motionTime.value = t
  },
  onStop: () => {
    // Playback reached the end and stays paused-at-end (the shape is displaced
    // to the final frame). Resync the overlay + worker to that frame: `onFrame`
    // never refreshes them during play, so without this the box reappears stale
    // at the rest pose while the shape sits at the end.
    motionPlaying.value = false
    refreshSelectionRect()
    syncHitTransforms()
  },
})

function computePivots(shapes: ShapeMotion[]): Map<string, Pivot> {
  const renderer = useWorkspaceStore.getState().renderer
  const pivots = new Map<string, Pivot>()
  if (!renderer) return pivots
  for (const shape of shapes) {
    const rect = querySelectionRect(renderer, [shape.targetId])
    if (rect) pivots.set(shape.targetId, { cx: rect.center.x, cy: rect.center.y })
  }
  return pivots
}

/**
 * Refresh the selection overlay rect (box, corner handles, grab-bounds) to the
 * shape's current bounds. `getSelectionRect` is modifier-aware: render-wasm's
 * shapes pool returns the *modified* shape (`shape.transformed(modifiers, …)`,
 * shapes_pool.rs) whenever a modifier is applied, so while a motion preview
 * displaces the shape this already returns the displaced bounds — no frontend
 * matrix math. We only need to re-query at the right moments (seek / pause /
 * stop); `onFrame` doesn't, which is why paused-after-play needs an explicit call.
 */
function refreshSelectionRect(): void {
  const renderer = useWorkspaceStore.getState().renderer
  if (!renderer) return
  const ids = getSelectedIdsSet()
  if (ids.size === 0) return
  const rect = querySelectionRect(renderer, ids)
  if (rect) wasmSelectionRect.value = rect
}

/** Read-only view of the last drawn per-shape matrices (id -> matrix). */
export function lastAppliedModifiers(): ReadonlyMap<string, Matrix> {
  return sink.lastApplied
}

/**
 * Push (or clear) the modifier-aware hit-test layer in the selection worker.
 * While a preview is applied AND playback is paused, shapes are displaced from
 * their document pose, so we hand the worker each animated shape's matrix
 * (rest -> animated); it refits its spatial index and inverse-maps queries so a
 * click lands on the shape you SEE. Cleared on stop / during playback so the
 * worker reverts to rest geometry (non-destructive). Fire-and-forget; the index
 * only feeds hit-testing and may lag a frame.
 */
function syncHitTransforms(): void {
  const { workerClient } = useWorkspaceStore.getState()
  if (!workerClient) return
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return
  const active = motionPreviewActive.value && !motionPlaying.value
  if (!active) {
    void workerClient.sendMessage('index/clear-hit-transforms', { pageId })
    return
  }
  const transforms: Array<[string, Matrix]> = []
  for (const [id, matrix] of sink.lastApplied) transforms.push([id, matrix])
  void workerClient.sendMessage('index/hit-transforms', { pageId, transforms })
}

export function setMotionShapes(shapes: ShapeMotion[]): void {
  motionShapes.value = shapes
  controller.setTimelines(shapes.map((s) => s.timeline))
  rustLoadDoc(currentAnimDoc()) // sync the Rust runtime (no-op unless it's built in)
}

export function playMotion(): void {
  const shapes = motionShapes.value
  if (shapes.length === 0) return
  controller.setPivots(computePivots(shapes))
  controller.setLoop(motionLoop.value)
  controller.play()
  motionPlaying.value = true
  motionPreviewActive.value = true
}

export function pauseMotion(): void {
  controller.pause()
  motionPlaying.value = false
  refreshSelectionRect()
  syncHitTransforms()
}

/** Stop, reset the playhead, and clear the preview so shapes return to base. */
export function stopMotion(): void {
  controller.pause()
  controller.seek(0)
  sink.reset()
  motionPlaying.value = false
  motionPreviewActive.value = false
  motionTime.value = 0
  refreshSelectionRect()
  syncHitTransforms()
}

export function seekMotion(t: number): void {
  // The authoring playhead moves freely across the whole timeline ruler -- even
  // before any keyframes span it. The PlaybackController clamps time to the
  // duration (it can only render a frame that exists), so we drive the *preview*
  // through it but write the *requested* time straight to motionTime. With no
  // motions we clear any lingering modifier so the shape snaps back to its base
  // pose. The selection overlay hides only when the preview actually displaces
  // the shape (motions exist AND we're past t=0), so keyframing at the start does
  // not make the handles vanish.
  const time = Math.max(0, t)
  const has = motionShapes.value.length > 0
  if (has) {
    controller.setPivots(computePivots(motionShapes.value))
    controller.seek(time)
  } else {
    sink.reset()
  }
  motionTime.value = time
  motionPreviewActive.value = has && time > 0
  refreshSelectionRect()
  syncHitTransforms()
}

export function setMotionLoop(loop: boolean): void {
  motionLoop.value = loop
  controller.setLoop(loop)
}

/** The rest-frame time (ms) for a target, defaulting to 0. */
function restFrameFor(targetId: string): number {
  return motionShapes.value.find((s) => s.targetId === targetId)?.restFrame ?? 0
}

/**
 * Add or update a keyframe at the current playhead. `delta` is the offset from
 * the shape's rest pose (what the Motion UI computes as `end - current`). When
 * keyframing anywhere other than the rest time we first seed a delta-0 rest
 * anchor, so the stored motion is a true rest -> here transition.
 */
export function setKeyframeAtPlayhead(
  targetId: string,
  property: AnimatableProperty,
  delta: number,
  interp?: Interp,
): void {
  const restT = restFrameFor(targetId)
  let shapes = motionShapes.value
  if (motionTime.value !== restT) shapes = ensureRestAnchor(shapes, targetId, property, restT)
  shapes = setKeyframe(shapes, targetId, property, motionTime.value, delta, interp)
  setMotionShapes(shapes)
  seekMotion(motionTime.value)
}

/** Remove the keyframe for (target, property) at the current playhead. */
export function removeKeyframeAtPlayhead(targetId: string, property: AnimatableProperty): void {
  setMotionShapes(removeKeyframe(motionShapes.value, targetId, property, motionTime.value))
  seekMotion(motionTime.value)
}

/** Retime an existing keyframe for (target, property) from one time to another. */
export function moveKeyframeTime(
  targetId: string,
  property: AnimatableProperty,
  fromTime: number,
  toTime: number,
): void {
  setMotionShapes(moveKeyframe(motionShapes.value, targetId, property, fromTime, toTime))
  seekMotion(motionTime.value)
}

/** Preview the pose at `restFrame` on the canvas without committing (slider drag). */
export function previewMotionRestFrame(restFrame: number): void {
  seekMotion(restFrame)
}

/**
 * Commit a chosen resting pose. Re-homes the shape's DOCUMENT position to the
 * pose at `restFrame` (so `node.x/y/rotation` -- and therefore layout, selection,
 * export -- follow the rest) and shifts the keyframes so the trajectory is
 * unchanged with delta 0 at `restFrame`. Because the new home equals the pose the
 * slider was previewing, the shape does not jump. Idle then sits on the document
 * (no offset). One undo entry per commit.
 */
export async function commitMotionRestFrame(targetId: string, restFrame: number): Promise<void> {
  const { motions, docDelta } = rebaseToRest(motionShapes.value, targetId, restFrame)
  const before = getCommittedNodeOnActivePage(targetId)
  const pid = getActiveOrSinglePageId()
  if (before && pid && (docDelta.x !== 0 || docDelta.y !== 0 || docDelta.rotation !== 0)) {
    const b = before as { x?: number; y?: number; rotation?: number }
    await commitNodeGeometry(
      targetId,
      before,
      {
        x: (typeof b.x === 'number' ? b.x : 0) + docDelta.x,
        y: (typeof b.y === 'number' ? b.y : 0) + docDelta.y,
        rotation: (typeof b.rotation === 'number' ? b.rotation : 0) + docDelta.rotation,
      },
      pid,
    )
  }
  setMotionShapes(motions)
  // Land on the new home: sample(restFrame) is now 0, so this applies an identity
  // offset -- the shape sits exactly on its (moved) document pose, no jump.
  seekMotion(restFrame)
  motionPreviewActive.value = false // at rest the shape is not displaced; keep the overlay live
}

/**
 * Author an x/y keyframe at the current playhead (deltas from rest), baking the
 * neighbouring waypoints on each axis so the edit stays LOCAL -- only the two path
 * segments adjacent to the playhead re-flow. Seeds a rest anchor when keyframing
 * off the rest frame, exactly like the single-axis path. One render (via seek).
 */
function setPositionKeyframeAtPlayhead(targetId: string, dx: number, dy: number): void {
  const restT = restFrameFor(targetId)
  const time = motionTime.value
  let shapes = motionShapes.value
  if (time !== restT) {
    shapes = ensureRestAnchor(shapes, targetId, 'x', restT)
    shapes = ensureRestAnchor(shapes, targetId, 'y', restT)
  }
  shapes = setPositionKeyframe(shapes, targetId, time, dx, dy)
  setMotionShapes(shapes)
  seekMotion(time)
}

/**
 * Record a canvas drag (world dx/dy) as x/y keyframes at the playhead: the
 * shape's existing delta here PLUS the drag, so a drag nudges the animated pose.
 * Active only while the Motion tab is open AND the playhead is off the rest
 * frame -- on the rest frame a drag edits the shape's home pose instead (handled
 * by the normal geometry commit). Returns true when it consumed the gesture, so
 * the drag handler skips committing document geometry. The keyframe is written
 * with neighbour-baking so retimed/desynced axes don't drag distant path segments.
 */
export function recordDragKeyframe(targetId: string, worldDx: number, worldDy: number): boolean {
  if (inspectorTab.value !== 'motion') return false
  const t = motionTime.value
  if (t === restFrameFor(targetId)) return false
  const dx = keyframeDelta(motionShapes.value, targetId, 'x', t) + worldDx
  const dy = keyframeDelta(motionShapes.value, targetId, 'y', t) + worldDy
  setPositionKeyframeAtPlayhead(targetId, dx, dy)
  return true
}

/**
 * The shape's animated offset from rest at the current playhead -- but only while
 * a drag there should author motion (Motion tab open, playhead off the rest
 * frame). The move handler adds this to the drag delta so the shape tracks the
 * cursor from its DISPLACED pose instead of snapping back to rest. Null when a
 * drag should just move the document pose.
 */
export function motionDragBase(targetId: string): { x: number; y: number } | null {
  if (inspectorTab.value !== 'motion') return null
  const t = motionTime.value
  if (t === restFrameFor(targetId)) return null
  return {
    x: keyframeDelta(motionShapes.value, targetId, 'x', t),
    y: keyframeDelta(motionShapes.value, targetId, 'y', t),
  }
}

// --- Parameters (param-domain driving) ---

let paramSeq = 0

/** Create a number parameter over [min, max], initialised at min. Returns its id. */
export function addNumberParam(min = 0, max = 1): string {
  const id = `p${++paramSeq}`
  const def: Param = { id, kind: 'number', value: min, min, max }
  motionParamDefs.value = [...motionParamDefs.value, def]
  motionParams.value = { ...motionParams.value, [id]: min }
  rustLoadDoc(currentAnimDoc())
  return id
}

/** Set a parameter's live value (clamped to its range) and re-render the current frame. */
export function setParamValue(id: string, v: number): void {
  const def = motionParamDefs.value.find((d) => d.id === id)
  const clamped = def ? Math.min(def.max ?? v, Math.max(def.min ?? v, v)) : v
  motionParams.value = { ...motionParams.value, [id]: clamped }
  const idx = motionParamDefs.value.findIndex((d) => d.id === id)
  if (idx >= 0) rustSetParam(idx, clamped)
  renderCurrentFrame()
}

/** Delete a parameter and its live value. Existing bindings on it sample as 0. */
export function removeParam(id: string): void {
  motionParamDefs.value = motionParamDefs.value.filter((d) => d.id !== id)
  const next = { ...motionParams.value }
  delete next[id]
  motionParams.value = next
  rustLoadDoc(currentAnimDoc())
  renderCurrentFrame()
}

/**
 * Bind a shape property to a parameter: delta 0 at the parameter's min (rest),
 * `endDelta` at its max. Sliding the parameter then drives the property live,
 * the same delta convention as a time keyframe but over a param domain.
 */
export function bindPropertyToParam(
  targetId: string,
  property: AnimatableProperty,
  paramId: string,
  endDelta: number,
): void {
  const def = motionParamDefs.value.find((d) => d.id === paramId)
  const min = def?.min ?? 0
  const max = def?.max ?? 1
  let shapes = motionShapes.value
  shapes = setParamKeyframe(shapes, targetId, property, paramId, min, 0)
  shapes = setParamKeyframe(shapes, targetId, property, paramId, max, endDelta)
  setMotionShapes(shapes)
  renderCurrentFrame()
}

/** Re-render the current playhead frame so a parameter change shows live on the canvas. */
function renderCurrentFrame(): void {
  if (motionShapes.value.length === 0) {
    sink.reset()
    return
  }
  controller.setPivots(computePivots(motionShapes.value))
  controller.seek(motionTime.value)
  motionPreviewActive.value = true
  refreshSelectionRect()
  syncHitTransforms()
}

// --- Runtime document (the format contract) ---

/**
 * The current authoring state as a runtime `AnimDoc` — timelines + parameters,
 * exactly what the evaluator (and later the Rust runtime) consumes. Rest metadata
 * is authoring-only and intentionally excluded (see anim/serialize).
 */
export function currentAnimDoc(): AnimDoc {
  return buildAnimDoc(
    motionShapes.value.map((s) => s.timeline),
    motionParamDefs.value,
  )
}

/** Serialize the current motion to the versioned format contract (JSON). */
export function serializeMotion(): string {
  return serializeAnimDoc(currentAnimDoc())
}
