/**
 * InteractionRuntime — renders a PageInteractions IR as a LIVE interactive React
 * tree (the "preview mode"). Thin wrapper over the pure runtime core: state lives
 * in `useState`, the presentation `PNode` tree is walked into real elements with
 * bound props, event handlers, and repeaters. Every element keeps its
 * `data-node-id` anchor so what you click maps back to the design node.
 */

import { useEffect, useMemo, useState, createElement, type ReactNode } from 'react'
import type { PageInteractions, Interaction } from '../ir'
import { STYLE_PROPS, VOID_TAGS, type PNode } from '../compile/emit-react'
import { parse, evaluate } from '../expression'
import {
  initRuntime,
  buildEnv,
  runInteraction,
  activeSlotView,
  diffRuntime,
  affectedNodes,
  type RuntimeState,
  type ActivityEntry,
} from './runtime'

type Env = Record<string, unknown>

/** Write half of a two-way binding: node id, target cell, new value. */
type Edit = (node: string, target: string, value: unknown) => void

/**
 * Runtime state plus what produced it (null before anything fires). The cause is
 * flattened to node+trigger rather than the Interaction itself, so a two-way
 * edit — which has no Interaction — reports through the same path and shows up
 * in the activity log like everything else.
 */
interface Snapshot {
  rt: RuntimeState
  cause: { node: string; trigger: string; before: RuntimeState } | null
}

const EVENT_PROP: Record<string, string> = {
  press: 'onClick',
  'mouse-enter': 'onMouseEnter',
  'mouse-leave': 'onMouseLeave',
}

const safeEval = (src: string, env: Env): unknown => {
  try {
    return evaluate(parse(src), env)
  } catch {
    return undefined
  }
}
const asArray = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const asText = (v: unknown): string => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''))

export function InteractionRuntime({
  ir,
  root,
  onRuntime,
}: {
  ir: PageInteractions
  root: PNode
  /**
   * Observe the running state. Called once on mount and after every state
   * change, with the activity entry for the interaction that caused it (null on
   * mount). Reporting happens in an EFFECT, not inside the setState updater —
   * updaters must stay pure, or StrictMode's double-invoke would log twice.
   */
  onRuntime?: (rt: RuntimeState, activity: ActivityEntry | null) => void
}) {
  // State and its cause travel together: the updater records which interaction
  // produced this state and what preceded it, so the reporting effect can diff
  // without a ref. The updater stays pure — StrictMode's double-invoke yields
  // the same snapshot rather than a duplicate log entry.
  const [snap, setSnap] = useState<Snapshot>(() => ({ rt: initRuntime(ir), cause: null }))
  const { rt } = snap
  const env = useMemo(() => buildEnv(ir, rt), [ir, rt])
  // recompute env from the *current* state inside the updater to avoid staleness
  const fire = (it: Interaction) =>
    setSnap((cur) => ({
      rt: runInteraction(ir, cur.rt, it, buildEnv(ir, cur.rt)),
      cause: { node: it.on.node, trigger: it.on.trigger.type, before: cur.rt },
    }))

  /** The write half of a two-way binding: a discrete event folding into a cell. */
  const edit = (node: string, target: string, value: unknown) =>
    setSnap((cur) => ({
      rt: { ...cur.rt, store: { ...cur.rt.store, [target]: value } },
      cause: { node, trigger: 'edit', before: cur.rt },
    }))

  useEffect(() => {
    if (!onRuntime) return
    const { rt: state, cause } = snap
    if (!cause) {
      onRuntime(state, null) // initial mount: state, but nothing has fired yet
      return
    }
    // An entry with no changes is still worth showing — it's how you see that a
    // guard blocked the interaction rather than the click missing entirely.
    onRuntime(state, {
      node: cause.node,
      trigger: cause.trigger,
      changes: diffRuntime(cause.before, state),
      affected: affectedNodes(ir, cause.before, state),
    })
  }, [snap, ir, onRuntime])

  return <>{renderNode(root, env, ir, fire, edit, rt.slotViews)}</>
}

function renderNode(
  node: PNode,
  env: Env,
  ir: PageInteractions,
  fire: (it: Interaction) => void,
  edit: Edit,
  slots: Record<string, string>,
  key?: number | string,
): ReactNode {
  const rep = ir.repeaters.find((r) => r.node === node.nodeId)
  if (rep) {
    const as = rep.as ?? 'item'
    const coll = asArray(safeEval(rep.over, env))
    return coll.map((item, i) => {
      const itemEnv: Env = { ...env, [as]: item }
      const k = rep.key ? safeEval(rep.key, itemEnv) : isRecord(item) && 'id' in item ? (item.id as string) : i
      return renderElement(node, itemEnv, ir, fire, edit, slots, true, k ?? i)
    })
  }
  return renderElement(node, env, ir, fire, edit, slots, false, key)
}

function renderElement(
  node: PNode,
  env: Env,
  ir: PageInteractions,
  fire: (it: Interaction) => void,
  edit: Edit,
  slots: Record<string, string>,
  instance: boolean,
  key?: number | string,
): ReactNode {
  const props: Record<string, unknown> = { 'data-node-id': node.nodeId }
  const style: Record<string, unknown> = { ...(node.style ?? {}) }
  if (key !== undefined) {
    props.key = key
    // Only true repeater instances carry data-instance-key (anchor contract);
    // plain keyed children get a React key but no instance anchor.
    if (instance) props['data-instance-key'] = key
  }

  let textChild: unknown
  for (const b of ir.bindings) {
    if (b.node !== node.nodeId) continue
    const val = safeEval(b.from, env)
    if (b.prop === 'text' || b.prop === 'children') textChild = val
    else if (STYLE_PROPS.has(b.prop)) style[b.prop] = val
    else props[b.prop] = val
  }
  if (Object.keys(style).length) props.style = style

  // Two-way: read the cell into the value prop, write the change back into it.
  for (const e of ir.editable) {
    if (e.node !== node.nodeId) continue
    props[e.prop] = env[e.target] ?? ''
    props.onChange = (ev: { target: { value: unknown } }) => edit(e.node, e.target, ev.target.value)
  }

  for (const it of ir.interactions) {
    if (it.on.node !== node.nodeId) continue
    const ev = EVENT_PROP[it.on.trigger.type]
    if (ev) props[ev] = () => fire(it)
  }

  let children: ReactNode
  if (node.slot) {
    const activeId = activeSlotView(slots, node.nodeId, node.slot.activeView)
    const view = activeId ? node.slot.views[activeId] : undefined
    children = view ? renderNode(view, env, ir, fire, edit, slots) : null
  } else if (textChild !== undefined) children = asText(textChild)
  else if (node.children) children = node.children.map((c, i) => renderNode(c, env, ir, fire, edit, slots, i))
  else children = node.text ?? null

  // A void tag (an <input>, say) must be created WITHOUT children — passing any
  // is a React error, and an editable field is exactly this case.
  if (VOID_TAGS.has(node.tag)) return createElement(node.tag, props)

  return createElement(node.tag, props, children)
}
