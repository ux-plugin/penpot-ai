import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPage, IndexedShape } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy, type DocumentMeta } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { undo } from '../../../../src/lib/page-crud'
import { countShapeEdits } from '../../../../src/lib/changes/bulk-changes'
import {
  createComponentFromFrame,
  instantiateComponent,
} from '../../../../src/lib/renderer/component/component-crud'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'

function rect(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h }
}

function makePage(): IndexedPage {
  return {
    id: PAGE_ID,
    objects: {
      [ROOT]: {
        id: ROOT,
        type: 'frame',
        name: 'Root',
        ...rect(0, 0, 2000, 900),
        selrect: rect(0, 0, 2000, 900),
        shapes: ['button'],
      },
      button: {
        id: 'button',
        type: 'frame',
        name: 'Button',
        ...rect(100, 100, 200, 60),
        selrect: rect(100, 100, 200, 60),
        parentId: ROOT,
        frameId: 'button',
        shapes: ['label'],
        fills: [{ fillColor: '#EEEEEE' }],
      },
      label: {
        id: 'label',
        type: 'rect',
        name: 'Label',
        ...rect(110, 115, 100, 30),
        selrect: rect(110, 115, 100, 30),
        parentId: 'button',
        frameId: 'button',
        fills: [{ fillColor: '#111111' }],
        opacity: 1,
      },
    },
  } as unknown as IndexedPage
}

function objects(): Record<string, IndexedShape> {
  return docProxy.pageMap.get(PAGE_ID)?.objects as Record<string, IndexedShape>
}

function node(id: string): Record<string, unknown> {
  return objects()[id] as unknown as Record<string, unknown>
}

function assign(id: string, value: Record<string, unknown>) {
  return {
    type: 'mod-obj' as const,
    id,
    pageId: PAGE_ID,
    operations: [{ type: 'assign' as const, value }],
  }
}

/** Edit an attribute on a main node the way any ordinary editor path would. */
async function editMain(id: string, value: Record<string, unknown>): Promise<void> {
  const before: Record<string, unknown> = {}
  for (const key of Object.keys(value)) before[key] = node(id)[key]
  await commitChanges({
    pageId: PAGE_ID,
    redoChanges: [assign(id, value)],
    undoChanges: [assign(id, before)],
  })
}

/** The copy node mirroring `mainNodeId`, or undefined. */
function copyOf(mainNodeId: string): Record<string, unknown> | undefined {
  return Object.values(objects()).find(
    (n) => (n as { shapeRef?: string }).shapeRef === mainNodeId,
  ) as unknown as Record<string, unknown> | undefined
}

describe('component sync (main edits fanning into copies)', () => {
  beforeEach(() => {
    useHistoryStore.setState({ undoStack: [], redoStack: [], transaction: null })
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, makePage())
    docProxy.currentPageId = PAGE_ID
    docProxy.selectedIds.clear()
    docProxy.meta = {
      name: 'Test doc',
      components: {},
      images: {},
      paintStyles: {},
      textStyles: {},
      componentProperties: {},
      externalLibraries: {},
      missingFonts: [],
      isShared: false,
    } as unknown as DocumentMeta
    useWorkspaceStore.setState({
      workerClient: {
        updatePageWithChanges: vi.fn(async () => {}),
        updatePage: vi.fn(async () => {}),
      } as never,
      renderer: null,
    })
  })

  it('does nothing at all in a document with no components', async () => {
    await editMain('label', { fills: [{ fillColor: '#00FF00' }] })

    const frame = useHistoryStore.getState().undoStack.at(-1)!
    expect(frame.redoChanges).toHaveLength(1)
    expect(node('label').fills).toEqual([{ fillColor: '#00FF00' }])
  })

  it('pushes a main edit into every copy, in the same undo frame', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyA = (await instantiateComponent(componentId, { x: 500, y: 100 }))!
    const copyB = (await instantiateComponent(componentId, { x: 900, y: 100 }))!
    const labelA = (node(copyA).shapes as string[])[0]
    const labelB = (node(copyB).shapes as string[])[0]

    await editMain('label', { fills: [{ fillColor: '#00FF00' }] })

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

    await editMain('button', { fills: [{ fillColor: '#123456' }] })
    expect(node(copyId).fills).toEqual([{ fillColor: '#123456' }])
  })

  it('leaves a group alone on a copy that has touched it', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyA = (await instantiateComponent(componentId, { x: 500, y: 100 }))!
    const copyB = (await instantiateComponent(componentId, { x: 900, y: 100 }))!
    const labelA = (node(copyA).shapes as string[])[0]
    const labelB = (node(copyB).shapes as string[])[0]

    // Copy A's label has a local fill override (P4 will write this on edit).
    await commitChanges({
      pageId: PAGE_ID,
      redoChanges: [assign(labelA, { fills: [{ fillColor: '#AAAAAA' }], touched: ['fill-group'] })],
    })

    await editMain('label', { fills: [{ fillColor: '#00FF00' }], opacity: 0.5 })

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

    await editMain('button', { selrect: rect(100, 100, 400, 60), width: 400 })

    // Deliberate for now: geometry needs rebasing per copy, which rides with
    // structural sync. Asserted so the behaviour is defined, not accidental.
    expect(node(copyId).selrect).toEqual(copyBox)
    expect(node(copyId).width).not.toBe(400)
  })

  it('ignores edits to a detached copy — nothing points at the main any more', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyId = (await instantiateComponent(componentId))!
    const labelCopy = (node(copyId).shapes as string[])[0]

    // Editing the *copy* must never travel back up to the main.
    await commitChanges({
      pageId: PAGE_ID,
      redoChanges: [assign(labelCopy, { fills: [{ fillColor: '#FF00FF' }] })],
    })
    expect(node('label').fills).toEqual([{ fillColor: '#111111' }])
  })

  describe('history size', () => {
    it('costs one change per edited main node regardless of copy count', async () => {
      const componentId = (await createComponentFromFrame('button'))!
      for (let i = 0; i < 20; i++) {
        await instantiateComponent(componentId, { x: 400 + i * 10, y: 400 })
      }

      await editMain('label', { fills: [{ fillColor: '#00FF00' }] })

      const frame = useHistoryStore.getState().undoStack.at(-1)!
      // The user's own change, plus ONE bulk change covering all 20 copies.
      expect(frame.redoChanges).toHaveLength(2)
      expect(frame.undoChanges).toHaveLength(2)
      // ...which still represents 21 shape edits once expanded.
      expect(countShapeEdits(frame.redoChanges)).toBe(21)

      // And every copy really did get it.
      const greens = Object.values(objects()).filter(
        (n) =>
          (n as { shapeRef?: string }).shapeRef === 'label' &&
          JSON.stringify((n as { fills?: unknown }).fills) ===
            JSON.stringify([{ fillColor: '#00FF00' }]),
      )
      expect(greens).toHaveLength(20)
    })
  })

  it('does not re-run during undo replay', async () => {
    const componentId = (await createComponentFromFrame('button'))!
    const copyId = (await instantiateComponent(componentId))!
    const labelCopy = (node(copyId).shapes as string[])[0]

    await editMain('label', { fills: [{ fillColor: '#00FF00' }] })
    const framesAfterEdit = useHistoryStore.getState().undoStack.length

    await undo()
    expect(node(labelCopy).fills).toEqual([{ fillColor: '#111111' }])
    // Replay must not push a new frame of its own.
    expect(useHistoryStore.getState().undoStack.length).toBe(framesAfterEdit - 1)
  })
})
