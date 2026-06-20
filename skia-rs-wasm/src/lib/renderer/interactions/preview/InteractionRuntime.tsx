/**
 * InteractionRuntime — renders a PageInteractions IR as a LIVE interactive React
 * tree (the "preview mode"). Thin wrapper over the pure runtime core: state lives
 * in `useState`, the presentation `PNode` tree is walked into real elements with
 * bound props, event handlers, and repeaters. Every element keeps its
 * `data-node-id` anchor so what you click maps back to the design node.
 */

import { useMemo, useState, createElement, type ReactNode } from 'react'
import type { PageInteractions, Interaction } from '../ir'
import { STYLE_PROPS, type PNode } from '../compile/emit-react'
import { parse, evaluate } from '../expression'
import { initRuntime, buildEnv, runInteraction, type RuntimeState } from './runtime'

type Env = Record<string, unknown>

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

export function InteractionRuntime({ ir, root }: { ir: PageInteractions; root: PNode }) {
  const [rt, setRt] = useState<RuntimeState>(() => initRuntime(ir))
  const env = useMemo(() => buildEnv(ir, rt), [ir, rt])
  // recompute env from the *current* state inside the updater to avoid staleness
  const fire = (it: Interaction) => setRt((cur) => runInteraction(ir, cur, it, buildEnv(ir, cur)))
  return <>{renderNode(root, env, ir, fire)}</>
}

function renderNode(node: PNode, env: Env, ir: PageInteractions, fire: (it: Interaction) => void, key?: number | string): ReactNode {
  const rep = ir.repeaters.find((r) => r.node === node.nodeId)
  if (rep) {
    const as = rep.as ?? 'item'
    const coll = asArray(safeEval(rep.over, env))
    return coll.map((item, i) => {
      const itemEnv: Env = { ...env, [as]: item }
      const k = rep.key ? safeEval(rep.key, itemEnv) : isRecord(item) && 'id' in item ? (item.id as string) : i
      return renderElement(node, itemEnv, ir, fire, true, k ?? i)
    })
  }
  return renderElement(node, env, ir, fire, false, key)
}

function renderElement(
  node: PNode,
  env: Env,
  ir: PageInteractions,
  fire: (it: Interaction) => void,
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

  for (const it of ir.interactions) {
    if (it.on.node !== node.nodeId) continue
    const ev = EVENT_PROP[it.on.trigger.type]
    if (ev) props[ev] = () => fire(it)
  }

  let children: ReactNode
  if (textChild !== undefined) children = asText(textChild)
  else if (node.children) children = node.children.map((c, i) => renderNode(c, env, ir, fire, i))
  else children = node.text ?? null

  return createElement(node.tag, props, children)
}
