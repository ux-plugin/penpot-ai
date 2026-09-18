/**
 * nodesToPresentation — the bridge from the document (shapes) to the engine's
 * presentation model.
 *
 * Walks the flat `IndexedPage` shape tree from its root and produces a `PNode`
 * tree: each shape becomes one element carrying its id as the `data-node-id`
 * anchor, nested by the shape hierarchy (`shapes` child-id arrays).
 *
 * The tag mapping is a deterministic baseline (shape type + a light name
 * heuristic). This is the exact seam where AI-authored idiomatic JSX slots in
 * later: it replaces the tag mapping while preserving the one-node-one-anchor
 * contract, so behavior weaving keeps working unchanged.
 */

import type { IndexedPage, IndexedShape } from '../../../worker/types'
import type { ComponentPresentation, PNode, SlotPresentation } from '../compile/emit-react'
import { isComponentCopyRoot, isComponentMain, isSlotShape } from '../../../worker/geometry/shapes'
import type { LocalComponent } from '../../../common/component'

const NAME_TAG: Array<[RegExp, string]> = [
  [/button|btn/, 'button'],
  [/heading|title|headline/, 'h2'],
  [/list/, 'ul'],
  [/row|item|cell/, 'li'],
  [/input|field|textbox/, 'input'],
  [/link/, 'a'],
]

function tagFor(shape: IndexedShape): string {
  const name = (shape.name ?? '').toLowerCase()
  for (const [re, tag] of NAME_TAG) if (re.test(name)) return tag
  switch (shape.type) {
    case 'text':
      return 'span'
    case 'image':
      return 'img'
    default:
      return 'div'
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
  n?: string
}

/** Map the shape's first solid fill to a CSS style: text → color, else background. */
function styleFor(shape: IndexedShape): Record<string, string> | undefined {
  const fills = (shape as { fills?: FillLike[] }).fills
  const fill = fills?.find((f) => f.fillColor ?? f.n)
  const color = fill?.fillColor ?? fill?.n
  if (!color) return undefined
  return shape.type === 'text' ? { color } : { background: color }
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
  projecting: Set<string>,
): SlotPresentation {
  const views: Record<string, PNode> = {}
  for (const viewId of slot.views) {
    if (projecting.has(viewId)) continue
    const view = objects[viewId]
    if (!view) continue
    projecting.add(viewId)
    views[viewId] = toPNode(view, objects, projecting)
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
  projecting: Set<string>,
): ComponentPresentation | null {
  const main = objects[component.mainInstanceId]
  if (!main || projecting.has(main.id)) return null

  projecting.add(main.id)
  const definition = toPNode(main, objects, projecting)
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
  projecting: Set<string> = new Set(),
  components?: Record<string, LocalComponent>,
): PNode {
  const node: PNode = { nodeId: shape.id, tag: tagFor(shape) }
  const style = styleFor(shape)
  if (style) node.style = style

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
      ? componentPresentation(shape, component, objects, projecting)
      : null
    if (presentation) {
      node.component = presentation
      return node
    }
  }
  // A slot owns no children — it references view frames. Emit a slot descriptor
  // carrying each candidate's projected subtree instead of walking `shapes`.
  if (isSlotShape(shape)) {
    node.slot = slotPresentation(shape, objects, projecting)
    // Clip the shown view to the outlet box when the slot clips (showContent:false).
    if (shape.showContent === false) node.style = { ...node.style, overflow: 'hidden' }
    return node
  }
  const children = (shape.shapes ?? [])
    .map((id) => objects[id])
    .filter((c): c is IndexedShape => Boolean(c))
    .map((c) => toPNode(c, objects, projecting, components))
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
  return root ? toPNode(root, objects, new Set(), components) : null
}
