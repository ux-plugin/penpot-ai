/**
 * emit-react — the Phase 0 web emitter: interaction IR → idiomatic React source.
 *
 * Behavior (deterministic, generated entirely from the IR):
 *   - outside cells      -> props, plus an `onXChange` callback if written
 *   - design-owned cells -> `useState` hooks
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

import type { PageInteractions, NodeId, ValueType, Action, ActionType, Repeater } from '../ir'
import { actionParam, isBacked } from '../ir'
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
 * Everything else — buttons, links, lists — is a plain div carrying only what
 * the design authored (its style, its onClick). Nothing about being a "button"
 * is added on top: no ARIA role, no tab stop, no keyboard activation, no cursor.
 * Those are affordances the DESIGNER authors as interactions (an on-hover that
 * sets the cursor, and so on) or that the receiving codebase supplies — never
 * guessed here. A react-native target supplies its own tag table; the one split
 * that survives is the typeable element (`<input>` / `TextInput`).
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

export const tagForRole = (role: NodeRole): string => ROLE_TAG[role] ?? 'div'

/**
 * The ONLY styles emitted that the design didn't author, and both exist to make
 * the box match the design rather than to add anything to it:
 *   - `boxSizing: border-box` so a border counts inside the design's width;
 *   - the `<input>` reset, because it is the one element that still arrives with
 *     user-agent chrome that would otherwise sit on top of the design.
 *
 * Nothing here is an affordance or a behaviour. A pointer cursor, a hover effect,
 * a focus ring — those are things the DESIGNER authors as interactions on the
 * node (an on-hover that sets the cursor), never guessed here.
 */
export function baseStyleFor(role: NodeRole): Record<string, string> {
  // the design's width means the OUTER box, so a border must not inflate it
  const base: Record<string, string> = { boxSizing: 'border-box' }
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

/** Cells the design WRITES — every action target plus every two-way field. */
function writtenCells(ir: PageInteractions): Set<string> {
  const written = new Set<string>()
  const add = (target: string | undefined) => {
    if (!target) return
    try {
      written.add(parseRefPath(target).root)
    } catch {
      /* an unparseable target is an addressing error, reported elsewhere */
    }
  }
  for (const it of ir.interactions) for (const a of it.do) add(a.target)
  for (const ar of ir.appRules) for (const a of ar.do) add(a.target)
  for (const e of ir.editable) add(e.target)
  return written
}

/** Callback prop name derived for a written outside cell. */
const changeProp = (cellId: string) => `on${cap(ident(cellId))}Change`

/**
 * The props interface — ENTIRELY DERIVED from which cells are outside-backed and
 * which of those the design writes. Nothing here was authored:
 *
 *   - an outside cell becomes a value prop;
 *   - an outside cell the design also WRITES additionally becomes an
 *     `onXChange` callback, because a write to a value you don't own has to be
 *     reported to whoever does.
 *
 * That second rule is the whole "events are indirectly built" idea in one place.
 * The designer said "when clicked, add to cart.items"; they never declared an
 * `onAddToCart`, and this is where one appears — as plumbing, at lowering, where
 * a different target (a store, a mutation, a query invalidation) could just as
 * well be chosen instead.
 *
 * Each prop carries the cell's description and sample as a doc comment, which is
 * not decoration: `object` widens to `any`, so the sample is the only surviving
 * statement of the expected shape. Whoever binds this — a person or a model —
 * reads the comment, not the type.
 */
function emitPropsType(ir: PageInteractions, name: string): { decl: string; params: string } | undefined {
  const backed = ir.variables.filter(isBacked)
  if (!backed.length) return undefined
  const written = writtenCells(ir)

  const lines: string[] = []
  const params: string[] = []
  for (const v of backed) {
    const notes: string[] = []
    if (v.description) notes.push(v.description)
    if (v.initial !== undefined && v.initial !== null) notes.push(`e.g. ${JSON.stringify(v.initial)}`)
    if (notes.length) lines.push(`  /** ${notes.join(' — ')} */`)
    lines.push(`  ${ident(v.id)}: ${tsType(v.type)}`)
    params.push(ident(v.id))

    if (written.has(v.id)) {
      lines.push(`  /** the design changes ${v.id}; tell whoever owns it */`)
      lines.push(`  ${changeProp(v.id)}: (next: ${tsType(v.type)}) => void`)
      params.push(changeProp(v.id))
    }
  }

  const decl = `interface ${name}Props {\n${lines.join('\n')}\n}\n\n`
  // Destructured, so a cell reads as a bare identifier in every expression the
  // emitter already produces — no `props.` prefix to thread through toJs.
  return { decl, params: `{ ${params.join(', ')} }: ${name}Props` }
}

/**
 * How a write reaches the cell it targets — the seam that makes "the designer
 * writes a cell, the plumbing is derived" real.
 *
 * A design-owned cell is React state, so the write is `setX((prev) => next)` and
 * `prev` is React's. A cell backed from outside has no local state to update: the
 * write is a report to whoever owns it, so it becomes `onXChange(next)` and the
 * current value is read straight off the prop. Same authored action, two
 * lowerings, neither of them named by the designer.
 */
export interface CellWriter {
  /** Identifier standing for the cell's current value. */
  prev: string
  /** Deliver a next value computed from `prev`. */
  deliver: (next: string) => string
}

const localWriter = (cellId: string): CellWriter => ({
  prev: 'prev',
  deliver: (next) => (next === 'prev' ? `${setterName(cellId)}(prev)` : `${setterName(cellId)}((prev) => ${next})`),
})

const plainWriter = (cellId: string): CellWriter => ({
  prev: 'prev',
  deliver: (next) => `${setterName(cellId)}(${next})`,
})

const outsideWriter = (cellId: string): CellWriter => ({
  prev: ident(cellId),
  deliver: (next) => `${changeProp(cellId)}(${next})`,
})

/** The writer for `target`, chosen by whether the design owns that cell. */
export function writerFor(ir: PageInteractions, target: string | undefined, dependsOnPrev: boolean): CellWriter {
  let root = ''
  try {
    root = target ? parseRefPath(target).root : ''
  } catch {
    root = ''
  }
  if (ir.variables.some((v) => v.id === root && isBacked(v))) return outsideWriter(root)
  return dependsOnPrev ? localWriter(root) : plainWriter(root)
}

/** Whether an action's next value is computed from the cell's current one. */
export function readsPrev(type: ActionType): boolean {
  return (
    type === 'collection.append' ||
    type === 'collection.insert' ||
    type === 'collection.remove' ||
    type === 'collection.update' ||
    type === 'toggle-variable' ||
    type === 'increment'
  )
}

/**
 * Lower one action to a JS statement. Exported so the catalog-parity tests can
 * check each entry against the preview runtime's `applyAction` directly.
 *
 * `writer` defaults to plain React state, which is what the parity tests exercise;
 * `emitReactComponent` passes one chosen per target via `writerFor`.
 */
export function emitAction(a: Action, writer?: CellWriter): string {
  const targetRoot = a.target ? parseRefPath(a.target).root : ''
  const value = a.value ? toJs(parse(a.value)) : 'undefined'
  const w = writer ?? (readsPrev(a.type) ? localWriter(targetRoot) : plainWriter(targetRoot))
  const prev = w.prev
  const set = (v: string) => w.deliver(v)
  switch (a.type) {
    case 'collection.append':
      return set(`[...${prev}, ${value}]`)
    case 'collection.insert': {
      const at = actionParam(a, 'at')
      const i = at ? toJs(parse(at)) : '0'
      return set(`[...${prev}.slice(0, ${i}), ${value}, ...${prev}.slice(${i})]`)
    }
    case 'collection.remove':
      return set(`${prev}.filter((item) => !(${value}))`)
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
      return set(`${prev}.map((item) => (${mapped}))`)
    }
    case 'collection.clear':
      return set('[]')
    case 'set-variable':
      return set(value)
    case 'toggle-variable':
      return set(`!${prev}`)
    case 'increment':
      return set(`${prev} + ${a.value ? value : '1'}`)
    case 'node.setState':
      // Variant state is always the design's own — a node's state is not a cell
      // anyone outside could supply, so there is no writer to choose.
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
    // A store cell arrives as a prop, so it gets no hook — its value already
    // exists under the same identifier, which is why every expression the emitter
    // produces works unchanged either way.
    if (isBacked(v)) continue
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
    const stmts = it.do.map((a) => emitAction(a, writerFor(ir, a.target, readsPrev(a.type))))
    let body: string
    if (it.if) body = `  if (${toJs(parse(it.if))}) {\n${stmts.map((s) => '    ' + s).join('\n')}\n  }`
    else body = stmts.map((s) => '  ' + s).join('\n')
    return `const ${handlerName(it.on.node, it.on.trigger.type)} = () => {\n${body}\n}`
  })

  const imports = hooks.length ? `import { useState } from 'react'\n\n` : ''

  const bodyLines: string[] = [...hooks, ...derived]
  // The blank line separates handlers from state — with no state to separate
  // from, it would just open the function body with an empty line.
  if (handlers.length) bodyLines.push(...(bodyLines.length ? [''] : []), ...handlers)

  const jsx = emitNode(root, ir)
  const indentedBody = bodyLines
    .map((l) => (l === '' ? '' : l.split('\n').map((x) => '  ' + x).join('\n')))
    .join('\n')
  const indentedJsx = jsx
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')

  const props = emitPropsType(ir, name)
  return `${imports}${props?.decl ?? ''}export function ${name}(${props?.params ?? ''}) {\n${indentedBody}\n\n  return (\n${indentedJsx}\n  )\n}\n`
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
  // the controlled-component pattern a React developer would have written — and
  // routed through the same writer, so a field editing an outside cell reports
  // outward instead of setting local state it doesn't own.
  for (const e of ir.editable) {
    if (e.node !== node.nodeId) continue
    const inputType = inputTypeFor(ir, node.nodeId)
    if (inputType) props.push(`type="${inputType}"`)
    props.push(`${e.prop}={${ident(e.target)}}`)
    const write = writerFor(ir, e.target, false).deliver(CHANGE_EVENT.read)
    props.push(`${CHANGE_EVENT.prop}={(e) => ${write}}`)
  }

  // Just the events the design authored. A box with an onClick stays exactly
  // that — no ARIA role, tab stop or keyboard activation added on top; those are
  // the designer's to author (or the receiving codebase's to add).
  for (const it of ir.interactions) {
    if (it.on.node !== node.nodeId) continue
    const ev = EVENT_PROP[it.on.trigger.type]
    if (!ev) continue
    props.push(`${ev}={${handlerName(it.on.node, it.on.trigger.type)}}`)
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
