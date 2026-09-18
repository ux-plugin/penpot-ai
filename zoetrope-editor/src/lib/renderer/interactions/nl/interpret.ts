/**
 * NL → IR interpreter. The chat panel's brain.
 *
 * `interpret(text, ctx)` turns a plain-language request into an IR edit, using
 * the SAME reducers as the inspector — so chat is just another author of one IR,
 * not a separate engine. It only targets nodes/variables that exist in `ctx`
 * (grounded, never hallucinated); an unknown reference returns a clarifying
 * reply, never a broken IR.
 *
 * This is the AI seam: the stub below matches a few intents with rules. A real
 * `aiInterpret` (Claude + the catalog + IR schema) will implement the same
 * `interpret` signature and return the same `InterpretResult`, with the chat UI
 * and everything downstream unchanged.
 */

import type { PageInteractions, Variable } from '../ir'
import {
  addInteraction,
  addAction,
  setActionTarget,
  setActionValue,
  addVariable,
  makeCollectionVariable,
  makeScalarVariable,
  toVariableId,
} from '../document/edit-interactions'

export interface InterpretNode {
  id: string
  name?: string
}

export interface InterpretContext {
  /** Selectable components (page nodes minus the root). */
  nodes: InterpretNode[]
  /** Current page IR (existing variables/interactions to resolve against). */
  ir: PageInteractions
  /** The currently selected node, for "this"/"it" references. */
  selectedId?: string | null
  /** Interaction-id factory (injected for deterministic tests). */
  newId?: () => string
}

export type InterpretResult =
  | { ok: true; reply: string; apply: (ir: PageInteractions) => PageInteractions }
  | { ok: false; reply: string }

const HELP =
  'I can set up click interactions — try "when Add button is clicked, add an item to the todo list", or "when Add button is clicked, clear the list".'

function isCollectionVar(v: Variable): boolean {
  return typeof v.type === 'object' && v.type !== null && 'collection' in v.type
}

/** Resolve a component phrase to a real node, or null. */
function resolveNode(phrase: string, ctx: InterpretContext): InterpretNode | null {
  const p = phrase.toLowerCase().trim()
  if (/\b(this|it|that|the button|selected)\b/.test(p) && ctx.selectedId) {
    const n = ctx.nodes.find((x) => x.id === ctx.selectedId)
    if (n) return n
  }
  let best: InterpretNode | null = null
  let bestLen = 0
  for (const n of ctx.nodes) {
    const name = (n.name ?? '').toLowerCase().trim()
    if (name && p.includes(name) && name.length > bestLen) {
      best = n
      bestLen = name.length
    }
  }
  return best
}

/** Resolve a collection phrase to an existing variable, or describe one to create. */
function resolveCollection(phrase: string, ctx: InterpretContext): { id: string; create?: Variable } {
  const p = phrase.toLowerCase()
  for (const v of ctx.ir.variables) {
    if (p.includes(v.id.toLowerCase())) return { id: v.id }
  }
  const cols = ctx.ir.variables.filter(isCollectionVar)
  if (cols.length === 1) return { id: cols[0].id }
  const cleaned = phrase.replace(/\b(the|a|an|to|into|list)\b/gi, ' ').trim()
  const id = toVariableId(cleaned) || 'items'
  return { id, create: makeCollectionVariable(id) }
}

function valueExprFor(rawValue: string): string {
  const v = rawValue.trim()
  if (/^-?\d+(\.\d+)?$/.test(v)) return v
  if (/^(true|false)$/i.test(v)) return v.toLowerCase()
  return JSON.stringify(v.replace(/^["']|["']$/g, ''))
}

export function interpret(text: string, ctx: InterpretContext): InterpretResult {
  const newId = ctx.newId ?? (() => crypto.randomUUID())
  const raw = text.trim()
  if (!raw) return { ok: false, reply: HELP }
  const t = raw.toLowerCase()

  const when = t.match(/when\s+(.+?)\s+(?:is\s+|gets\s+)?(?:clicked|pressed|tapped)\b[,:]?\s*(.*)/)
  if (!when) return { ok: false, reply: HELP }

  const nodePhrase = when[1]
  const actionPhrase = when[2]
  const node = resolveNode(nodePhrase, ctx)
  if (!node) {
    const names = ctx.nodes.map((n) => n.name).filter(Boolean).join(', ')
    return { ok: false, reply: `I couldn't find a component called "${nodePhrase.trim()}".${names ? ` Components: ${names}.` : ''}` }
  }
  const label = node.name ?? 'this'
  const id = newId()

  let m: RegExpMatchArray | null

  if ((m = actionPhrase.match(/(?:add|append|insert)\b.*?\b(?:to|into)\s+(.+)/))) {
    const col = resolveCollection(m[1], ctx)
    return {
      ok: true,
      reply: `Added — on ${label} click, append an item to ${col.id}.`,
      apply: (ir) => {
        let next = col.create ? addVariable(ir, col.create) : ir
        next = addInteraction(next, node.id, id)
        next = addAction(next, id, 'collection.append')
        next = setActionTarget(next, id, 0, col.id)
        next = setActionValue(next, id, 0, `{ label: "Item " + (${col.id}.length + 1) }`)
        return next
      },
    }
  }

  if ((m = actionPhrase.match(/(?:clear|empty|reset)\s+(?:the\s+)?(.+)/))) {
    const col = resolveCollection(m[1], ctx)
    return {
      ok: true,
      reply: `Added — on ${label} click, clear ${col.id}.`,
      apply: (ir) => {
        let next = col.create ? addVariable(ir, col.create) : ir
        next = addInteraction(next, node.id, id)
        next = addAction(next, id, 'set-variable')
        next = setActionTarget(next, id, 0, col.id)
        next = setActionValue(next, id, 0, '[]')
        return next
      },
    }
  }

  if ((m = actionPhrase.match(/set\s+(.+?)\s+to\s+(.+)/))) {
    const varName = toVariableId(m[1]) || 'value'
    const exists = ctx.ir.variables.some((v) => v.id === varName)
    const expr = valueExprFor(m[2])
    return {
      ok: true,
      reply: `Added — on ${label} click, set ${varName} to ${expr}.`,
      apply: (ir) => {
        let next = exists ? ir : addVariable(ir, makeScalarVariable(varName))
        next = addInteraction(next, node.id, id)
        next = addAction(next, id, 'set-variable')
        next = setActionTarget(next, id, 0, varName)
        next = setActionValue(next, id, 0, expr)
        return next
      },
    }
  }

  if (/\b(navigate|go to|open)\b/.test(actionPhrase)) {
    return { ok: false, reply: "Navigation and overlays need another page, which isn't set up yet." }
  }

  return { ok: false, reply: `I understood "when ${label} is clicked", but not what should happen. ${HELP}` }
}
