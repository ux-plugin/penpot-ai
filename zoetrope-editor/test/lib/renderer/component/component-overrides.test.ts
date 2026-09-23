import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { commitChanges } from '../../../../src/lib/renderer/store/commit'
import { children, getNode, mod, undo, type Node } from '../../../../src/lib/doc'
import { makeBaseDocument, resetWorkspace, seedDocument } from '../../fixtures'
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

/** Edit a shape the way any ordinary editor path would. */
async function edit(id: string, value: Record<string, unknown>): Promise<void> {
  await commitChanges({ changes: [mod('node', id, value as Partial<Node>)] })
}

describe('component overrides', () => {
  let componentId: string
  let copyId: string
  let labelCopy: string

  beforeEach(async () => {
    resetWorkspace()
    seedPage()
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })

    componentId = (await createComponentFromFrame('button'))!
    copyId = (await instantiateComponent(componentId, { x: 600, y: 100 }))!
    labelCopy = children(copyId)[0]
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
      const labelB = children(copyB)[0]

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

      // The reset writes the main's values onto the copy as `system` changes;
      // otherwise the commit pipeline would read that as a fresh user edit.
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
