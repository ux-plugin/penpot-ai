/**
 * nodesToPresentation — the bridge from the document (shapes) to the engine's
 * presentation model.
 *
 * Walks the flat `IndexedPage` shape tree from its root and produces a `PNode`
 * tree: each shape becomes one element carrying its id as the `data-node-id`
 * anchor, nested by the shape hierarchy (`shapes` child-id arrays).
 *
 * Each node carries a semantic ROLE (see `deriveRole`), not an HTML tag — there
 * is no `<input>` in React Native, so the tag is resolved per target. Roles are
 * derived from the shape and the behaviour authored on it, never from the layer
 * name. This is the seam where AI-authored idiomatic JSX slots in later: it
 * replaces the role→element mapping while preserving the one-node-one-anchor
 * contract, so behavior weaving keeps working unchanged.
 */

import type { IndexedPage, IndexedShape } from '../../../worker/types'
import type { PageInteractions } from '../ir'
import { editedCell, propRef, REPEAT_PROP } from '../ir'
import type { ComponentPresentation, PNode, SlotPresentation, NodeRole } from '../compile/emit-react'
import { isComponentCopyRoot, isComponentMain, isSlotShape } from '../../../worker/geometry/shapes'
import type { LocalComponent } from '../../../common/component'

/**
 * What a node MEANS, derived from the shape and the behaviour authored on it —
 * never from its layer name. A name heuristic (`/input|field/` → a text field)
 * made the meaning invisible and broke on rename or translation; a node is a
 * field because it EDITS something, and a button because you can press it.
 *
 * Order matters: the most specific behaviour wins. A node that both edits a cell
 * and has a press is a field first.
 */
function deriveRole(shape: IndexedShape, ir: PageInteractions | undefined, childIds: string[]): NodeRole {
  const id = shape.id
  const onNode = (it: { on: { node: string } }) => it.on.node === id

  if (ir && editedCell(ir, id)) return 'field'
  const interactions = ir?.interactions.filter(onNode) ?? []
  if (interactions.some((it) => it.do.some((a) => a.type === 'open-url'))) return 'link'
  if (interactions.some((it) => it.on.trigger.type === 'press')) return 'button'
  const repeats = (n: string) => Boolean(ir && propRef(ir, n, REPEAT_PROP))
  if (repeats(id)) return 'item'
  if (childIds.some(repeats)) return 'list'

  switch (shape.type) {
    case 'text':
      return 'text'
    case 'image':
      return 'image'
    default:
      return 'container'
  }
}

/** Best-effort plain-text from a Penpot text content tree (paragraphs → runs). */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(extractText).join('')
  if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    const kids = o.children ?? o.content
    if (kids) return extractText(kids)
  }
  return ''
}

function textFor(shape: IndexedShape): string | undefined {
  const raw = (shape as { content?: unknown }).content
  const t = raw ? extractText(raw).trim() : ''
  if (t) return t
  // text leaves with no extractable content fall back to their layer name
  return shape.type === 'text' ? shape.name : undefined
}

interface FillLike {
  fillColor?: string
  fillOpacity?: number
  n?: string
}

interface StrokeLike {
  strokeColor?: string
  strokeOpacity?: number
  strokeWidth?: number
  strokeStyle?: string
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`

/**
 * Fold a fill/stroke opacity into the colour as an 8-digit hex, so a single CSS
 * value carries both. Non-hex colours (gradients, named) pass through unchanged.
 */
function withAlpha(color: string, opacity?: number): string {
  if (opacity == null || opacity >= 1) return color
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color
  return color + Math.round(Math.max(0, opacity) * 255).toString(16).padStart(2, '0')
}

function firstColor(shape: IndexedShape): string | undefined {
  const fill = (shape as { fills?: FillLike[] }).fills?.find((f) => f.fillColor ?? f.n)
  const color = fill?.fillColor ?? fill?.n
  return color ? withAlpha(color, fill?.fillOpacity) : undefined
}

/** `border` shorthand from the shape's first visible stroke. */
function borderFor(shape: IndexedShape): string | undefined {
  const stroke = (shape as { strokes?: StrokeLike[] }).strokes?.find((s) => s.strokeColor && (s.strokeWidth ?? 0) > 0)
  if (!stroke?.strokeColor) return undefined
  const style = stroke.strokeStyle === 'dotted' || stroke.strokeStyle === 'dashed' ? stroke.strokeStyle : 'solid'
  return `${px(stroke.strokeWidth ?? 1)} ${style} ${withAlpha(stroke.strokeColor, stroke.strokeOpacity)}`
}

/** Corner radii — collapsed to one value when all four agree. */
function radiusFor(shape: IndexedShape): string | undefined {
  const s = shape as { r1?: number; r2?: number; r3?: number; r4?: number; rx?: number }
  const corners = [s.r1 ?? s.rx ?? 0, s.r2 ?? s.rx ?? 0, s.r3 ?? s.rx ?? 0, s.r4 ?? s.rx ?? 0]
  if (corners.every((c) => !c)) return undefined
  return corners.every((c) => c === corners[0]) ? px(corners[0]) : corners.map(px).join(' ')
}

/** First paragraph's typography — the baseline the whole text shape renders at. */
function typographyFor(shape: IndexedShape): Record<string, string> {
  const content = (shape as { content?: { children?: unknown } }).content
  const para = findParagraph(content)
  if (!para) return {}
  const out: Record<string, string> = {}
  if (typeof para.fontSize === 'number') out.fontSize = px(para.fontSize)
  else if (typeof para.fontSize === 'string' && para.fontSize.trim()) out.fontSize = px(Number(para.fontSize))
  if (para.fontWeight != null) out.fontWeight = String(para.fontWeight)
  if (para.fontStyle === 'italic') out.fontStyle = 'italic'
  if (typeof para.textAlign === 'string') out.textAlign = para.textAlign
  if (typeof para.fontFamily === 'string') out.fontFamily = para.fontFamily
  return out
}

interface ParagraphLike {
  fontSize?: number | string
  fontWeight?: number | string
  fontStyle?: string
  textAlign?: string
  fontFamily?: string
}

/** Depth-first search for the first node in a text tree carrying font attributes. */
function findParagraph(node: unknown): ParagraphLike | undefined {
  if (!node || typeof node !== 'object') return undefined
  const o = node as Record<string, unknown> & { children?: unknown[] }
  if (o.fontSize != null || o.fontWeight != null || o.textAlign != null) return o as ParagraphLike
  for (const child of Array.isArray(o.children) ? o.children : []) {
    const found = findParagraph(child)
    if (found) return found
  }
  return undefined
}

/**
 * The shape's design properties as inline CSS: size, fill, border, radius,
 * opacity, and (for text) typography. Both the preview runtime and the React
 * emitter read `PNode.style`, so this is what makes the generated component look
 * like the design rather than a stack of unstyled divs.
 *
 * Layout is FLOW, not absolute: a container lays its children out as a column,
 * and each shape contributes its own size. The preview therefore reads like a
 * real React app (which is what the emitted code has to be) rather than matching
 * the canvas pixel-for-pixel. The page root is exempt from sizing — it's the
 * component's outer container, so it adapts to whatever renders it.
 */
function styleFor(shape: IndexedShape, isRoot: boolean, hasChildren: boolean): Record<string, string> | undefined {
  const style: Record<string, string> = {}
  const isText = shape.type === 'text'

  const color = firstColor(shape)
  if (color) style[isText ? 'color' : 'background'] = color

  if (!isRoot) {
    const sr = (shape as { selrect?: { width?: number; height?: number } }).selrect
    const w = sr?.width ?? (shape as { width?: number }).width
    const h = sr?.height ?? (shape as { height?: number }).height
    if (typeof w === 'number' && w > 0) style.width = px(w)
    // minHeight, not height: text and lists must be able to grow past the box
    // the designer drew, which is the whole point of a flow-layout preview.
    if (typeof h === 'number' && h > 0) style.minHeight = px(h)
  }

  const border = borderFor(shape)
  if (border) style.border = border
  const radius = radiusFor(shape)
  if (radius) style.borderRadius = radius

  const opacity = (shape as { opacity?: number }).opacity
  if (typeof opacity === 'number' && opacity < 1) style.opacity = String(opacity)
  if ((shape as { hidden?: boolean }).hidden) style.display = 'none'

  if (isText) Object.assign(style, typographyFor(shape))

  // Containers stack their children in a column — the flow-layout contract.
  // Set after the hidden check so `display: none` on a container still wins.
  if (hasChildren && style.display !== 'none') {
    style.display = 'flex'
    style.flexDirection = 'column'
    style.gap = '8px'
  }

  return Object.keys(style).length ? style : undefined
}

/**
 * Project a slot's candidate view frames into a {@link SlotPresentation}. Each
 * referenced view id is looked up in the same page objects and walked into its
 * own subtree; the runtime later renders exactly one of them. `projecting` guards
 * against re-entrancy if a view frame (transitively) contains the slot again.
 */
function slotPresentation(
  slot: { views: string[]; activeView?: string },
  objects: Record<string, IndexedShape>,
  ir: PageInteractions | undefined,
  projecting: Set<string>,
  components?: Record<string, LocalComponent>,
): SlotPresentation {
  const views: Record<string, PNode> = {}
  for (const viewId of slot.views) {
    if (projecting.has(viewId)) continue
    const view = objects[viewId]
    if (!view) continue
    projecting.add(viewId)
    views[viewId] = toPNode(view, objects, ir, projecting, components)
    projecting.delete(viewId)
  }
  return { activeView: slot.activeView, views }
}

/** PascalCase identifier for a component's function name. */
function componentIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+(.)?/g, (_, chr: string | undefined) =>
    chr ? chr.toUpperCase() : '',
  )
  const pascal = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  return /^[A-Za-z]/.test(pascal) ? pascal : `Component${pascal}`
}

/** Index a projected subtree by the node ids it came from. */
function indexByNodeId(node: PNode, into: Map<string, PNode>): void {
  into.set(node.nodeId, node)
  for (const child of node.children ?? []) indexByNodeId(child, into)
}

/**
 * Describe a component copy: the call site's resolved prop values, plus the
 * main's subtree as the component's body with prop-driven nodes rewritten to
 * read from their prop.
 *
 * Returns null when the main can't be reached from this page — a component whose
 * main lives on another page still renders, it just inlines the copy's own
 * subtree the way it did before this existed.
 */
function componentPresentation(
  copy: IndexedShape,
  component: LocalComponent,
  objects: Record<string, IndexedShape>,
  ir: PageInteractions | undefined,
  projecting: Set<string>,
): ComponentPresentation | null {
  const main = objects[component.mainInstanceId]
  if (!main || projecting.has(main.id)) return null

  projecting.add(main.id)
  const definition = toPNode(main, objects, ir, projecting)
  projecting.delete(main.id)

  const byId = new Map<string, PNode>()
  indexByNodeId(definition, byId)

  const set = (copy as { propValues?: Record<string, unknown> }).propValues ?? {}
  const props: Record<string, unknown> = {}
  for (const prop of component.props) {
    props[prop.name] = prop.id in set ? set[prop.id] : prop.defaultValue
    for (const target of prop.targets) {
      const targetNode = byId.get(target.nodeId)
      if (!targetNode) continue
      if (prop.type === 'text') targetNode.textExpr = prop.name
      else if (prop.type === 'boolean') targetNode.whenExpr = prop.name
    }
  }

  return {
    name: componentIdent(component.name),
    props,
    definition,
    propNames: component.props.map((p) => p.name),
  }
}

function toPNode(
  shape: IndexedShape,
  objects: Record<string, IndexedShape>,
  ir: PageInteractions | undefined,
  projecting: Set<string> = new Set(),
  components?: Record<string, LocalComponent>,
): PNode {
  const childIds: string[] = shape.shapes ?? []
  const node: PNode = { nodeId: shape.id, role: deriveRole(shape, ir, childIds) }
  const isRoot = shape.parentId == null

  // A component copy emits as a call to its component instead of inlining its
  // subtree — which is the whole point of declaring props.
  //
  // The main emits as a call too. It sits on the canvas like any other frame, so
  // inlining it would put a literal duplicate of the component's own body in the
  // page. The recursion terminates on its own: projecting the main's subtree for
  // the definition re-enters this branch, finds the main already in `projecting`,
  // and inlines it there — which is exactly where the literal body belongs.
  if (components && (isComponentCopyRoot(shape) || isComponentMain(shape))) {
    const component = components[(shape as { componentId?: string }).componentId ?? '']
    const presentation = component
      ? componentPresentation(shape, component, objects, ir, projecting)
      : null
    if (presentation) {
      const style = styleFor(shape, isRoot, childIds.length > 0)
      if (style) node.style = style
      node.component = presentation
      return node
    }
  }

  // A slot owns no children — it references view frames. Emit a slot descriptor
  // carrying each candidate's projected subtree instead of walking `shapes`.
  if (isSlotShape(shape)) {
    node.slot = slotPresentation(shape, objects, ir, projecting, components)
    const style = styleFor(shape, isRoot, false)
    // Clip the shown view to the outlet box when the slot clips (showContent:false).
    node.style = shape.showContent === false ? { ...style, overflow: 'hidden' } : style
    if (!node.style || !Object.keys(node.style).length) delete node.style
    return node
  }

  const children = childIds
    .map((id) => objects[id])
    .filter((c): c is IndexedShape => Boolean(c))
    .map((c) => toPNode(c, objects, ir, projecting, components))

  // Style depends on whether this node ends up a container, so it's built after
  // the children are known.
  const style = styleFor(shape, isRoot, children.length > 0)
  if (style) node.style = style

  if (children.length) {
    node.children = children
  } else {
    const text = textFor(shape)
    if (text) node.text = text
  }
  return node
}

/**
 * Find the page root (the shape with no parent) and walk it into a `PNode` tree.
 *
 * Pass `components` (the document's library) to have copies emit as component
 * calls; without it they inline their own subtrees, which is what every caller
 * did before components existed.
 */
export function nodesToPresentation(
  page: IndexedPage,
  components?: Record<string, LocalComponent>,
): PNode | null {
  const objects = page.objects
  const root = Object.values(objects).find((o) => o.parentId == null)
  return root ? toPNode(root, objects, page.interactions, new Set(), components) : null
}

/**
 * Locate a node's subtree within a presentation tree — the scoping primitive
 * behind "show only the selected component" (Build preview) and the per-node
 * Code tab. Searches a slot's candidate views as well as plain children, so a
 * node that only appears inside a slot view is still findable. The tree is
 * finite (slot projection guards re-entrancy), so this always terminates.
 */
export function findPNode(node: PNode, id: string): PNode | null {
  if (node.nodeId === id) return node
  for (const child of node.children ?? []) {
    const found = findPNode(child, id)
    if (found) return found
  }
  for (const view of Object.values(node.slot?.views ?? {})) {
    const found = findPNode(view, id)
    if (found) return found
  }
  return null
}
