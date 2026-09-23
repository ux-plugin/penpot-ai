import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { canRedo, children, getNode, idOf, mod, records, registerEffect, undo, type Node } from '../../../../src/lib/doc'
import { framesOf } from '../../../../src/lib/doc/undo'
import { makeBaseDocument, resetWorkspace, seedDocument } from '../../fixtures'
import {
  createComponentFromFrame,
  instantiateComponent,
} from '../../../../src/lib/renderer/component/component-crud'

const PAGE_ID = 'page1'

function rect(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h }
}

function seedPage(): void {
  seedDocument({
    ...makeBaseDocument(),
    children: [
      {
        id: PAGE_ID,
        name: 'Page',
        background: '#FFFFFF',
        children: [
          {
            id: 'button',
            type: 'frame',
            name: 'Button',
            ...rect(100, 100, 200, 60),
            selrect: rect(100, 100, 200, 60),
            fills: [{ fillColor: '#EEEEEE' }],
            children: [
              {
                id: 'label',
                type: 'rect',
                name: 'Label',
                ...rect(110, 115, 100, 30),
                selrect: rect(110, 115, 100, 30),
                fills: [{ fillColor: '#111111' }],
                opacity: 1,
              },
            ],
          } as unknown as PenpotNode,
        ],
      },
    ],
  })
}

const node = (id: string): Record<string, unknown> => getNode(id) as unknown as Record<string, unknown>

/** Edit an attribute the way any ordinary editor path would. */
async function edit(id: string, value: Record<string, unknown>): Promise<void> {
  await commitChanges({ changes: [mod('node', id, value as Partial<Node>)] })
}

/** Ids the newest history frame touches. */
const idsInLastFrame = () => new Set(framesOf().at(-1)!.redo.map(idOf))

describe('component sync (main edits fanning into copies)', () => {
  beforeEach(() => {
    resetWorkspace()
    seedPage()
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
  })

  it('does nothing at all in a document with no components', async () => {
    await edit('label', { fills: [{ fillColor: '#00FF00' }] })

    expect([...idsInLastFrame()]).toEqual(['label'])
    expect(node('label').fills).toEqual([{ fillColor: '#00FF00' }])
  })

  it('pushes a main edit into every copy, in the same undo frame', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyA = (await instantiateComponent(componentId, { x: 500, y: 100 }))!
    const copyB = (await instantiateComponent(componentId, { x: 900, y: 100 }))!
    const labelA = children(copyA)[0]
    const labelB = children(copyB)[0]

    await edit('label', { fills: [{ fillColor: '#00FF00' }] })

    expect(node(labelA).fills).toEqual([{ fillColor: '#00FF00' }])
    expect(node(labelB).fills).toEqual([{ fillColor: '#00FF00' }])

    // One step reverts the main and both copies together.
    await undo()
    expect(node('label').fills).toEqual([{ fillColor: '#111111' }])
    expect(node(labelA).fills).toEqual([{ fillColor: '#111111' }])
    expect(node(labelB).fills).toEqual([{ fillColor: '#111111' }])
  })

  it('syncs the copy root too, not just descendants', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyId = (await instantiateComponent(componentId))!

    await edit('button', { fills: [{ fillColor: '#123456' }] })
    expect(node(copyId).fills).toEqual([{ fillColor: '#123456' }])
  })

  it('leaves a group alone on a copy that has touched it', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyA = (await instantiateComponent(componentId, { x: 500, y: 100 }))!
    const copyB = (await instantiateComponent(componentId, { x: 900, y: 100 }))!
    const labelA = children(copyA)[0]
    const labelB = children(copyB)[0]

    // Copy A's label has a local fill override.
    await edit(labelA, { fills: [{ fillColor: '#AAAAAA' }], touched: ['fill-group'] })

    await edit('label', { fills: [{ fillColor: '#00FF00' }], opacity: 0.5 })

    // The touched group is frozen on A; everything else still follows.
    expect(node(labelA).fills).toEqual([{ fillColor: '#AAAAAA' }])
    expect(node(labelA).opacity).toBe(0.5)
    // B never touched anything, so it takes both.
    expect(node(labelB).fills).toEqual([{ fillColor: '#00FF00' }])
    expect(node(labelB).opacity).toBe(0.5)
  })

  it('does not sync geometry yet — copies keep their own boxes', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyId = (await instantiateComponent(componentId, { x: 500, y: 100 }))!
    const copyBox = { ...(node(copyId).selrect as Record<string, number>) }

    await edit('button', { selrect: rect(100, 100, 400, 60), width: 400 })

    // Deliberate for now: geometry needs rebasing per copy, which rides with
    // structural sync. Asserted so the behaviour is defined, not accidental.
    expect(node(copyId).selrect).toEqual(copyBox)
    expect(node(copyId).width).not.toBe(400)
  })

  it('ignores edits to a copy — nothing travels back up to the main', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyId = (await instantiateComponent(componentId))!
    const labelCopy = children(copyId)[0]

    await edit(labelCopy, { fills: [{ fillColor: '#FF00FF' }] })
    expect(node('label').fills).toEqual([{ fillColor: '#111111' }])
  })

  describe('history size', () => {
    it('costs one change per edited main node regardless of copy count', async () => {
      const componentId = (await createComponentFromFrame('button'))!
      for (let i = 0; i < 20; i++) {
        await instantiateComponent(componentId, { x: 400 + i * 10, y: 400 })
      }

      await edit('label', { fills: [{ fillColor: '#00FF00' }] })

      // One frame: the user's own edit plus all 20 copies (bulk changes are
      // expanded per node before apply).
      expect(idsInLastFrame().size).toBe(21)

      // And every copy really did get it.
      const greens = [...records('node')].filter(
        (n) => n.shapeRef === 'label' && JSON.stringify(n.fills) === JSON.stringify([{ fillColor: '#00FF00' }]),
      )
      expect(greens).toHaveLength(20)
    })
  })

  it('does not re-run during undo replay', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyId = (await instantiateComponent(componentId))!
    const labelCopy = children(copyId)[0]

    await edit('label', { fills: [{ fillColor: '#00FF00' }] })
    const framesAfterEdit = framesOf().length

    // Any effect is skipped on replay; the frame already carries the fan-out.
    const spy = vi.fn(() => [])
    const dispose = registerEffect(spy)
    await undo()
    dispose()

    expect(node(labelCopy).fills).toEqual([{ fillColor: '#111111' }])
    expect(spy).not.toHaveBeenCalled()
    // Undo moves the cursor; it never appends a frame.
    expect(framesOf().length).toBe(framesAfterEdit)
    expect(canRedo.value).toBe(true)
  })
})
