/**
 * emit-react — the Phase 0 web emitter: interaction IR → idiomatic React source.
 *
 * Behavior (deterministic, generated entirely from the IR):
 *   - local variables   -> `useState` hooks
 *   - self variant state -> a `useState` per node
 *   - derived values     -> `const x = <expr>`  (via expression.toJs)
 *   - interactions       -> handler functions; actions lower per catalog `lowers`
 *   - bindings           -> JSX prop / child expressions
 *   - repeaters          -> `over.map((item) => <template/>)`
 *
 * Presentation (the JSX structure) is supplied as a `PNode` tree — a stand-in for
 * AI-generated markup. The emitter weaves behavior onto it by node id and emits a
 * `data-node-id` anchor on every node (the contract the Task 5 validation pass
 * enforces). Only the web lowering is implemented in Phase 0; the `native`
 * emitter is an additive sibling.
 */

import type { PageInteractions, NodeId, ValueType, Action, Repeater } from '../ir'
import { getAction } from '../catalog'
import { parse, toJs } from '../expression'
import { parseRefPath } from '../addressing'
import { anchorAttr, instanceKeyAttr } from '../anchor'

/**
 * Slot presentation — a router-outlet descriptor carried by a slot PNode.
 *
 * A slot owns no children; it *references* candidate view frames, one of which
 * renders at a time. `views` holds each candidate's already-projected subtree
 * (keyed by view-frame id) so the runtime can swap between them without another
 * document walk (the repeater pattern: template available, selection at render
 * time). `activeView` is the design-time default — the runtime's `slotViews`
 * override wins over it when a `show-in-slot` action has fired.
 */
export interface SlotPresentation {
  activeView?: string
  views: Record<string, PNode>
}

/**
 * Present iff this node is a component copy. The copy emits as a call —
 * `<Button label="Save" />` — instead of its subtree being inlined, and
 * `definition` carries the main's projected subtree so the component function
 * can be emitted once alongside the page.
 *
 * This is the whole reason properties are *declared*: an undeclared override
 * would have to compile to an inline style on this one instance, whereas a
 * declared one compiles to a named prop.
 */
export interface ComponentPresentation {
  name: string
  /** Resolved values keyed by prop name (declared defaults already filled in). */
  props: Record<string, unknown>
  definition?: PNode
  /** Prop names in declaration order — the component function's parameters. */
  propNames?: string[]
}

/** Minimal presentation node (stand-in for parsed AI JSX). */
export interface PNode {
  nodeId: NodeId
  tag: string
  text?: string
  children?: PNode[]
  /** Static inline style carried from the design shape (e.g. fill → background). */
  style?: Record<string, string>
  /** Present iff this node is a slot; carries its projected candidate views. */
  slot?: SlotPresentation
  /** Present iff this node is a component copy; see {@link ComponentPresentation}. */
  component?: ComponentPresentation
  /**
   * Raw expression to emit as this node's content, instead of `text`. Used inside
   * a component definition so a text prop's target reads `{label}` rather than the
   * main's literal string.
   */
  textExpr?: string
  /** Raw condition guarding this node — a boolean prop's target renders behind it. */
  whenExpr?: string
}

export interface EmitOptions {
  componentName?: string
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_')
const setterName = (varId: string) => `set${cap(ident(varId))}`
const handlerName = (node: string, trigger: string) => `handle_${ident(node)}_${ident(trigger)}`
const stateSetter = (node: string) => `set${cap(ident(node))}State`
const stateGetter = (node: string) => `${ident(node)}State`

/** Web event prop for a node-scoped trigger. */
const EVENT_PROP: Record<string, string> = {
  press: 'onClick',
  'mouse-enter': 'onMouseEnter',
  'mouse-leave': 'onMouseLeave',
}

/**
 * Binding props that are CSS, so they merge into the element's inline `style`
 * (overriding the static fill) instead of becoming raw element props. Shared with
 * the preview runtime so both render a wired fill/colour identically.
 */
export const STYLE_PROPS = new Set(['background', 'backgroundColor', 'color', 'opacity', 'visibility', 'display', 'borderColor'])

function tsType(vt: ValueType): string {
  if (typeof vt === 'object') return `${tsType(vt.collection)}[]`
  switch (vt) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'any'
  }
}

function emitAction(a: Action): string {
  const targetRoot = a.target ? parseRefPath(a.target).root : ''
  const value = a.value ? toJs(parse(a.value)) : 'undefined'
  switch (a.type) {
    case 'collection.append':
      return `${setterName(targetRoot)}((prev) => [...prev, ${value}])`
    case 'collection.remove':
      return `${setterName(targetRoot)}((prev) => prev.filter((item) => !(${value})))`
    case 'set-variable':
      return `${setterName(targetRoot)}(${value})`
    case 'node.setState':
      return `${stateSetter(targetRoot)}(${value})`
    case 'open-url':
      return `window.open(${value})`
    default: {
      const entry = getAction(a.type)
      return entry?.lowers === 'switch'
        ? `/* TODO(web emit): navigation '${a.type}' */`
        : `/* TODO(web emit): action '${a.type}' */`
    }
  }
}

export function emitReactComponent(ir: PageInteractions, root: PNode, opts: EmitOptions = {}): string {
  const name = opts.componentName ?? 'Page'

  const hooks: string[] = []
  for (const v of ir.variables) {
    if (v.source !== 'local') continue
    hooks.push(`const [${ident(v.id)}, ${setterName(v.id)}] = useState<${tsType(v.type)}>(${JSON.stringify(v.initial)})`)
  }
  for (const s of ir.states) {
    if ('from' in s.active && s.active.from === 'self') {
      const init = JSON.stringify(s.active.initial ?? s.states[0] ?? '')
      hooks.push(`const [${stateGetter(s.node)}, ${stateSetter(s.node)}] = useState<string>(${init})`)
    }
  }

  const derived = ir.derived.map((d) => `const ${ident(d.id)} = ${toJs(parse(d.expr))}`)

  const handlers = ir.interactions.map((it) => {
    const stmts = it.do.map(emitAction)
    let body: string
    if (it.if) body = `  if (${toJs(parse(it.if))}) {\n${stmts.map((s) => '    ' + s).join('\n')}\n  }`
    else body = stmts.map((s) => '  ' + s).join('\n')
    return `const ${handlerName(it.on.node, it.on.trigger.type)} = () => {\n${body}\n}`
  })

  const imports = hooks.length ? `import { useState } from 'react'\n\n` : ''

  const bodyLines: string[] = [...hooks, ...derived]
  if (handlers.length) bodyLines.push('', ...handlers)

  // Component definitions are emitted once each, ahead of the page, and every
  // copy in the tree becomes a call to one.
  const defs = new Map<string, ComponentPresentation>()
  collectComponentDefs(root, defs)
  const componentFns = [...defs.values()].map(emitComponentFn)

  const jsx = emitNode(root, ir)
  const indentedBody = bodyLines
    .map((l) => (l === '' ? '' : l.split('\n').map((x) => '  ' + x).join('\n')))
    .join('\n')
  const indentedJsx = jsx
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')

  const prelude = componentFns.length ? `${componentFns.join('\n\n')}\n\n` : ''
  return `${imports}${prelude}export function ${name}() {\n${indentedBody}\n\n  return (\n${indentedJsx}\n  )\n}\n`
}

/** Walk the tree gathering one definition per component name (first wins). */
function collectComponentDefs(node: PNode, into: Map<string, ComponentPresentation>): void {
  const component = node.component
  if (component?.definition && !into.has(component.name)) {
    into.set(component.name, component)
    collectComponentDefs(component.definition, into)
  }
  for (const child of node.children ?? []) collectComponentDefs(child, into)
  for (const view of Object.values(node.slot?.views ?? {})) collectComponentDefs(view, into)
}

/**
 * A component function. Its body is emitted with an empty interaction set:
 * bindings and handlers are authored per page today, and weaving them through a
 * component boundary is its own problem.
 */
function emitComponentFn(component: ComponentPresentation): string {
  const empty: PageInteractions = {
    variables: [],
    derived: [],
    states: [],
    interactions: [],
    bindings: [],
    repeaters: [],
  } as unknown as PageInteractions
  const params = component.propNames?.length ? `{ ${component.propNames.map(ident).join(', ')} }` : ''
  const body = emitNode(component.definition!, empty)
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')
  return `function ${component.name}(${params}) {\n  return (\n${body}\n  )\n}`
}

/** `<Button data-node-id="…" label={"Save"} />` — a copy calls its component. */
function emitComponentCall(node: PNode, component: ComponentPresentation): string {
  const props = [anchorAttr(node.nodeId)]
  for (const [key, value] of Object.entries(component.props)) {
    props.push(`${ident(key)}={${JSON.stringify(value)}}`)
  }
  return `<${component.name} ${props.join(' ')} />`
}

function emitNode(node: PNode, ir: PageInteractions): string {
  const rep = ir.repeaters.find((r) => r.node === node.nodeId)
  const el = emitElement(node, ir, rep)
  // A boolean prop's target renders behind its condition.
  if (node.whenExpr) {
    const inner = el
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')
    const guarded = `{${node.whenExpr} && (\n${inner}\n)}`
    if (!rep) return guarded
  }
  if (!rep) return el
  const as = rep.as ?? 'item'
  const inner = el
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  return `{${rep.over}.map((${as}) => (\n${inner}\n))}`
}

function emitElement(node: PNode, ir: PageInteractions, rep?: Repeater): string {
  // A copy emits as a call to its component, not as its own subtree.
  if (node.component) return emitComponentCall(node, node.component)

  const props: string[] = [anchorAttr(node.nodeId)]
  if (rep) {
    const as = rep.as ?? 'item'
    const keyExpr = rep.key ? toJs(parse(rep.key)) : `${as}.id`
    props.push(`key={${keyExpr}}`, instanceKeyAttr(keyExpr))
  }

  // style starts from the static fill; CSS-prop bindings override it (as expressions).
  const styleMap = new Map<string, string>()
  if (node.style) for (const [k, v] of Object.entries(node.style)) styleMap.set(k, JSON.stringify(v))

  let textChild: string | undefined
  for (const b of ir.bindings) {
    if (b.node !== node.nodeId) continue
    const expr = toJs(parse(b.from))
    if (b.prop === 'text' || b.prop === 'children') textChild = expr
    else if (STYLE_PROPS.has(b.prop)) styleMap.set(b.prop, expr)
    else props.push(`${b.prop}={${expr}}`)
  }

  for (const it of ir.interactions) {
    if (it.on.node !== node.nodeId) continue
    const ev = EVENT_PROP[it.on.trigger.type]
    if (ev) props.push(`${ev}={${handlerName(it.on.node, it.on.trigger.type)}}`)
  }

  if (styleMap.size) {
    const entries = [...styleMap].map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(', ')
    props.push(`style={{ ${entries} }}`)
  }

  // A slot renders its active view's subtree. Phase-0 code gen is a static
  // snapshot (the design-time default); runtime view-switching lowers later.
  const slotDefault = node.slot ? node.slot.views[node.slot.activeView ?? ''] : undefined
  const childSource = slotDefault ? [slotDefault] : (node.children ?? [])
  const childNodes = childSource.map((c) => emitNode(c, ir))
  const open = `<${node.tag} ${props.join(' ')}>`
  const close = `</${node.tag}>`

  let inner: string
  if (textChild !== undefined) inner = `{${textChild}}`
  // Inside a component definition, a text prop's target reads from the prop
  // rather than carrying the main's literal string.
  else if (node.textExpr) inner = `{${node.textExpr}}`
  else if (childNodes.length) inner = childNodes.join('\n')
  else inner = node.text ?? ''

  if (inner.includes('\n')) {
    const indented = inner
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')
    return `${open}\n${indented}\n${close}`
  }
  return `${open}${inner}${close}`
}
