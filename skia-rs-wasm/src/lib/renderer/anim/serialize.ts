/**
 * IR serialization — the format contract (v0). Our runtime reads and writes *our*
 * IR, and this is the single serialized shape that crosses every boundary: today
 * persistence, and later the wasm/native boundary to the Rust runtime whose serde
 * types mirror this envelope exactly. Same bytes in TS and Rust = the contract.
 *
 * The contract is the pure runtime IR (`AnimDoc` = params + timelines). Authoring-
 * only metadata (the delta/rest convention, `ShapeMotion.restFrame`) is editor
 * state and deliberately NOT part of it — the runtime never needs it.
 */

import type { AnimDoc, Param, Timeline } from './types'

/** Bump when the serialized shape changes incompatibly. v0 = the simple tier (drivers on the scene graph). */
export const ANIM_FORMAT_VERSION = 0

/** The on-the-wire envelope: a version tag plus the runtime IR document. */
export interface AnimFile {
  version: number
  doc: AnimDoc
}

/** Thrown when a document fails to parse or validate. */
export class AnimFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnimFormatError'
  }
}

/** Assemble a runtime `AnimDoc` from the editor's timelines + parameters. */
export function buildAnimDoc(timelines: Timeline[], params: Param[]): AnimDoc {
  return { params, timelines }
}

/** Serialize a runtime IR document to the versioned JSON contract. */
export function serializeAnimDoc(doc: AnimDoc): string {
  const file: AnimFile = { version: ANIM_FORMAT_VERSION, doc }
  return JSON.stringify(file)
}

/**
 * Parse + validate the versioned contract into a runtime `AnimDoc`. Throws
 * `AnimFormatError` on invalid JSON, a version mismatch, or a malformed document,
 * so the runtime only ever sees a well-formed doc.
 */
export function deserializeAnimDoc(json: string): AnimDoc {
  let file: unknown
  try {
    file = JSON.parse(json)
  } catch {
    throw new AnimFormatError('not valid JSON')
  }
  if (!isRecord(file)) throw new AnimFormatError('not an object')
  if (file.version !== ANIM_FORMAT_VERSION) {
    throw new AnimFormatError(`unsupported format version ${String(file.version)} (expected ${ANIM_FORMAT_VERSION})`)
  }
  const doc = file.doc
  if (!isRecord(doc) || !Array.isArray(doc.params) || !Array.isArray(doc.timelines)) {
    throw new AnimFormatError('malformed doc: params/timelines missing')
  }
  doc.timelines.forEach(validateTimeline)
  doc.params.forEach(validateParam)
  return doc as unknown as AnimDoc
}

function validateTimeline(tl: unknown): void {
  if (!isRecord(tl) || typeof tl.id !== 'string' || typeof tl.duration !== 'number' || !Array.isArray(tl.bindings)) {
    throw new AnimFormatError('malformed timeline')
  }
  for (const b of tl.bindings) {
    if (!isRecord(b) || !isRecord(b.target) || !isRecord(b.curve)) throw new AnimFormatError('malformed binding')
    const curve = b.curve
    if (!isRecord(curve.domain) || !Array.isArray(curve.keys)) throw new AnimFormatError('malformed curve')
    if (curve.domain.kind !== 'time' && curve.domain.kind !== 'param') {
      throw new AnimFormatError('unknown domain kind')
    }
    for (const k of curve.keys) {
      if (!isRecord(k) || typeof k.at !== 'number' || typeof k.value !== 'number') {
        throw new AnimFormatError('malformed key')
      }
    }
  }
}

function validateParam(p: unknown): void {
  if (!isRecord(p) || typeof p.id !== 'string' || (p.kind !== 'number' && p.kind !== 'bool' && p.kind !== 'trigger')) {
    throw new AnimFormatError('malformed param')
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
