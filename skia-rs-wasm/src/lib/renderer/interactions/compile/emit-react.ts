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
import { actionParam } from '../ir'
import { getAction } from '../catalog'
import { parse, toJs, objectBodyJs } from '../expression'
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
 * What a node MEANS, independent of any platform. The presentation carries this
 * rather than an HTML tag, because there is no `<input>` in React Native — each
 * target maps roles to its own components (`field` → `input` on web,
 * `TextInput` on native).
 *
 * Roles are always DERIVED, never authored: see `deriveRole`. An explicit role
 * would be a second source of truth able to contradict the behaviour ("this is
 * a field" on a node that edits nothing), which is the same category error as a
 * node-level repeat toggle.
 */
export type NodeRole = 'container' | 'text' | 'button' | 'field' | 'list' | 'item' | 'image' | 'link'

/**
 * The web target's vocabulary. Almost everything is a BOX: a semantic element is
 * used only where it does work a div cannot. `<input>` is the one hard case —
 * a div is not typeable, and contentEditable has no value semantics, no
 * onChange, no control of the mobile keyboard and broken IME, so two-way
 * binding would have nothing to bind to.
 *
 * Everything else — buttons, links, lists — is a div whose behaviour is emitted
 * explicitly (see `a11yPropsFor`), so appearance comes from the design alone
 * with no user-agent styling to undo. A react-native target supplies its own
 * table, and the split lands in the same place there: View/Text everywhere,
 * Pressable and TextInput for these two.
 */
const ROLE_TAG: Record<NodeRole, string> = {
  container: 'div',
  text: 'span',
  button: 'div',
  field: 'input',
  list: 'div',
  item: 'div',
  image: 'img',
  link: 'div',
}

/** ARIA role carrying the semantics the element used to imply. */
const ARIA_ROLE: Partial<Record<NodeRole, string>> = {
  button: 'button',
  link: 'link',
  list: 'list',
  item: 'listitem',
}

/** Roles that must be reachable and activatable from the keyboard. */
const ACTIVATABLE = new Set<NodeRole>(['button', 'link'])

export const tagForRole = (role: NodeRole): string => ROLE_TAG[role] ?? 'div'

/**
 * Styles the platform needs that the DESIGN does not express. These land beneath
 * the design's own values, so anything the designer specified still wins.
 *
 * Now that nearly everything is a box there is almost nothing to undo — the one
 * exception is `<input>`, which is the only element we still emit that arrives
 * dressed. `cursor` is not styling the design is withholding; it is interaction
 * feedback a box cannot express.
 */
export function baseStyleFor(role: NodeRole): Record<string, string> {
  // the design's width means the OUTER box, so a border must not inflate it
  const base: Record<string, string> = { boxSizing: 'border-box' }
  if (ACTIVATABLE.has(role)) base.cursor = 'pointer'
  if (role === 'field') {
    Object.assign(base, {
      appearance: 'none',
      background: 'none',
      border: '0',
      padding: '0',
      margin: '0',
      font: 'inherit',
      color: 'inherit',
    })
  }
  return base
}

/**
 * The behaviour a semantic element would have provided, emitted explicitly.
 * A div with an onClick is not a button: it is not a tab stop, it is not
 * activatable by Enter or Space, and a screen reader does not announce it. These
 * props put that back. `activatable` is false when nothing is authored on the
 * node, so a decorative box is not announced as a broken button.
 */
export function a11yPropsFor(role: NodeRole, activatable: boolean): Record<string, string | number> {
  const props: Record<string, string | number> = {}
  const aria = ARIA_ROLE[role]
  if (aria) props.role = aria
  if (ACTIVATABLE.has(role) && activatable) props.tabIndex = 0
  return props
}

/**
 * A field's control type comes from the TYPE OF THE CELL IT EDITS — wire a node
 * to a boolean and it is a checkbox. No enum to keep in sync with the variable.
 * Returns undefined when the default (text) applies.
 */
export function inputTypeFor(ir: PageInteractions, nodeId: NodeId): string | undefined {
  const editable = ir.editable.find((e) => e.node === nodeId)
  if (!editable) return undefined
  const type = ir.variables.find((v) => v.id === editable.target)?.type
  if (type === 'boolean') return 'checkbox'
  if (type === 'number') return 'number'
  return undefined
}

/** Keys that activate each role — Space scrolls the page on a link, so Enter only. */
export const ACTIVATION_KEYS: Partial<Record<NodeRole, string[]>> = {
  button: ['Enter', ' '],
  link: ['Enter'],
}

/** Minimal presentation node (stand-in for parsed AI JSX). */
export interface PNode {
  nodeId: NodeId
  role: NodeRole
  text?: string
  children?: PNode[]
  /** Static inline style carried from the design shape (e.g. fill → background). */
  style?: Record<string, string>
  /** Present iff this node is a slot; carries its projected candidate views. */
  slot?: SlotPresentation
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

/** HTML elements that take no children — React errors if you give them any. */
export const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'source', 'area', 'col', 'embed', 'track', 'wbr'])

/**
 * How the web reports a value change. The react-native target swaps this for
 * `onChangeText`, which hands the value over directly instead of wrapping it in
 * an event — per-target vocabulary, not a change to the IR.
 */
const CHANGE_EVENT = { prop: 'onChange', read: 'e.target.value' }

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

/**
 * Lower one action to a JS statement. Exported so the catalog-parity tests can
 * check each entry against the preview runtime's `applyAction` directly.
 */
export function emitAction(a: Action): string {
  const targetRoot = a.target ? parseRefPath(a.target).root : ''
  const value = a.value ? toJs(parse(a.value)) : 'undefined'
  const set = setterName(targetRoot)
  switch (a.type) {
    case 'collection.append':
      return `${set}((prev) => [...prev, ${value}])`
    case 'collection.insert': {
      const at = actionParam(a, 'at')
      const i = at ? toJs(parse(at)) : '0'
      return `${set}((prev) => [...prev.slice(0, ${i}), ${value}, ...prev.slice(${i})])`
    }
    case 'collection.remove':
      return `${set}((prev) => prev.filter((item) => !(${value})))`
    case 'collection.update': {
      // An object-literal value is a patch (spliced into a spread merge so the
      // generated line reads like hand-written React); anything else replaces;
      // no value leaves the item alone. Mirrored by `applyAction`, which
      // branches on the same AST check.
      let next: string
      if (!a.value) next = 'item'
      else {
        const body = objectBodyJs(parse(a.value))
        next = body === undefined ? value : body ? `{ ...item, ${body} }` : 'item'
      }
      const where = actionParam(a, 'where')
      const mapped = where ? `${toJs(parse(where))} ? ${next} : item` : next
      // The arrow body is ALWAYS parenthesized: an unwrapped `{ ...item, x: 1 }`
      // parses as a block statement, not an object literal.
      return `${set}((prev) => prev.map((item) => (${mapped})))`
    }
    case 'collection.clear':
      return `${set}([])`
    case 'set-variable':
      return `${set}(${value})`
    case 'toggle-variable':
      return `${set}((prev) => !prev)`
    case 'increment':
      return `${set}((prev) => prev + ${a.value ? value : '1'})`
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

  // Emitted once, and only when a box-button or box-link exists: keyboard
  // activation is what a real <button> was giving us for free.
  const jsxNeedsActivate = /onKeyDown=\{onActivate\(/
  const helper =
    '/** Enter/Space activation for role="button" and role="link" boxes. */\n' +
    'const onActivate = (fn: () => void, keys: string[]) => (e: { key: string; preventDefault: () => void }) => {\n' +
    '  if (keys.includes(e.key)) {\n    e.preventDefault()\n    fn()\n  }\n}\n\n'

  const bodyLines: string[] = [...hooks, ...derived]
  if (handlers.length) bodyLines.push('', ...handlers)

  const jsx = emitNode(root, ir)
  const indentedBody = bodyLines
    .map((l) => (l === '' ? '' : l.split('\n').map((x) => '  ' + x).join('\n')))
    .join('\n')
  const indentedJsx = jsx
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')

  const prelude = jsxNeedsActivate.test(jsx) ? helper : ''
  return `${imports}${prelude}export function ${name}() {\n${indentedBody}\n\n  return (\n${indentedJsx}\n  )\n}\n`
}

function emitNode(node: PNode, ir: PageInteractions): string {
  const rep = ir.repeaters.find((r) => r.node === node.nodeId)
  const el = emitElement(node, ir, rep)
  if (!rep) return el
  const as = rep.as ?? 'item'
  const inner = el
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  return `{${rep.over}.map((${as}) => (\n${inner}\n))}`
}

function emitElement(node: PNode, ir: PageInteractions, rep?: Repeater): string {
  const props: string[] = [anchorAttr(node.nodeId)]
  if (rep) {
    const as = rep.as ?? 'item'
    const keyExpr = rep.key ? toJs(parse(rep.key)) : `${as}.id`
    props.push(`key={${keyExpr}}`, instanceKeyAttr(keyExpr))
  }

  // Style order is the precedence order: the browser's defaults are neutralized
  // first, then the design's own values, then any bound expression.
  const styleMap = new Map<string, string>()
  for (const [k, v] of Object.entries(baseStyleFor(node.role))) styleMap.set(k, JSON.stringify(v))
  if (node.style) for (const [k, v] of Object.entries(node.style)) styleMap.set(k, JSON.stringify(v))

  let textChild: string | undefined
  for (const b of ir.bindings) {
    if (b.node !== node.nodeId) continue
    const expr = toJs(parse(b.from))
    if (b.prop === 'text' || b.prop === 'children') textChild = expr
    else if (STYLE_PROPS.has(b.prop)) styleMap.set(b.prop, expr)
    else props.push(`${b.prop}={${expr}}`)
  }

  // Two-way: the read is a value prop, the write is a change handler. Emitted as
  // the controlled-component pattern a React developer would have written.
  for (const e of ir.editable) {
    if (e.node !== node.nodeId) continue
    const inputType = inputTypeFor(ir, node.nodeId)
    if (inputType) props.push(`type="${inputType}"`)
    props.push(`${e.prop}={${ident(e.target)}}`)
    props.push(`${CHANGE_EVENT.prop}={(e) => ${setterName(e.target)}(${CHANGE_EVENT.read})}`)
  }

  let pressHandler: string | undefined
  for (const it of ir.interactions) {
    if (it.on.node !== node.nodeId) continue
    const ev = EVENT_PROP[it.on.trigger.type]
    if (!ev) continue
    const fn = handlerName(it.on.node, it.on.trigger.type)
    if (it.on.trigger.type === 'press') pressHandler = fn
    props.push(`${ev}={${fn}}`)
  }

  // A div with an onClick is not a button — put back what the element gave us.
  for (const [k, v] of Object.entries(a11yPropsFor(node.role, !!pressHandler))) {
    props.push(typeof v === 'number' ? `${k}={${v}}` : `${k}="${v}"`)
  }
  const keys = ACTIVATION_KEYS[node.role]
  if (keys && pressHandler) props.push(`onKeyDown={onActivate(${pressHandler}, ${JSON.stringify(keys)})}`)

  if (styleMap.size) {
    const entries = [...styleMap].map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(', ')
    props.push(`style={{ ${entries} }}`)
  }

  // A slot renders its active view's subtree. Phase-0 code gen is a static
  // snapshot (the design-time default); runtime view-switching lowers later.
  const slotDefault = node.slot ? node.slot.views[node.slot.activeView ?? ''] : undefined
  const childSource = slotDefault ? [slotDefault] : (node.children ?? [])
  const childNodes = childSource.map((c) => emitNode(c, ir))

  const tag = tagForRole(node.role)

  // A void tag is self-closing and cannot carry children; an <input> with a text
  // child is a React error, not a styling quirk.
  if (VOID_TAGS.has(tag)) return `<${tag} ${props.join(' ')} />`

  const open = `<${tag} ${props.join(' ')}>`
  const close = `</${tag}>`

  let inner: string
  if (textChild !== undefined) inner = `{${textChild}}`
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
