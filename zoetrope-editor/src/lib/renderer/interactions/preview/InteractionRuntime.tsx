/**
 * InteractionRuntime — renders a PageInteractions IR as a LIVE interactive React
 * tree (the "preview mode"). Thin wrapper over the pure runtime core: state lives
 * in `useState`, the presentation `PNode` tree is walked into real elements with
 * bound props, event handlers, and repeaters. Every element keeps its
 * `data-node-id` anchor so what you click maps back to the design node.
 */

import { useEffect, useMemo, useState, createElement, type ReactNode } from 'react'
import type { PageInteractions, Interaction } from '../ir'
import { cellRef, editedCell, refsOf, REPEAT_PROP, VALUE_PROP } from '../ir'
import {
  STYLE_PROPS,
  VOID_TAGS,
  tagForRole,
  inputTypeFor,
  baseStyleFor,
  type PNode,
} from '../compile/emit-react'
import { parse, evaluate } from '../expression'
import {
  initRuntime,
  buildEnv,
  runInteraction,
  activeSlotView,
  diffRuntime,
  affectedNodes,
  repeatOf,
  type RuntimeState,
  type ActivityEntry,
} from './runtime'

type Env = Record<string, unknown>

/** Write half of an edited cell: node id, the cell's key, new value. */
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

  /** The write half of an edited cell: a discrete event folding into it. */
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
  const rep = repeatOf(ir, node.nodeId)
  if (rep) {
    const coll = asArray(safeEval(rep.over, env))
    return coll.map((item, i) => {
      const itemEnv: Env = { ...env, [rep.as]: item }
      const k = rep.key ? safeEval(rep.key, itemEnv) : isRecord(item) && 'id' in item ? item.id : i
      const key = typeof k === 'string' || typeof k === 'number' ? k : i
      return renderElement(node, itemEnv, ir, fire, edit, slots, true, key)
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
  // Browser defaults neutralized first, then the design's own values — the
  // preview and the emitted component apply the same precedence.
  const style: Record<string, unknown> = { ...baseStyleFor(node.role), ...(node.style ?? {}) }
  if (key !== undefined) {
    props.key = key
    // Only true repeater instances carry data-instance-key (anchor contract);
    // plain keyed children get a React key but no instance anchor.
    if (instance) props['data-instance-key'] = key
  }

  const refs = refsOf(ir, node.nodeId)
  const edited = editedCell(ir, node.nodeId)
  let textChild: unknown
  for (const [prop, from] of Object.entries(refs?.props ?? {})) {
    if (prop === REPEAT_PROP) continue
    if (prop === VALUE_PROP && edited) continue
    const val = safeEval(from, env)
    if (prop === 'text' || prop === 'children') textChild = val
    else if (STYLE_PROPS.has(prop)) style[prop] = val
    else props[prop] = val
  }
  if (Object.keys(style).length) props.style = style

  // Edited cell: read it into the value prop, write the change back into it.
  if (edited) {
    const key = cellRef(edited)
    const inputType = inputTypeFor(ir, node.nodeId)
    if (inputType) props.type = inputType
    props[VALUE_PROP] = safeEval(key, env) ?? ''
    props.onChange = (ev: { target: { value: unknown } }) => edit(node.nodeId, key, ev.target.value)
  }

  // Only the events the design authored — matching the emitted code, which adds
  // no role, tab stop or keyboard activation on top of an authored click.
  for (const it of ir.interactions) {
    if (it.on.node !== node.nodeId) continue
    const ev = EVENT_PROP[it.on.trigger.type]
    if (!ev) continue
    props[ev] = () => fire(it)
  }

  let children: ReactNode
  if (node.slot) {
    const activeId = activeSlotView(slots, node.nodeId, node.slot.activeView)
    const view = activeId ? node.slot.views[activeId] : undefined
    children = view ? renderNode(view, env, ir, fire, edit, slots) : null
  } else if (textChild !== undefined) children = asText(textChild)
  else if (node.children) children = node.children.map((c, i) => renderNode(c, env, ir, fire, edit, slots, i))
  else children = node.text ?? null

  const tag = tagForRole(node.role)

  // A void tag (an <input>, say) must be created WITHOUT children — passing any
  // is a React error, and an editable field is exactly this case.
  if (VOID_TAGS.has(tag)) return createElement(tag, props)

  return createElement(tag, props, children)
}
