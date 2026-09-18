import type { PenpotNode } from 'penpot-exporter/types'
import type { RectLikeNode } from '../../../renderer/properties/panel-utils'

export type LayoutMode = 'flex' | 'grid'

type LayoutFieldsView = {
  layoutFlexDir?: unknown
  layoutGridDir?: unknown
  layoutGridColumns?: unknown
  layoutGridRows?: unknown
  layoutWrapType?: unknown
  layoutJustifyContent?: unknown
  layoutJustifyItems?: unknown
  layoutAlignItems?: unknown
  layoutGap?: unknown
  layoutPadding?: unknown
}

// Only frames (boards) support flex/grid layout, matching render-wasm where
// `Shape::has_layout` is reachable solely for `Type::Frame`.
export function supportsLayout(node: { type?: string } | null | undefined): boolean {
  return node?.type === 'frame'
}

export function getLayoutMode(node: RectLikeNode): LayoutMode | null {
  const n = node as LayoutFieldsView
  if (n.layoutFlexDir) return 'flex'
  if (n.layoutGridDir) return 'grid'
  return null
}

export function modeSwitchPartial(
  mode: LayoutMode | null,
  before: RectLikeNode,
): Partial<PenpotNode> {
  const b = before as LayoutFieldsView
  const patch: Record<string, unknown> = {}

  if (mode == null) {
    patch.layoutFlexDir = null
    patch.layoutGridDir = null
    return patch as Partial<PenpotNode>
  }

  if (mode === 'flex') {
    patch.layoutGridDir = null
    patch.layoutFlexDir = (b.layoutFlexDir as string | undefined) ?? 'row'
    if (b.layoutWrapType == null) patch.layoutWrapType = 'nowrap'
    if (b.layoutJustifyContent == null) patch.layoutJustifyContent = 'start'
    if (b.layoutAlignItems == null) patch.layoutAlignItems = 'start'
    if (b.layoutGap == null) patch.layoutGap = { rowGap: 0, columnGap: 0 }
    if (b.layoutPadding == null)
      patch.layoutPadding = { p1: 0, p2: 0, p3: 0, p4: 0 }
    return patch as Partial<PenpotNode>
  }

  // grid
  patch.layoutFlexDir = null
  patch.layoutGridDir = (b.layoutGridDir as string | undefined) ?? 'row'
  if (b.layoutGridColumns == null)
    patch.layoutGridColumns = [
      { type: 'flex', value: 1 },
      { type: 'flex', value: 1 },
      { type: 'flex', value: 1 },
    ]
  if (b.layoutGridRows == null)
    patch.layoutGridRows = [{ type: 'auto' }, { type: 'auto' }]
  if (b.layoutAlignItems == null) patch.layoutAlignItems = 'stretch'
  if (b.layoutJustifyItems == null) patch.layoutJustifyItems = 'start'
  if (b.layoutGap == null) patch.layoutGap = { rowGap: 12, columnGap: 12 }
  if (b.layoutPadding == null) patch.layoutPadding = { p1: 16, p2: 16, p3: 16, p4: 16 }
  return patch as Partial<PenpotNode>
}
