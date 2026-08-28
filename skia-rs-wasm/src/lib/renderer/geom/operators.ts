/**
 * Non-destructive geometry operators (Phase 2).
 *
 * A path shape can carry a `base` geometry plus an ordered stack of `operators`
 * that transform it — the eraser's cut, later Trim/Merge/Repeater/Offset. The
 * stack is evaluated in order and the result is the shape's rendered outline, so
 * an operator's inputs can be re-edited or animated without ever touching the base
 * points. `base`/`operators` are canonical; the `subpaths`/`segments` that render
 * are their derived mirror — the exact relationship `network` has to its render
 * subpaths (see {@link networkContent}), and safe to persist as a cache.
 *
 * The boolean itself is injected (`BooleanFn`) rather than imported, so this stays
 * a pure geometry module with no dependency on the wasm facade and can be reasoned
 * about (and unit-tested) with a stubbed boolean.
 */

import type { PathContent, PathSegment } from '../types'
import type { Anchor } from './anchors'
import { compoundContent, segmentsToSubpaths, type Subpath } from './subpaths'

/** One entry in a path's non-destructive stack. Only `subtract` (the eraser cut)
 *  exists today; Trim/Merge/Repeater/Offset slot in here later. */
export type Operator = { type: 'subtract'; clip: Subpath[] }

/** The curve-native boolean, with the wasm module already bound in by the caller.
 *  Mirrors {@link pathBoolean} minus its `module` argument. */
export type BooleanFn = (
  subject: PathContent,
  clip: PathContent,
  boolType: 'union' | 'difference' | 'intersection' | 'exclude',
  fillRule: 'nonzero' | 'evenodd',
) => PathContent | null

/**
 * Fold the operator stack over the base sub-paths and return the resolved
 * (rendered) sub-paths. A `subtract` differences its clip out of the running
 * closed geometry; open sub-paths (strokes) pass through untouched. A failed or
 * empty operator leaves the geometry unchanged rather than dropping it, so a
 * degenerate clip can never blank the shape.
 */
export function resolveOperators(base: Subpath[], operators: Operator[], boolFn: BooleanFn): Subpath[] {
  let current = base
  for (const op of operators) {
    if (op.type === 'subtract') {
      const closed = current.filter((sp) => sp.closed && sp.vertices.length >= 2)
      const open = current.filter((sp) => !(sp.closed && sp.vertices.length >= 2))
      if (closed.length === 0 || op.clip.length === 0) continue
      const res = boolFn(compoundContent(closed), compoundContent(op.clip), 'difference', 'evenodd')
      const cut = res
        ? segmentsToSubpaths(res.segments ?? []).filter((sp) => sp.closed && sp.vertices.length >= 3)
        : closed
      current = [...cut, ...open]
    }
  }
  return current
}

/**
 * Canonical `base` + `operators` PLUS their derived render mirror
 * (`subpaths`/`segments`), mirroring {@link networkContent}. Store the whole
 * object as a node's `content`: the base and stack are the source of truth, the
 * rest is recomputed from them and safe to persist as a cache.
 */
export function operatorContent(
  base: Subpath[],
  operators: Operator[],
  boolFn: BooleanFn,
): {
  base: Subpath[]
  operators: Operator[]
  subpaths: Subpath[]
  segments: PathSegment[]
  vertices?: Anchor[]
  closed?: boolean
} {
  const resolved = resolveOperators(base, operators, boolFn)
  return { base, operators, ...compoundContent(resolved) }
}
