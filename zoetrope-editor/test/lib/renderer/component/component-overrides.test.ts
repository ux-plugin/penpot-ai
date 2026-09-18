import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPage, IndexedShape } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy, type DocumentMeta } from '../../../../src/lib/renderer/store/doc-proxy'
import { useJournalStore } from '../../../../src/lib/history/journal/journal-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { undo } from '../../../../src/lib/page-crud'
import {
  createComponentFromFrame,
  instantiateComponent,
} from '../../../../src/lib/renderer/component/component-crud'
import {
  hasOverrides,
  listOverrides,
  resetOverrides,
} from '../../../../src/lib/renderer/component/component-overrides'

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

/** Edit a shape the way any ordinary editor path would. */
async function edit(id: string, value: Record<string, unknown>): Promise<void> {
  const before: Record<string, unknown> = {}
  for (const key of Object.keys(value)) before[key] = node(id)[key]
  await commitChanges({
    pageId: PAGE_ID,
    redoChanges: [assign(id, value)],
    undoChanges: [assign(id, before)],
  })
}

describe('component overrides', () => {
  let componentId: string
  let copyId: string
  let labelCopy: string

  beforeEach(async () => {
    useJournalStore.getState().clear()
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

    componentId = (await createComponentFromFrame('button'))!
    copyId = (await instantiateComponent(componentId, { x: 600, y: 100 }))!
    labelCopy = (node(copyId).shapes as string[])[0]
  })

  describe('marking', () => {
    it('freezes the edited attribute group on the copy node', async () => {
      await edit(labelCopy, { fills: [{ fillColor: '#FF0000' }] })

      expect(node(labelCopy).touched).toEqual(['fill-group'])
      expect(listOverrides(copyId)).toEqual([{ id: labelCopy, groups: ['fill-group'] }])
      expect(hasOverrides(copyId)).toBe(true)
    })

    it('leaves the main and sibling copies alone', async () => {
      const copyB = (await instantiateComponent(componentId, { x: 1000, y: 100 }))!
      const labelB = (node(copyB).shapes as string[])[0]

      await edit(labelCopy, { fills: [{ fillColor: '#FF0000' }] })

      expect(node('label').fills).toEqual([{ fillColor: '#111111' }])
      expect(node('label').touched).toBeUndefined()
      expect(node(labelB).touched).toBeUndefined()
    })

    it('accumulates groups across separate edits', async () => {
      await edit(labelCopy, { fills: [{ fillColor: '#FF0000' }] })
      await edit(labelCopy, { opacity: 0.25 })

      expect(node(labelCopy).touched).toEqual(['fill-group', 'layer-effects-group'])
    })

    it('marks nothing when the write does not change the value', async () => {
      await edit(labelCopy, { fills: [{ fillColor: '#111111' }] })
      expect(node(labelCopy).touched).toBeUndefined()
    })

    it('marks nothing for attributes outside the sync table', async () => {
      await edit(labelCopy, { name: 'Renamed' })
      expect(node(labelCopy).touched).toEqual(['name-group'])

      await edit(labelCopy, { someInternalFlag: true })
      // Unchanged — an unknown attribute belongs to no group.
      expect(node(labelCopy).touched).toEqual(['name-group'])
    })

    it('does not treat moving a copy as an override of its geometry', async () => {
      await edit(copyId, { selrect: rect(700, 300, 200, 60), x: 700, y: 300 })

      // Every copy sits at its own position by construction; if this marked
      // geometry, moving a copy once would freeze it against the main forever.
      expect(node(copyId).touched).toBeUndefined()
    })

    it('is reverted along with the edit that caused it', async () => {
      await edit(labelCopy, { fills: [{ fillColor: '#FF0000' }] })
      await undo()

      expect(node(labelCopy).fills).toEqual([{ fillColor: '#111111' }])
      expect(node(labelCopy).touched).toBeUndefined()
    })

    it('makes the copy ignore later main edits to that group only', async () => {
      await edit(labelCopy, { fills: [{ fillColor: '#FF0000' }] })
      await edit('label', { fills: [{ fillColor: '#00FF00' }], opacity: 0.5 })

      expect(node(labelCopy).fills).toEqual([{ fillColor: '#FF0000' }])
      expect(node(labelCopy).opacity).toBe(0.5)
    })
  })

  describe('token bindings', () => {
    it('syncs a rebound token from the main into copies', async () => {
      await edit('label', { appliedTokens: { fill: 'color.base' } })
      expect(node(labelCopy).appliedTokens).toEqual({ fill: 'color.base' })

      await edit('label', { appliedTokens: { fill: 'color.danger' } })
      expect(node(labelCopy).appliedTokens).toEqual({ fill: 'color.danger' })
    })

    it('merges key by key rather than replacing the map', async () => {
      // The copy binds a stroke token of its own; the main knows nothing about it.
      await edit(labelCopy, { appliedTokens: { strokeColor: 'color.accent' } })
      await edit('label', { appliedTokens: { fill: 'color.base' } })

      // The main's new key arrives without wiping the copy's own binding.
      expect(node(labelCopy).appliedTokens).toEqual({
        strokeColor: 'color.accent',
        fill: 'color.base',
      })
    })

    it('freezes only the overridden key, leaving sibling bindings tracking', async () => {
      await edit('label', { appliedTokens: { fill: 'color.base', strokeColor: 'color.line' } })
      // The user rebinds just the fill on this copy.
      await edit(labelCopy, { appliedTokens: { fill: 'color.brand', strokeColor: 'color.line' } })

      expect(node(labelCopy).touched).toEqual(['applied-token/fill'])

      await edit('label', { appliedTokens: { fill: 'color.danger', strokeColor: 'color.ink' } })
      expect(node(labelCopy).appliedTokens).toEqual({
        fill: 'color.brand', // overridden, held
        strokeColor: 'color.ink', // never touched, followed
      })
    })

    it('drops a binding the main removed', async () => {
      await edit('label', { appliedTokens: { fill: 'color.base' } })
      await edit('label', { appliedTokens: {} })
      expect(node(labelCopy).appliedTokens).toEqual({})
    })

    it('restores one binding on reset, leaving the rest alone', async () => {
      await edit('label', { appliedTokens: { fill: 'color.base', strokeColor: 'color.line' } })
      await edit(labelCopy, { appliedTokens: { fill: 'color.brand', strokeColor: 'color.line' } })

      expect(await resetOverrides(copyId)).toBe(true)
      expect(node(labelCopy).appliedTokens).toEqual({
        fill: 'color.base',
        strokeColor: 'color.line',
      })
      expect(node(labelCopy).touched).toBeUndefined()
    })
  })

  describe('resetOverrides', () => {
    it('takes the main value back and clears the flag', async () => {
      await edit(labelCopy, { fills: [{ fillColor: '#FF0000' }] })

      expect(await resetOverrides(copyId)).toBe(true)
      expect(node(labelCopy).fills).toEqual([{ fillColor: '#111111' }])
      expect(node(labelCopy).touched).toBeUndefined()
      expect(hasOverrides(copyId)).toBe(false)
    })

    it('restores only the overridden group, leaving other drift alone', async () => {
      // The copy overrode its fill; meanwhile the main moved on in another group.
      await edit(labelCopy, { fills: [{ fillColor: '#FF0000' }] })
      await edit('label', { opacity: 0.5 })

      await resetOverrides(copyId)
      expect(node(labelCopy).fills).toEqual([{ fillColor: '#111111' }])
      // opacity was never overridden — it already tracked the main and still does.
      expect(node(labelCopy).opacity).toBe(0.5)
    })

    it('does not re-mark what it just cleared', async () => {
      await edit(labelCopy, { fills: [{ fillColor: '#FF0000' }] })
      await resetOverrides(copyId)

      // The reset writes the main's values onto the copy; without ignoreTouched
      // the commit pipeline would read that as a fresh user edit.
      expect(node(labelCopy).touched).toBeUndefined()
    })

    it('is one undo step, restoring both the value and the flag', async () => {
      await edit(labelCopy, { fills: [{ fillColor: '#FF0000' }] })
      await resetOverrides(copyId)

      await undo()
      expect(node(labelCopy).fills).toEqual([{ fillColor: '#FF0000' }])
      expect(node(labelCopy).touched).toEqual(['fill-group'])
    })

    it('returns false when there is nothing to reset, or the target is not a copy', async () => {
      expect(await resetOverrides(copyId)).toBe(false)
      expect(await resetOverrides('button')).toBe(false)
      expect(listOverrides('button')).toEqual([])
    })
  })
})
