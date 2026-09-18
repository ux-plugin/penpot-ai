/**
 * Anchor contract — the design↔code identity guarantee that makes deterministic
 * weaving into AI-generated presentation safe.
 *
 * The rule (PHASE_0_PLAN §E):
 *   Every node id that carries behavior must appear as a `data-node-id` anchor
 *   EXACTLY ONCE, and no node id may appear more than once. The AI may style and
 *   nest freely *inside* an anchor, but may not move, drop, duplicate, split, or
 *   merge it. A repeater template counts once in the (static) source — its
 *   runtime instances are disambiguated by `data-instance-key`, not by repeating
 *   the anchor.
 *
 * Cardinality rules for the awkward cases (documented; enforced where checkable):
 *   - vaporizing nodes (a shape that becomes a CSS background / pseudo-element):
 *     it still needs one anchored host element; if it carries no behavior it is
 *     not *required* to be anchored, but if anchored it must be 1:1.
 *   - semantic split (a "card" that idiomatically becomes <article><img>…):
 *     the anchor goes on the single outermost element representing the node;
 *     descendants are unanchored decoration.
 *
 * The attribute format lives here so the emitter and the validator can't drift.
 */

import type { PageInteractions, NodeId } from './ir'
import type { PNode } from './compile/emit-react'

export const ANCHOR_ATTR = 'data-node-id'
export const INSTANCE_KEY_ATTR = 'data-instance-key'

export const anchorAttr = (nodeId: NodeId): string => `${ANCHOR_ATTR}="${nodeId}"`
export const instanceKeyAttr = (keyExpr: string): string => `${INSTANCE_KEY_ATTR}={${keyExpr}}`

/** Node ids that MUST be anchored because they carry behavior. */
export function requiredAnchors(ir: PageInteractions): Set<NodeId> {
  const req = new Set<NodeId>()
  for (const it of ir.interactions) req.add(it.on.node)
  for (const b of ir.bindings) req.add(b.node)
  for (const s of ir.states) req.add(s.node)
  for (const r of ir.repeaters) req.add(r.node)
  return req
}

/**
 * Count `data-node-id` occurrences in a JSX source string. Supports the two
 * literal forms the anchor contract mandates: `data-node-id="x"` and
 * `data-node-id={"x"}`. (A full JSX-AST parse is a Phase 1 hardening; the
 * contract requires a static string id, which this scan covers.)
 */
export function collectAnchors(source: string): Map<NodeId, number> {
  const counts = new Map<NodeId, number>()
  const re = new RegExp(`${ANCHOR_ATTR}=(?:"([^"]+)"|\\{['"]([^'"]+)['"]\\})`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const id = m[1] ?? m[2]
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/** Count anchors in a structured presentation tree. */
export function collectAnchorsFromTree(root: PNode): Map<NodeId, number> {
  const counts = new Map<NodeId, number>()
  const walk = (n: PNode): void => {
    counts.set(n.nodeId, (counts.get(n.nodeId) ?? 0) + 1)
    n.children?.forEach(walk)
  }
  walk(root)
  return counts
}

export interface AnchorViolation {
  node: NodeId
  kind: 'missing' | 'duplicate'
  count: number
}

export interface AnchorReport {
  ok: boolean
  violations: AnchorViolation[]
}

/**
 * Enforce the 1:1 anchor invariant against a counted set of anchors. Every
 * behavior-bearing node must be present exactly once; no node id may repeat.
 * Extra anchors on purely-presentational nodes are allowed (they just carry no
 * behavior) — but duplicates are never allowed, since they break identity.
 */
export function validateAnchors(ir: PageInteractions, anchors: Map<NodeId, number>): AnchorReport {
  const required = requiredAnchors(ir)
  const violations: AnchorViolation[] = []
  for (const node of required) {
    const count = anchors.get(node) ?? 0
    if (count === 0) violations.push({ node, kind: 'missing', count })
  }
  for (const [node, count] of anchors) {
    if (count > 1) violations.push({ node, kind: 'duplicate', count })
  }
  return { ok: violations.length === 0, violations }
}

/** Validate a generated/AI JSX source string against the IR's behavior. */
export const validateGeneratedSource = (ir: PageInteractions, source: string): AnchorReport =>
  validateAnchors(ir, collectAnchors(source))

/** Validate a structured presentation tree against the IR's behavior. */
export const validatePresentation = (ir: PageInteractions, root: PNode): AnchorReport =>
  validateAnchors(ir, collectAnchorsFromTree(root))

export function formatAnchorReport(report: AnchorReport): string {
  if (report.ok) return 'anchors OK'
  return report.violations
    .map((v) =>
      v.kind === 'missing'
        ? `missing anchor for behavior-bearing node '${v.node}'`
        : `node '${v.node}' anchored ${v.count}× (must be 1)`
    )
    .join('; ')
}
