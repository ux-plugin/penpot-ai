import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { canUndo, children, getNode, undo } from '../../../../src/lib/doc'
import { makeBaseDocument, resetWorkspace, ROOT, seedDocument } from '../../fixtures'
import {
  convertFrameToSlot,
  convertSlotToFrame,
} from '../../../../src/lib/renderer/slot/slot-authoring'

const PAGE_ID = 'page1'

function box(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h, selrect: { x, y, width: w, height: h } }
}

const frame = (id: string, name: string, b: ReturnType<typeof box>, kids: PenpotNode[] = []): PenpotNode =>
  ({ id, type: 'frame', name, ...b, children: kids }) as unknown as PenpotNode
const rect = (id: string, name: string, b: ReturnType<typeof box>): PenpotNode =>
  ({ id, type: 'rect', name, ...b }) as unknown as PenpotNode

/**
 * shell (frame 100,100 300x200)
 *  ├ child (rect 120,120 50x50)
 *  └ inner (frame 200,140 80x40)
 *      └ deep (rect 210,150 20x20)
 */
function seedShell(kids: PenpotNode[]): void {
  seedDocument({
    ...makeBaseDocument(),
    children: [{ id: PAGE_ID, name: 'Page', background: '#FFFFFF', children: [frame('shell', 'Shell', box(100, 100, 300, 200), kids)] }],
  })
}

const populated = (): PenpotNode[] => [
  rect('child', 'Child', box(120, 120, 50, 50)),
  frame('inner', 'Inner', box(200, 140, 80, 40), [rect('deep', 'Deep', box(210, 150, 20, 20))]),
]

const node = (id: string) => getNode(id) as unknown as Record<string, unknown> & { views?: string[]; activeView?: string }

describe('convert frame <-> slot', () => {
  beforeEach(() => {
    resetWorkspace()
    seedShell(populated())
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
  })

  it("extracts a populated frame's content into a view frame the new slot shows", async () => {
    const viewId = await convertFrameToSlot('shell')
    expect(viewId).toBeTruthy()

    // the frame became a slot referencing the extracted view, and owns no children
    const slot = node('shell')
    expect(slot.type).toBe('slot')
    expect(slot.views).toEqual([viewId])
    expect(slot.activeView).toBe(viewId)
    expect(children('shell')).toEqual([])
    // ...keeping its own id and box
    expect(slot.selrect).toMatchObject({ x: 100, y: 100, width: 300, height: 200 })

    // the view frame sits beside the slot, same size
    const view = node(viewId as string)
    expect(view.type).toBe('frame')
    expect(view.selrect).toMatchObject({ x: 100 + 300 + 40, y: 100, width: 300, height: 200 })
    expect(children(viewId as string)).toEqual(['child', 'inner'])
  })

  it('translates the whole extracted subtree so content lands inside the view frame', async () => {
    await convertFrameToSlot('shell')
    const dx = 300 + 40

    // direct child, nested frame, and its descendant all shift by the same delta
    expect(node('child').selrect).toMatchObject({ x: 120 + dx, y: 120 })
    expect(node('inner').selrect).toMatchObject({ x: 200 + dx, y: 140 })
    expect(node('deep').selrect).toMatchObject({ x: 210 + dx, y: 150 })

    // and the nesting is preserved
    expect(node('child').parentId).toBe(node('shell').views?.[0])
    expect(node('deep').parentId).toBe('inner')
  })

  it('converts an empty frame to an empty slot without inventing a view', async () => {
    seedShell([])

    const viewId = await convertFrameToSlot('shell')
    expect(viewId).toBeNull()

    const slot = node('shell')
    expect(slot.type).toBe('slot')
    expect(slot.views).toEqual([])
    expect(slot.activeView).toBeUndefined()
  })

  // Blocked: doc/commit.ts `cascade()` resolves a del's descendants against the
  // pre-apply state of the whole batch, so the undo frame's `del view` also
  // deletes the children the preceding mods move back under the shell.
  it('undo restores the frame, its children, and their original coordinates', async () => {
    const viewId = await convertFrameToSlot('shell')
    await undo()

    const shell = node('shell')
    expect(shell.type).toBe('frame')
    expect(children('shell')).toEqual(['child', 'inner'])
    expect(shell.views).toBeUndefined()
    // geometry is back where it started
    expect(node('child').selrect).toMatchObject({ x: 120, y: 120 })
    expect(node('deep').selrect).toMatchObject({ x: 210, y: 150 })
    expect(node('child').parentId).toBe('shell')
    // and the extracted view frame is gone
    expect(getNode(viewId as string)).toBeUndefined()
    // the whole conversion was one frame
    expect(canUndo.value).toBe(false)
  })

  it('refuses to convert the page root', async () => {
    expect(await convertFrameToSlot(ROOT)).toBeNull()
    expect(canUndo.value).toBe(false)
  })

  it('slot -> frame clears the references but leaves the view frames alive', async () => {
    const viewId = (await convertFrameToSlot('shell')) as string
    expect(await convertSlotToFrame('shell')).toBe(true)

    const shell = node('shell')
    expect(shell.type).toBe('frame')
    expect(shell.views).toBeUndefined()
    expect(shell.activeView).toBeUndefined()
    // the view is shared/independent — converting back must not consume it
    expect(node(viewId).type).toBe('frame')
    expect(children(viewId)).toEqual(['child', 'inner'])
  })
})
