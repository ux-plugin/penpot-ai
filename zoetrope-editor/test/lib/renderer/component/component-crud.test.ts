import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPage, IndexedShape } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy, type DocumentMeta } from '../../../../src/lib/renderer/store/doc-proxy'
import { useJournalStore } from '../../../../src/lib/history/journal/journal-store'
import { undo } from '../../../../src/lib/page-crud'
import {
  createComponentFromFrame,
  deleteComponent,
  detachCopy,
  getComponent,
  instantiateComponent,
  listComponents,
} from '../../../../src/lib/renderer/component/component-crud'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'

function rect(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h }
}

/** Root + a two-child "Button" frame to promote, plus an unrelated frame. */
function makePage(): IndexedPage {
  return {
    id: PAGE_ID,
    objects: {
      [ROOT]: {
        id: ROOT,
        type: 'frame',
        name: 'Root',
        ...rect(0, 0, 1200, 800),
        selrect: rect(0, 0, 1200, 800),
        shapes: ['button', 'other'],
      },
      button: {
        id: 'button',
        type: 'frame',
        name: 'Button',
        ...rect(100, 100, 200, 60),
        selrect: rect(100, 100, 200, 60),
        parentId: ROOT,
        frameId: 'button',
        shapes: ['label', 'icon'],
      },
      label: {
        id: 'label',
        type: 'rect',
        name: 'Label',
        ...rect(110, 115, 100, 30),
        selrect: rect(110, 115, 100, 30),
        parentId: 'button',
        frameId: 'button',
      },
      icon: {
        id: 'icon',
        type: 'rect',
        name: 'Icon',
        ...rect(250, 115, 30, 30),
        selrect: rect(250, 115, 30, 30),
        parentId: 'button',
        frameId: 'button',
      },
      other: {
        id: 'other',
        type: 'frame',
        name: 'Other',
        ...rect(600, 100, 200, 60),
        selrect: rect(600, 100, 200, 60),
        parentId: ROOT,
        shapes: [],
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

/** Ids of every node in the page that is part of a copy. */
function copyMemberIds(): string[] {
  return Object.entries(objects())
    .filter(([, n]) => (n as { shapeRef?: string }).shapeRef != null)
    .map(([id]) => id)
}

describe('component CRUD (integration through the commit pipeline)', () => {
  beforeEach(() => {
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
  })

  describe('createComponentFromFrame', () => {
    it('flags the frame and registers the library record, both undone in one step', async () => {
      const componentId = await createComponentFromFrame('button')
      expect(componentId).toBeTruthy()

      expect(node('button').componentId).toBe(componentId)
      expect(node('button').mainInstance).toBe(true)
      expect(node('button').componentRoot).toBe(true)
      // The frame keeps its id, box and children — promotion is in place.
      expect(node('button').shapes).toEqual(['label', 'icon'])

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

      const children = copy.shapes as string[]
      expect(children).toHaveLength(2)
      const refs = children.map((id) => node(id).shapeRef)
      expect(refs).toEqual(['label', 'icon'])
      // Fresh ids throughout, and children point at the copy root, not the main.
      expect(children).not.toContain('label')
      for (const id of children) expect(node(id).parentId).toBe(copyId)
      // Only the root carries the component link.
      for (const id of children) expect(node(id).componentId).toBeUndefined()

      // Descendants are shifted by the same delta as the root.
      expect((node(children[0]).selrect as { x: number }).x).toBe(110 + 240)
    })

    it('leaves the main untouched and is undone by a single step', async () => {
      const componentId = (await createComponentFromFrame('button'))!
      const copyId = (await instantiateComponent(componentId))!

      expect(node('button').shapes).toEqual(['label', 'icon'])
      expect((node('button').selrect as { x: number }).x).toBe(100)

      await undo()
      expect(objects()[copyId]).toBeUndefined()
      // The whole subtree goes with it, and the page root no longer lists it.
      expect(copyMemberIds()).toHaveLength(0)
      expect(node(ROOT).shapes).toEqual(['button', 'other'])
      // The component itself survives — only the copy was undone.
      expect(getComponent(componentId)).toBeTruthy()
    })

    it('places the copy at an explicit position when given one', async () => {
      const componentId = (await createComponentFromFrame('button'))!
      const copyId = (await instantiateComponent(componentId, { x: 700, y: 400 }))!

      expect((node(copyId).selrect as { x: number }).x).toBe(700)
      expect((node(copyId).selrect as { y: number }).y).toBe(400)
      const child = (node(copyId).shapes as string[])[0]
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
      const children = node(copyId).shapes as string[]

      expect(await detachCopy(copyId)).toBe(true)
      expect(node(copyId).componentId).toBeUndefined()
      expect(node(copyId).componentRoot).toBeUndefined()
      expect(node(copyId).shapeRef).toBeUndefined()
      for (const id of children) expect(node(id).shapeRef).toBeUndefined()
      // The shapes themselves survive detaching — only the links go.
      expect(node(copyId).shapes).toEqual(children)

      await undo()
      expect(node(copyId).componentId).toBe(componentId)
      expect(node(copyId).shapeRef).toBe('button')
      expect(node(children[0]).shapeRef).toBe('label')
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
      const children = node(copyId).shapes as string[]

      expect(await deleteComponent(componentId)).toBe(true)
      expect(listComponents()).toHaveLength(0)
      expect(node('button').componentId).toBeUndefined()
      expect(node('button').mainInstance).toBeUndefined()
      expect(node(copyId).componentId).toBeUndefined()
      expect(node(children[0]).shapeRef).toBeUndefined()
      // Nothing is deleted from the canvas — the shapes stay, unlinked.
      expect(objects()[copyId]).toBeTruthy()

      await undo()
      expect(listComponents()).toHaveLength(1)
      expect(node('button').mainInstance).toBe(true)
      expect(node(copyId).componentId).toBe(componentId)
      expect(node(children[0]).shapeRef).toBe('label')
    })
  })

  describe('imported components are left alone', () => {
    it('ignores library entries that carry no main instance', () => {
      docProxy.meta = {
        ...(docProxy.meta as DocumentMeta),
        // The thinner shape the Figma adapter writes on import.
        components: { imported: { name: 'Imported', componentId: 'imported' } },
      } as unknown as DocumentMeta

      expect(listComponents()).toHaveLength(0)
      expect(getComponent('imported')).toBeUndefined()
    })
  })
})
