import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { children, getNode, moveNodes, pageObjects, undo } from '../../../../src/lib/doc'
import { makeBaseDocument, resetWorkspace, seedDocument } from '../../fixtures'
import {
  computeDropSide,
  findContainerAtPoint,
  isAncestor,
  isContainer,
  resolveDropTarget,
} from '../../../../src/lib/components/LayersPanel/reparent'

const PAGE_ID = 'page1'

const sel = (x: number, y: number, w: number, h: number) => ({
  x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h,
})

function shape(partial: Partial<PenpotNode> & { id: string; type: string; children?: PenpotNode[] }): PenpotNode {
  return { name: partial.id, x: 0, y: 0, width: 1, height: 1, selrect: sel(0, 0, 1, 1), ...partial } as unknown as PenpotNode
}

function seedPage(kids: PenpotNode[]): void {
  seedDocument({ ...makeBaseDocument(), children: [{ id: PAGE_ID, name: 'Page', background: '#FFFFFF', children: kids }] })
}

/**
 * Fixture (top level is the page):
 *   ├── frame1 (frame)
 *   │   ├── rectA (rect)
 *   │   └── rectB (rect)
 *   ├── group1 (group)
 *   │   └── rectC (rect)
 *   └── rectD (rect)
 */
function seedTree(): void {
  seedPage([
    shape({ id: 'frame1', type: 'frame', children: [shape({ id: 'rectA', type: 'rect' }), shape({ id: 'rectB', type: 'rect' })] }),
    shape({ id: 'group1', type: 'group', children: [shape({ id: 'rectC', type: 'rect' })] }),
    shape({ id: 'rectD', type: 'rect' }),
  ])
}

describe('computeDropSide', () => {
  const H = 100

  it('detects three zones when detectCenter=true', () => {
    expect(computeDropSide(10, H, true)).toBe('top')
    expect(computeDropSide(50, H, true)).toBe('center')
    expect(computeDropSide(90, H, true)).toBe('bot')
  })

  it('splits 50/50 when detectCenter=false', () => {
    expect(computeDropSide(40, H, false)).toBe('top')
    expect(computeDropSide(60, H, false)).toBe('bot')
  })

  it('handles degenerate row height', () => {
    expect(computeDropSide(0, 0, true)).toBe('bot')
  })
})

describe('isContainer', () => {
  it('accepts frame/group/bool/component', () => {
    expect(isContainer({ type: 'frame' } as PenpotNode)).toBe(true)
    expect(isContainer({ type: 'group' } as PenpotNode)).toBe(true)
    expect(isContainer({ type: 'bool' } as PenpotNode)).toBe(true)
    expect(isContainer({ type: 'component' } as PenpotNode)).toBe(true)
  })

  it('rejects leaves', () => {
    expect(isContainer({ type: 'rect' } as PenpotNode)).toBe(false)
    expect(isContainer({ type: 'text' } as PenpotNode)).toBe(false)
    expect(isContainer(null)).toBe(false)
  })
})

describe('isAncestor', () => {
  beforeEach(() => {
    resetWorkspace()
    seedTree()
  })

  it('walks parent chain', () => {
    expect(isAncestor('frame1', 'rectA')).toBe(true)
    expect(isAncestor('frame1', 'frame1')).toBe(true)
    expect(isAncestor('group1', 'rectA')).toBe(false)
    expect(isAncestor('rectA', 'frame1')).toBe(false)
  })
})

describe('resolveDropTarget', () => {
  beforeEach(() => {
    resetWorkspace()
    seedTree()
  })

  it('center on container → (targetId, 0)', () => {
    expect(resolveDropTarget({ targetId: 'group1', side: 'center', draggedIds: ['rectD'] })).toEqual({
      parentId: 'group1',
      index: 0,
    })
  })

  it('center on leaf → null', () => {
    expect(resolveDropTarget({ targetId: 'rectA', side: 'center', draggedIds: ['rectD'] })).toBeNull()
  })

  it('top/bot on sibling → correct parent + index', () => {
    // rectB is at index 1 in frame1 — dropping rectD above rectB inserts at 1; below at 2.
    expect(resolveDropTarget({ targetId: 'rectB', side: 'top', draggedIds: ['rectD'] })).toEqual({
      parentId: 'frame1',
      index: 1,
    })
    expect(resolveDropTarget({ targetId: 'rectB', side: 'bot', draggedIds: ['rectD'] })).toEqual({
      parentId: 'frame1',
      index: 2,
    })
  })

  it('top/bot on a top-level sibling → page top level', () => {
    expect(resolveDropTarget({ targetId: 'rectD', side: 'top', draggedIds: ['rectA'] })).toEqual({
      parentId: undefined,
      index: 2,
    })
  })

  it('drop on self → null', () => {
    expect(resolveDropTarget({ targetId: 'rectA', side: 'top', draggedIds: ['rectA'] })).toBeNull()
    expect(resolveDropTarget({ targetId: 'frame1', side: 'center', draggedIds: ['frame1'] })).toBeNull()
  })

  it('drop into descendant → null', () => {
    expect(resolveDropTarget({ targetId: 'rectA', side: 'top', draggedIds: ['frame1'] })).toBeNull()
  })

  it('no-op drop (same parent + current index) → null', () => {
    expect(resolveDropTarget({ targetId: 'rectB', side: 'top', draggedIds: ['rectA'] })).toBeNull()
    expect(resolveDropTarget({ targetId: 'rectA', side: 'bot', draggedIds: ['rectB'] })).toBeNull()
  })
})

describe('reparent via moveNodes', () => {
  beforeEach(() => {
    resetWorkspace()
    seedTree()
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
  })

  it('move + undo roundtrip returns to the original tree', async () => {
    await commitChanges({ changes: moveNodes(['rectA'], { page: PAGE_ID, parentId: 'group1', index: 1 }) })
    expect(getNode('rectA')?.parentId).toBe('group1')
    expect(children('group1')).toEqual(['rectC', 'rectA'])
    expect(children('frame1')).toEqual(['rectB'])

    await undo()
    expect(getNode('rectA')?.parentId).toBe('frame1')
    expect(children('frame1')).toEqual(['rectA', 'rectB'])
    expect(children('group1')).toEqual(['rectC'])
  })
})

describe('findContainerAtPoint', () => {
  /**
   * Fixture: outer frame (0,0,200,200) with an inner frame (50,50,80,80).
   * Plus a loose rect (10,10,20,20) outside the inner frame.
   */
  beforeEach(() => {
    resetWorkspace()
    seedPage([
      shape({
        id: 'outer',
        type: 'frame',
        selrect: sel(0, 0, 200, 200),
        children: [
          shape({ id: 'inner', type: 'frame', selrect: sel(50, 50, 80, 80) }),
          shape({ id: 'loose', type: 'rect', selrect: sel(10, 10, 20, 20) }),
        ],
      }),
    ])
  })

  const objects = () => pageObjects(PAGE_ID)

  it('returns the innermost containing frame', () => {
    expect(findContainerAtPoint(objects(), { x: 80, y: 80 }, [])).toBe('inner')
    expect(findContainerAtPoint(objects(), { x: 5, y: 5 }, [])).toBe('outer')
  })

  it('returns null when point is outside all frames', () => {
    expect(findContainerAtPoint(objects(), { x: 500, y: 500 }, [])).toBeNull()
  })

  it('excludes dragged shapes from being a target (self-drop)', () => {
    // Center of outer is (100,100) which also lies inside inner — excluding inner
    // forces the fallback to outer.
    expect(findContainerAtPoint(objects(), { x: 100, y: 100 }, ['inner'])).toBe('outer')
  })

  it('excludes descendants of dragged shapes', () => {
    // Excluding outer also excludes inner (descendant) — point (80,80) → null.
    expect(findContainerAtPoint(objects(), { x: 80, y: 80 }, ['outer'])).toBeNull()
  })

  it('ignores non-containers', () => {
    // Point inside loose rect but rect isn't a container — fallback to outer.
    expect(findContainerAtPoint(objects(), { x: 15, y: 15 }, [])).toBe('outer')
  })
})
