import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPage } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { dropDegeneratePathOnExit } from '../../../../src/lib/renderer/handlers/path-session'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'
const PATH = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

type Net = { nodes: { x: number; y: number }[]; edges: { a: number; b: number }[] }

function pageWith(network: Net): IndexedPage {
  return {
    id: PAGE_ID,
    objects: {
      [ROOT]: { id: ROOT, type: 'frame', name: 'Root', shapes: [PATH] },
      [PATH]: { id: PATH, type: 'path', parentId: ROOT, frameId: ROOT, content: { network } },
    },
  } as unknown as IndexedPage
}
function present(): boolean {
  const p = docProxy.pageMap.get(PAGE_ID) as IndexedPage | undefined
  return !!p && p.objects[PATH] !== undefined
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('dropDegeneratePathOnExit (pathEditing exit cleanup)', () => {
  beforeEach(() => {
    useHistoryStore.setState({ undoStack: [], redoStack: [], transaction: null, transactionHolders: new Set() })
    docProxy.currentPageId = PAGE_ID
    docProxy.selectedIds.clear()
    useWorkspaceStore.setState({
      workerClient: { updatePageWithChanges: vi.fn(async () => {}), updatePage: vi.fn(async () => {}) } as never,
      renderer: null,
    })
  })

  it('removes a 0-edge path (lone dot) and drops it from selection', async () => {
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, pageWith({ nodes: [{ x: 0, y: 0 }], edges: [] }))
    docProxy.selectedIds.add(PATH)

    dropDegeneratePathOnExit(PATH)
    await flush()

    expect(present()).toBe(false)
    expect(docProxy.selectedIds.has(PATH)).toBe(false)
  })

  it('keeps a path that has at least one edge', async () => {
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, pageWith({ nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }], edges: [{ a: 0, b: 1 }] }))

    dropDegeneratePathOnExit(PATH)
    await flush()

    expect(present()).toBe(true)
  })

  it('no-ops for a null shape id', async () => {
    docProxy.pageMap.clear()
    docProxy.pageMap.set(PAGE_ID, pageWith({ nodes: [{ x: 0, y: 0 }], edges: [] }))

    dropDegeneratePathOnExit(null)
    await flush()

    expect(present()).toBe(true)
  })
})
