/**
 * Undo / redo: an in-memory stack of frames, one per commit, each holding
 * the commit's inverse. Session-only. See docs/history-model.md.
 *
 * - a group (`beginGroup` / `endGroup`, or `markInteraction` on an idle
 *   timer) folds consecutive commits into one frame: a drag, a scrub;
 * - a scratch branch (`fork` / `merge` / `discard`) gives a focus mode its own
 *   stack; `merge` squashes it into one frame on the parent.
 */
import { signal } from '@preact/signals-core'
import type { Change } from './changes'
import type { DocMetaChange } from '../changes/doc-meta-change'
import { commitChanges } from './commit'

export interface Frame {
  label?: string
  /** Applied to undo, in order. */
  inverse: Change[]
  /** Applied to redo, in order. */
  redo: Change[]
  docMetaUndo: DocMetaChange[]
  docMetaRedo: DocMetaChange[]
}

interface Branch {
  frames: Frame[]
  /** Frames applied: `frames[cursor - 1]` is what undo takes back. */
  cursor: number
  /** Open group: the frame at `cursor - 1` absorbs the next commits. */
  group: { id: string; timer: ReturnType<typeof setTimeout> | null } | null
}

function branch(): Branch {
  return { frames: [], cursor: 0, group: null }
}

const branches: Branch[] = [branch()]

function top(): Branch {
  return branches[branches.length - 1]
}

export const canUndo = signal(false)
export const canRedo = signal(false)
/** A group is open: the frame on top is still taking commits. */
export const groupOpen = signal(false)

function publish(): void {
  const b = top()
  canUndo.value = b.cursor > 0
  canRedo.value = b.cursor < b.frames.length
  groupOpen.value = b.group !== null
}

const GROUP_TIMEOUT_MS = 20_000
const INTERACTION_IDLE_MS = 350

function later(a: Frame, b: Frame): Frame {
  return {
    label: a.label ?? b.label,
    inverse: [...b.inverse, ...a.inverse],
    redo: [...a.redo, ...b.redo],
    docMetaUndo: [...b.docMetaUndo, ...a.docMetaUndo],
    docMetaRedo: [...a.docMetaRedo, ...b.docMetaRedo],
  }
}

/** Record a commit. Truncates redo; folds into the open group if there is one. */
export function pushFrame(frame: Frame): void {
  const b = top()
  b.frames.length = b.cursor
  if (b.group && b.cursor > 0) {
    b.frames[b.cursor - 1] = later(b.frames[b.cursor - 1], frame)
  } else if (b.group) {
    b.frames.push(frame)
    b.cursor++
  } else {
    b.frames.push(frame)
    b.cursor++
  }
  publish()
}

type Flush = () => void | Promise<void>
const flushes = new Set<Flush>()

/**
 * A focus editor with a live draft it commits on idle registers a flush here,
 * so a Cmd+Z moments after typing takes back the draft, not the edit before it.
 */
export function onBeforeUndo(flush: Flush): () => void {
  flushes.add(flush)
  return () => {
    flushes.delete(flush)
  }
}

async function flushDrafts(): Promise<void> {
  for (const f of flushes) await f()
}

export async function undo(): Promise<void> {
  await flushDrafts()
  const b = top()
  endGroup()
  if (b.cursor === 0) return
  const frame = b.frames[b.cursor - 1]
  b.cursor--
  publish()
  await commitChanges({ changes: frame.inverse, docMeta: frame.docMetaUndo, fromHistory: true })
}

export async function redo(): Promise<void> {
  await flushDrafts()
  const b = top()
  endGroup()
  if (b.cursor >= b.frames.length) return
  const frame = b.frames[b.cursor]
  b.cursor++
  publish()
  await commitChanges({ changes: frame.redo, docMeta: frame.docMetaRedo, fromHistory: true })
}

function clearTimer(b: Branch): void {
  if (b.group?.timer) clearTimeout(b.group.timer)
}

/** Open a group: commits until `endGroup` become one frame. A timeout closes it. */
export function beginGroup(id: string, timeoutMs = GROUP_TIMEOUT_MS): void {
  const b = top()
  if (b.group?.id === id) {
    clearTimer(b)
  } else {
    endGroup()
    b.group = { id, timer: null }
  }
  b.group.timer = setTimeout(() => endGroup(id), timeoutMs)
  groupOpen.value = true
}

/** Close the open group. With `id`, only if that group is the open one. */
export function endGroup(id?: string): void {
  const b = top()
  if (!b.group) return
  if (id !== undefined && b.group.id !== id) return
  clearTimer(b)
  b.group = null
  groupOpen.value = false
}

/** Group commits that arrive within `idleMs` of each other (a scrub, a colour drag). */
export function markInteraction(id = 'interaction', idleMs = INTERACTION_IDLE_MS): void {
  beginGroup(id, idleMs)
}

/** Open a scratch branch with its own empty stack. */
export function fork(): void {
  endGroup()
  branches.push(branch())
  publish()
}

/** Close the scratch branch, squashing what stands into one frame on the parent. */
export function merge(label?: string): Frame | undefined {
  if (branches.length === 1) return undefined
  const b = branches.pop()!
  clearTimer(b)
  const live = b.frames.slice(0, b.cursor)
  if (live.length === 0) {
    publish()
    return undefined
  }
  const squashed = live.reduce((acc, f) => later(acc, f))
  const frame = { ...squashed, label }
  pushFrame(frame)
  return frame
}

/** Undo everything on the scratch branch, then drop it. */
export async function discard(): Promise<void> {
  if (branches.length === 1) return
  const b = top()
  endGroup()
  while (b.cursor > 0) await undo()
  branches.pop()
  publish()
}

export function inScratch(): boolean {
  return branches.length > 1
}

/** Forget everything. Load, page switch, tests. */
export function clearHistory(): void {
  for (const b of branches) clearTimer(b)
  branches.length = 0
  branches.push(branch())
  publish()
}

/** Test helper: the frames of the active branch. */
export function framesOf(): readonly Frame[] {
  return top().frames
}

export function cursorOf(): number {
  return top().cursor
}
