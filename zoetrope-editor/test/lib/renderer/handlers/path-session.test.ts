import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { getNode } from '../../../../src/lib/doc'
import { getSelectedIdsSet, setSelectedIds } from '../../../../src/lib/renderer/store/document-selection'
import { makeBaseDocument, resetWorkspace, seedDocument } from '../../fixtures'
import { dropDegeneratePathOnExit } from '../../../../src/lib/renderer/handlers/path-session'

const PAGE_ID = 'page1'
const PATH = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

type Net = { nodes: { x: number; y: number }[]; edges: { a: number; b: number }[] }

function seedPath(network: Net): void {
  seedDocument({
    ...makeBaseDocument(),
    children: [
      {
        id: PAGE_ID,
        name: 'Page',
        background: '#FFFFFF',
        children: [{ id: PATH, type: 'path', name: 'Path', content: { network } } as unknown as PenpotNode],
      },
    ],
  })
}
const present = (): boolean => getNode(PATH) !== undefined
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('dropDegeneratePathOnExit (pathEditing exit cleanup)', () => {
  beforeEach(() => {
    resetWorkspace()
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
  })

  it('removes a 0-edge path (lone dot) and drops it from selection', async () => {
    seedPath({ nodes: [{ x: 0, y: 0 }], edges: [] })
    setSelectedIds([PATH])

    dropDegeneratePathOnExit(PATH)
    await flush()

    expect(present()).toBe(false)
    expect(getSelectedIdsSet().has(PATH)).toBe(false)
  })

  it('keeps a path that has at least one edge', async () => {
    seedPath({ nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }], edges: [{ a: 0, b: 1 }] })

    dropDegeneratePathOnExit(PATH)
    await flush()

    expect(present()).toBe(true)
  })

  it('no-ops for a null shape id', async () => {
    seedPath({ nodes: [{ x: 0, y: 0 }], edges: [] })

    dropDegeneratePathOnExit(null)
    await flush()

    expect(present()).toBe(true)
  })
})
