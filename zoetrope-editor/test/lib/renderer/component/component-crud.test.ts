import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { children, getNode, meta, records, undo, type DocumentMeta } from '../../../../src/lib/doc'
import { makeBaseDocument, resetWorkspace, ROOT, seedDocument } from '../../fixtures'
import {
  createComponentFromFrame,
  deleteComponent,
  detachCopy,
  getComponent,
  instantiateComponent,
  listComponents,
} from '../../../../src/lib/renderer/component/component-crud'

const PAGE_ID = 'page1'

function box(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h, selrect: { x, y, width: w, height: h } }
}

const frame = (id: string, name: string, b: ReturnType<typeof box>, kids: PenpotNode[] = []): PenpotNode =>
  ({ id, type: 'frame', name, ...b, children: kids }) as unknown as PenpotNode
const rect = (id: string, name: string, b: ReturnType<typeof box>): PenpotNode =>
  ({ id, type: 'rect', name, ...b }) as unknown as PenpotNode

/** A two-child "Button" frame to promote, plus an unrelated frame. */
function seedPage(): void {
  seedDocument({
    ...makeBaseDocument(),
    children: [
      {
        id: PAGE_ID,
        name: 'Page',
        background: '#FFFFFF',
        children: [
          frame('button', 'Button', box(100, 100, 200, 60), [
            rect('label', 'Label', box(110, 115, 100, 30)),
            rect('icon', 'Icon', box(250, 115, 30, 30)),
          ]),
          frame('other', 'Other', box(600, 100, 200, 60)),
        ],
      },
    ],
  })
}

const node = (id: string): Record<string, unknown> => getNode(id) as unknown as Record<string, unknown>

/** Ids of every node in the document that is part of a copy. */
const copyMemberIds = (): string[] => [...records('node')].filter((n) => n.shapeRef != null).map((n) => n.id)

describe('component CRUD (integration through the commit pipeline)', () => {
  beforeEach(() => {
    resetWorkspace()
    seedPage()
    useWorkspaceStore.setState({ workerClient: { applyChanges: vi.fn(async () => {}) } as never, renderer: null })
  })

  describe('createComponentFromFrame', () => {
    it('flags the frame and registers the library record, both undone in one step', async () => {
      const componentId = await createComponentFromFrame('button')
      expect(componentId).toBeTruthy()

      expect(node('button').componentId).toBe(componentId)
      expect(node('button').mainInstance).toBe(true)
      expect(node('button').componentRoot).toBe(true)
      // The frame keeps its id, box and children — promotion is in place.
      expect(children('button')).toEqual(['label', 'icon'])

      const listed = listComponents()
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        id: componentId,
        name: 'Button',
        mainInstanceId: 'button',
        mainInstancePage: PAGE_ID,
        props: [],
      })

      await undo()
      expect(node('button').componentId).toBeUndefined()
      expect(node('button').mainInstance).toBeUndefined()
      expect(listComponents()).toHaveLength(0)
    })

    it('refuses the page root, a non-frame, and a frame that is already a main', async () => {
      expect(await createComponentFromFrame(ROOT)).toBeNull()
      expect(await createComponentFromFrame('label')).toBeNull()

      expect(await createComponentFromFrame('button')).toBeTruthy()
      expect(await createComponentFromFrame('button')).toBeNull()
      expect(listComponents()).toHaveLength(1)
    })
  })

  describe('instantiateComponent', () => {
    it('copies the subtree with fresh ids, a shapeRef per node, and a shifted box', async () => {
      const componentId = (await createComponentFromFrame('button'))!
      const copyId = await instantiateComponent(componentId)
      expect(copyId).toBeTruthy()

      const copy = node(copyId!)
      expect(copy.componentId).toBe(componentId)
      expect(copy.componentRoot).toBe(true)
      expect(copy.shapeRef).toBe('button')
      // The main flag never travels with a copy.
      expect(copy.mainInstance).toBeUndefined()
      expect(copy.id).not.toBe('button')

      // Default placement is beside the main: x + width + gap.
      expect((copy.selrect as { x: number }).x).toBe(100 + 200 + 40)
      expect((copy.selrect as { y: number }).y).toBe(100)

      const kids = children(copyId!)
      expect(kids).toHaveLength(2)
      expect(kids.map((id) => node(id).shapeRef)).toEqual(['label', 'icon'])
      // Fresh ids throughout, and children point at the copy root, not the main.
      expect(kids).not.toContain('label')
      for (const id of kids) expect(node(id).parentId).toBe(copyId)
      // Only the root carries the component link.
      for (const id of kids) expect(node(id).componentId).toBeUndefined()

      // Descendants are shifted by the same delta as the root.
      expect((node(kids[0]).selrect as { x: number }).x).toBe(110 + 240)
    })

    it('leaves the main untouched and is undone by a single step', async () => {
      const componentId = (await createComponentFromFrame('button'))!
      const copyId = (await instantiateComponent(componentId))!

      expect(children('button')).toEqual(['label', 'icon'])
      expect((node('button').selrect as { x: number }).x).toBe(100)

      await undo()
      expect(getNode(copyId)).toBeUndefined()
      // The whole subtree goes with it, and the page no longer lists it.
      expect(copyMemberIds()).toHaveLength(0)
      expect(children(PAGE_ID)).toEqual(['button', 'other'])
      // The component itself survives — only the copy was undone.
      expect(getComponent(componentId)).toBeTruthy()
    })

    it('places the copy at an explicit position when given one', async () => {
      const componentId = (await createComponentFromFrame('button'))!
      const copyId = (await instantiateComponent(componentId, { x: 700, y: 400 }))!

      expect((node(copyId).selrect as { x: number }).x).toBe(700)
      expect((node(copyId).selrect as { y: number }).y).toBe(400)
      const child = children(copyId)[0]
      expect((node(child).selrect as { x: number }).x).toBe(110 + 600)
    })

    it('returns null for an unknown component', async () => {
      expect(await instantiateComponent('nope')).toBeNull()
    })
  })

  describe('detachCopy', () => {
    it('strips the component fields from the whole subtree, restored by undo', async () => {
      const componentId = (await createComponentFromFrame('button'))!
      const copyId = (await instantiateComponent(componentId))!
      const kids = [...children(copyId)]

      expect(await detachCopy(copyId)).toBe(true)
      expect(node(copyId).componentId).toBeUndefined()
      expect(node(copyId).componentRoot).toBeUndefined()
      expect(node(copyId).shapeRef).toBeUndefined()
      for (const id of kids) expect(node(id).shapeRef).toBeUndefined()
      // The shapes themselves survive detaching — only the links go.
      expect(children(copyId)).toEqual(kids)

      await undo()
      expect(node(copyId).componentId).toBe(componentId)
      expect(node(copyId).shapeRef).toBe('button')
      expect(node(kids[0]).shapeRef).toBe('label')
    })

    it('refuses a main instance', async () => {
      await createComponentFromFrame('button')
      expect(await detachCopy('button')).toBe(false)
      expect(node('button').mainInstance).toBe(true)
    })
  })

  describe('deleteComponent', () => {
    it('drops the record and detaches the main and every copy, undone in one step', async () => {
      const componentId = (await createComponentFromFrame('button'))!
      const copyId = (await instantiateComponent(componentId))!
      const kids = children(copyId)

      expect(await deleteComponent(componentId)).toBe(true)
      expect(listComponents()).toHaveLength(0)
      expect(node('button').componentId).toBeUndefined()
      expect(node('button').mainInstance).toBeUndefined()
      expect(node(copyId).componentId).toBeUndefined()
      expect(node(kids[0]).shapeRef).toBeUndefined()
      // Nothing is deleted from the canvas — the shapes stay, unlinked.
      expect(getNode(copyId)).toBeTruthy()

      await undo()
      expect(listComponents()).toHaveLength(1)
      expect(node('button').mainInstance).toBe(true)
      expect(node(copyId).componentId).toBe(componentId)
      expect(node(kids[0]).shapeRef).toBe('label')
    })
  })

  describe('imported components are left alone', () => {
    it('ignores library entries that carry no main instance', () => {
      meta.value = {
        ...meta.peek()!,
        // The thinner shape the Figma adapter writes on import.
        components: { imported: { name: 'Imported', componentId: 'imported' } },
      } as unknown as DocumentMeta

      expect(listComponents()).toHaveLength(0)
      expect(getComponent('imported')).toBeUndefined()
    })
  })
})
