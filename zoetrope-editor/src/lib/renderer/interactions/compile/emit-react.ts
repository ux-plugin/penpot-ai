/**
 * emit-react — the web emitter: interaction IR → idiomatic React source.
 *
 * Behavior (deterministic, generated entirely from the IR):
 *   - store cells         -> props, plus an `onXChange` callback if written
 *   - design-owned cells  -> `useState` hooks (a node's own cell too)
 *   - formulas            -> `const x = <expr>`  (via expression.toJs)
 *   - interactions        -> handler functions; actions lower per catalog `lowers`
 *   - property references -> JSX prop / child expressions; `value` on a field
 *                            is the controlled-input pattern; `repeat` maps
 *
 * Presentation (the JSX structure) is supplied as a `PNode` tree — a stand-in for
 * AI-generated markup. The emitter weaves behavior onto it by node id and emits a
 * `data-node-id` anchor on every node (the contract the validation pass
 * enforces). Only the web lowering is implemented; the `native` emitter is an
 * additive sibling.
 */

import type { PageInteractions, NodeId, ValueType, Action, ActionType, Cell, NodeRefs, Ref } from '../ir'
import { actionParam, isBacked, isFormula, isEnumType, cellOf, cellRef, nodeRef, editedCell, refsOf, emptyPageInteractions, REPEAT_PROP, VALUE_PROP } from '../ir'
import { getAction } from '../catalog'
import { toJs, objectBodyJs, type ToJsOptions } from '../expression'
import { namesOf, refName } from '../expr'
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
 * to a boolean and it is a checkbox. No enum to keep in sync with the cell.
 * Returns undefined when the default (text) applies.
 */
export function inputTypeFor(ir: PageInteractions, nodeId: NodeId): string | undefined {
  const type = editedCell(ir, nodeId)?.type
  if (type === 'boolean') return 'checkbox'
  if (type === 'number') return 'number'
  return undefined
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
  role: NodeRole
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
const handlerName = (node: string, trigger: string) => `handle_${ident(node)}_${ident(trigger)}`

/**
 * The identifier a cell's value is read as in generated code: a page or
 * document cell by its id, a node's cell as `<node>_<cell>` — one flat
 * identifier per cell, whichever owns it.
 */
export function cellIdent(c: Cell): string {
  return c.owner.kind === 'node' ? `${ident(nodeRef(c.owner.node))}_${ident(c.id)}` : ident(c.id)
}
const setterFor = (c: Cell) => `set${cap(cellIdent(c))}`
const setterName = (root: string) => `set${cap(ident(root))}`

/**
 * How expressions lower: a node's cell (`card.state`) reads as the identifier
 * its hook declared. Everything else is plain JS.
 */
function jsOptions(ir: PageInteractions): ToJsOptions {
  return {
    member: (root, prop) => {
      const c = ir.cells.find((c) => c.owner.kind === 'node' && nodeRef(c.owner.node) === root && c.id === prop)
      return c ? cellIdent(c) : undefined
    },
  }
}

/** Web event prop for a node-scoped trigger. */
const EVENT_PROP: Record<string, string> = {
  press: 'onClick',
  'mouse-enter': 'onMouseEnter',
  'mouse-leave': 'onMouseLeave',
}

/**
 * Referenced props that are CSS, so they merge into the element's inline `style`
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
  if (typeof vt === 'object') {
    if ('enum' in vt) return vt.enum.length ? vt.enum.map((v) => JSON.stringify(v)).join(' | ') : 'string'
    return `${tsType(vt.collection)}[]`
  }
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

/** Cells the design WRITES — every action target plus every edited cell. */
function writtenCells(ir: PageInteractions): Set<string> {
  const written = new Set<string>()
  const add = (target: Ref | undefined) => {
    const c = cellOf(ir, target)
    if (c) written.add(cellRef(c))
  }
  for (const it of ir.interactions) for (const a of it.do) add(a.target)
  for (const ar of ir.appRules) for (const a of ar.do) add(a.target)
  for (const r of ir.refs) {
    const edited = editedCell(ir, r.node)
    if (edited) written.add(cellRef(edited))
  }
  return written
}

/** Callback prop name derived for a written store cell. */
const changeProp = (c: Cell) => `on${cap(cellIdent(c))}Change`

/**
 * The props interface — ENTIRELY DERIVED from which cells live in a store and
 * which of those the design writes. Nothing here was authored:
 *
 *   - a store cell becomes a value prop;
 *   - a store cell the design also WRITES additionally becomes an `onXChange`
 *     callback, because a write to a value you don't own has to be reported to
 *     whoever does.
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
  const backed = ir.cells.filter((c) => isBacked(c) && !isFormula(c))
  if (!backed.length) return undefined
  const written = writtenCells(ir)

  const lines: string[] = []
  const params: string[] = []
  for (const c of backed) {
    const notes: string[] = []
    if (c.description) notes.push(c.description)
    if (c.initial !== undefined && c.initial !== null) notes.push(`e.g. ${JSON.stringify(c.initial)}`)
    if (notes.length) lines.push(`  /** ${notes.join(' — ')} */`)
    lines.push(`  ${cellIdent(c)}: ${tsType(c.type)}`)
    params.push(cellIdent(c))

    if (written.has(cellRef(c))) {
      lines.push(`  /** the design changes ${cellRef(c)}; tell whoever owns it */`)
      lines.push(`  ${changeProp(c)}: (next: ${tsType(c.type)}) => void`)
      params.push(changeProp(c))
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

const localWriter = (setter: string): CellWriter => ({
  prev: 'prev',
  deliver: (next) => (next === 'prev' ? `${setter}(prev)` : `${setter}((prev) => ${next})`),
})

const plainWriter = (setter: string): CellWriter => ({
  prev: 'prev',
  deliver: (next) => `${setter}(${next})`,
})

const outsideWriter = (c: Cell): CellWriter => ({
  prev: cellIdent(c),
  deliver: (next) => `${changeProp(c)}(${next})`,
})

/** The writer for `target`, chosen by whether the design owns that cell. */
export function writerFor(ir: PageInteractions, target: Ref | undefined, dependsOnPrev: boolean): CellWriter {
  const c = cellOf(ir, target)
  if (c && isBacked(c)) return outsideWriter(c)
  const setter = c ? setterFor(c) : setterName(target ? refName(target, ir) : '')
  return dependsOnPrev ? localWriter(setter) : plainWriter(setter)
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
 * `writer` defaults to plain React state on the target's root identifier, which
 * is what the parity tests exercise; `emitReactComponent` passes one chosen per
 * target via `writerFor`, and `opts` its expression lowering.
 */
export function emitAction(a: Action, ir: PageInteractions, writer?: CellWriter, opts: ToJsOptions = {}): string {
  const targetRoot = a.target ? refName(a.target, ir) : ''
  const value = a.value ? toJs(namesOf(a.value, ir), opts) : 'undefined'
  const w = writer ?? (readsPrev(a.type) ? localWriter(setterName(targetRoot)) : plainWriter(setterName(targetRoot)))
  const prev = w.prev
  const set = (v: string) => w.deliver(v)
  switch (a.type) {
    case 'collection.append':
      return set(`[...${prev}, ${value}]`)
    case 'collection.insert': {
      const at = actionParam(a, 'at')
      const i = at ? toJs(namesOf(at, ir), opts) : '0'
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
        const body = objectBodyJs(namesOf(a.value, ir), opts)
        next = body === undefined ? value : body ? `{ ...item, ${body} }` : 'item'
      }
      const where = actionParam(a, 'where')
      const mapped = where ? `${toJs(namesOf(where, ir), opts)} ? ${next} : item` : next
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
  const js = jsOptions(ir)

  const hooks: string[] = []
  for (const c of ir.cells) {
    // A store cell arrives as a prop, so it gets no hook — its value already
    // exists under the same identifier, which is why every expression the emitter
    // produces works unchanged either way. A formula is a const below.
    if (isBacked(c) || isFormula(c)) continue
    const init = isEnumType(c.type) && (c.initial === null || c.initial === undefined) ? (c.type.enum[0] ?? '') : c.initial
    hooks.push(`const [${cellIdent(c)}, ${setterFor(c)}] = useState<${tsType(c.type)}>(${JSON.stringify(init)})`)
  }

  const formulas = ir.cells.filter(isFormula).map((c) => `const ${cellIdent(c)} = ${toJs(namesOf(c.formula!, ir), js)}`)

  const handlers = ir.interactions.map((it) => {
    const stmts = it.do.map((a) => emitAction(a, ir, writerFor(ir, a.target, readsPrev(a.type)), js))
    let body: string
    if (it.if) body = `  if (${toJs(namesOf(it.if, ir), js)}) {\n${stmts.map((s) => '    ' + s).join('\n')}\n  }`
    else body = stmts.map((s) => '  ' + s).join('\n')
    return `const ${handlerName(it.on.node, it.on.trigger.type)} = () => {\n${body}\n}`
  })

  const imports = hooks.length ? `import { useState } from 'react'\n\n` : ''

  const bodyLines: string[] = [...hooks, ...formulas]
  // The blank line separates handlers from state — with no state to separate
  // from, it would just open the function body with an empty line.
  if (handlers.length) bodyLines.push(...(bodyLines.length ? [''] : []), ...handlers)

  // Component definitions are emitted once each, ahead of the page, and every
  // copy in the tree becomes a call to one.
  const defs = new Map<string, ComponentPresentation>()
  collectComponentDefs(root, defs)
  const componentFns = [...defs.values()].map(emitComponentFn)

  const jsx = emitNode(root, ir, js)
  const indentedBody = bodyLines
    .map((l) => (l === '' ? '' : l.split('\n').map((x) => '  ' + x).join('\n')))
    .join('\n')
  const indentedJsx = jsx
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')

  const props = emitPropsType(ir, name)
  const prelude = componentFns.length ? `${componentFns.join('\n\n')}\n\n` : ''
  return `${imports}${prelude}${props?.decl ?? ''}export function ${name}(${props?.params ?? ''}) {\n${indentedBody}\n\n  return (\n${indentedJsx}\n  )\n}\n`
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
 * references and handlers are authored per page today, and weaving them through
 * a component boundary is its own problem.
 */
function emitComponentFn(component: ComponentPresentation): string {
  const empty = emptyPageInteractions()
  const params = component.propNames?.length ? `{ ${component.propNames.map(ident).join(', ')} }` : ''
  const body = emitNode(component.definition!, empty, {})
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

function emitNode(node: PNode, ir: PageInteractions, js: ToJsOptions): string {
  const refs = refsOf(ir, node.nodeId)
  const repeat = refs?.props[REPEAT_PROP]
  const el = emitElement(node, ir, js, repeat ? refs : undefined)
  // A boolean prop's target renders behind its condition.
  if (node.whenExpr) {
    const inner = el
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')
    const guarded = `{${node.whenExpr} && (\n${inner}\n)}`
    if (!repeat) return guarded
  }
  if (!repeat || !refs) return el
  const as = refs.item?.as ?? 'item'
  const inner = el
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  return `{${toJs(namesOf(repeat, ir), js)}.map((${as}) => (\n${inner}\n))}`
}

function emitElement(node: PNode, ir: PageInteractions, js: ToJsOptions, rep?: NodeRefs): string {
  // A copy emits as a call to its component, not as its own subtree.
  if (node.component) return emitComponentCall(node, node.component)

  const props: string[] = [anchorAttr(node.nodeId)]
  if (rep) {
    const as = rep.item?.as ?? 'item'
    const keyExpr = rep.item?.key ? toJs(namesOf(rep.item.key, ir), js) : `${as}.id`
    props.push(`key={${keyExpr}}`, instanceKeyAttr(keyExpr))
  }

  // Style order is the precedence order: the browser's defaults are neutralized
  // first, then the design's own values, then any referenced expression.
  const styleMap = new Map<string, string>()
  for (const [k, v] of Object.entries(baseStyleFor(node.role))) styleMap.set(k, JSON.stringify(v))
  if (node.style) for (const [k, v] of Object.entries(node.style)) styleMap.set(k, JSON.stringify(v))

  const refs = refsOf(ir, node.nodeId)
  const edited = editedCell(ir, node.nodeId)
  let textChild: string | undefined
  for (const [prop, from] of Object.entries(refs?.props ?? {})) {
    if (prop === REPEAT_PROP) continue
    if (prop === VALUE_PROP && edited) continue
    const expr = toJs(namesOf(from, ir), js)
    if (prop === 'text' || prop === 'children') textChild = expr
    else if (STYLE_PROPS.has(prop)) styleMap.set(prop, expr)
    else props.push(`${prop}={${expr}}`)
  }

  // Two-way: the read is a value prop, the write is a change handler. Emitted as
  // the controlled-component pattern a React developer would have written — and
  // routed through the same writer, so a field editing a store cell reports
  // outward instead of setting local state it doesn't own.
  if (edited) {
    const inputType = inputTypeFor(ir, node.nodeId)
    if (inputType) props.push(`type="${inputType}"`)
    props.push(`${VALUE_PROP}={${cellIdent(edited)}}`)
    const write = writerFor(ir, { kind: 'cell', cell: edited.uid }, false).deliver(CHANGE_EVENT.read)
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

  // A slot renders its active view's subtree. Code gen is a static snapshot (the
  // design-time default); runtime view-switching lowers later.
  const slotDefault = node.slot ? node.slot.views[node.slot.activeView ?? ''] : undefined
  const childSource = slotDefault ? [slotDefault] : (node.children ?? [])
  const childNodes = childSource.map((c) => emitNode(c, ir, js))

  const tag = tagForRole(node.role)

  // A void tag is self-closing and cannot carry children; an <input> with a text
  // child is a React error, not a styling quirk.
  if (VOID_TAGS.has(tag)) return `<${tag} ${props.join(' ')} />`

  const open = `<${tag} ${props.join(' ')}>`
  const close = `</${tag}>`

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
