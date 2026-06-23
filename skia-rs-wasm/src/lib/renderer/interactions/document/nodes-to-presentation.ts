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
import type { PNode } from '../compile/emit-react'

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

function toPNode(shape: IndexedShape, objects: Record<string, IndexedShape>): PNode {
  const node: PNode = { nodeId: shape.id, tag: tagFor(shape) }
  const style = styleFor(shape)
  if (style) node.style = style
  const children = (shape.shapes ?? [])
    .map((id) => objects[id])
    .filter((c): c is IndexedShape => Boolean(c))
    .map((c) => toPNode(c, objects))
  if (children.length) {
    node.children = children
  } else {
    const text = textFor(shape)
    if (text) node.text = text
  }
  return node
}

/** Find the page root (the shape with no parent) and walk it into a `PNode` tree. */
export function nodesToPresentation(page: IndexedPage): PNode | null {
  const objects = page.objects
  const root = Object.values(objects).find((o) => o.parentId == null)
  return root ? toPNode(root, objects) : null
}
