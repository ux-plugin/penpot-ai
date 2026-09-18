import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedPage, IndexedShape } from '../../../../src/lib/worker/types'
import { useWorkspaceStore } from '../../../../src/lib/renderer/store/workspace-store'
import { docProxy, type DocumentMeta } from '../../../../src/lib/renderer/store/doc-proxy'
import { useHistoryStore } from '../../../../src/lib/history/history-store'
import { undo } from '../../../../src/lib/page-crud'
import {
  createComponentFromFrame,
  getComponent,
  instantiateComponent,
} from '../../../../src/lib/renderer/component/component-crud'
import {
  addProp,
  getPropValues,
  removeProp,
  resolvePropValues,
  setPropValue,
  updateProp,
} from '../../../../src/lib/renderer/component/component-props'
import { resetOverrides } from '../../../../src/lib/renderer/component/component-overrides'

const PAGE_ID = 'page1'
const ROOT = '00000000-0000-0000-0000-000000000000'

function rect(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h }
}

function textContent(text: string) {
  return {
    type: 'root',
    verticalAlign: 'top',
    children: [
      {
        type: 'paragraph-set',
        children: [
          { type: 'paragraph', children: [{ type: 'text', text, fills: [{ fillColor: '#000000' }] }] },
        ],
      },
    ],
  }
}

/** Button main: a label (text) and an icon that a boolean prop can hide. */
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
        shapes: ['label', 'icon'],
      },
      label: {
        id: 'label',
        type: 'text',
        name: 'Label',
        ...rect(110, 115, 100, 30),
        selrect: rect(110, 115, 100, 30),
        parentId: 'button',
        frameId: 'button',
        content: textContent('Click me'),
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
    },
  } as unknown as IndexedPage
}

function objects(): Record<string, IndexedShape> {
  return docProxy.pageMap.get(PAGE_ID)?.objects as Record<string, IndexedShape>
}

function node(id: string): Record<string, unknown> {
  return objects()[id] as unknown as Record<string, unknown>
}

/** First text run of a node's content. */
function textOf(id: string): string | undefined {
  const content = node(id).content as Record<string, unknown> | undefined
  const set = (content?.children as Array<Record<string, unknown>>)?.[0]
  const para = (set?.children as Array<Record<string, unknown>>)?.[0]
  const run = (para?.children as Array<Record<string, unknown>>)?.[0]
  return run?.text as string | undefined
}

/** The copy node mirroring `mainNodeId` inside `copyRootId`. */
function twin(copyRootId: string, mainNodeId: string): string {
  const kids = node(copyRootId).shapes as string[]
  const found = kids.find((id) => node(id).shapeRef === mainNodeId)
  if (!found) throw new Error(`no twin of ${mainNodeId}`)
  return found
}

describe('declared component props', () => {
  let componentId: string
  let copyId: string

  beforeEach(async () => {
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

    componentId = (await createComponentFromFrame('button'))!
    copyId = (await instantiateComponent(componentId, { x: 600, y: 100 }))!
  })

  describe('declaration', () => {
    it('adds, updates and removes a prop, each undoable', async () => {
      const propId = (await addProp(componentId, {
        name: 'label',
        type: 'text',
        defaultValue: 'Click me',
        targets: [{ nodeId: 'label', attr: 'content' }],
      }))!
      expect(getComponent(componentId)!.props).toHaveLength(1)

      await updateProp(componentId, propId, { name: 'caption' })
      expect(getComponent(componentId)!.props[0].name).toBe('caption')

      await undo()
      expect(getComponent(componentId)!.props[0].name).toBe('label')

      await removeProp(componentId, propId)
      expect(getComponent(componentId)!.props).toHaveLength(0)

      await undo()
      expect(getComponent(componentId)!.props).toHaveLength(1)
    })

    it('refuses an unknown component or prop', async () => {
      expect(await addProp('nope', { name: 'x', type: 'text', defaultValue: '', targets: [] })).toBeNull()
      expect(await updateProp(componentId, 'nope', { name: 'x' })).toBe(false)
      expect(await removeProp(componentId, 'nope')).toBe(false)
    })
  })

  describe('values', () => {
    it('writes a text prop through to the copy, leaving the main and its siblings alone', async () => {
      const propId = (await addProp(componentId, {
        name: 'label',
        type: 'text',
        defaultValue: 'Click me',
        targets: [{ nodeId: 'label', attr: 'content' }],
      }))!
      const copyB = (await instantiateComponent(componentId, { x: 1000, y: 100 }))!

      expect(await setPropValue(copyId, propId, 'Save')).toBe(true)

      expect(textOf(twin(copyId, 'label'))).toBe('Save')
      expect(textOf('label')).toBe('Click me')
      expect(textOf(twin(copyB, 'label'))).toBe('Click me')
      expect(getPropValues(copyId)).toEqual({ [propId]: 'Save' })
    })

    it('keeps the first run styling when rewriting text', async () => {
      const propId = (await addProp(componentId, {
        name: 'label',
        type: 'text',
        defaultValue: 'Click me',
        targets: [{ nodeId: 'label', attr: 'content' }],
      }))!
      await setPropValue(copyId, propId, 'Save')

      const content = node(twin(copyId, 'label')).content as Record<string, unknown>
      const set = (content.children as Array<Record<string, unknown>>)[0]
      const para = (set.children as Array<Record<string, unknown>>)[0]
      const run = (para.children as Array<Record<string, unknown>>)[0]
      expect(run.fills).toEqual([{ fillColor: '#000000' }])
    })

    it('hides the target for a false boolean prop', async () => {
      const propId = (await addProp(componentId, {
        name: 'showIcon',
        type: 'boolean',
        defaultValue: true,
        targets: [{ nodeId: 'icon', attr: 'hidden' }],
      }))!

      await setPropValue(copyId, propId, false)
      expect(node(twin(copyId, 'icon')).hidden).toBe(true)

      await setPropValue(copyId, propId, true)
      expect(node(twin(copyId, 'icon')).hidden).toBe(false)
    })

    it('is one undo step covering the value and the attribute it drove', async () => {
      const propId = (await addProp(componentId, {
        name: 'label',
        type: 'text',
        defaultValue: 'Click me',
        targets: [{ nodeId: 'label', attr: 'content' }],
      }))!
      await setPropValue(copyId, propId, 'Save')

      await undo()
      expect(textOf(twin(copyId, 'label'))).toBe('Click me')
      expect(getPropValues(copyId)).toEqual({})
    })

    it('protects a prop value from a later main edit', async () => {
      const propId = (await addProp(componentId, {
        name: 'label',
        type: 'text',
        defaultValue: 'Click me',
        targets: [{ nodeId: 'label', attr: 'content' }],
      }))!
      await setPropValue(copyId, propId, 'Save')

      // The main's text moves on; the copy keeps the value its prop set.
      await import('../../../../src/lib/renderer/store/commit').then(({ commitChanges }) =>
        commitChanges({
          pageId: PAGE_ID,
          redoChanges: [
            {
              type: 'mod-obj',
              id: 'label',
              pageId: PAGE_ID,
              operations: [{ type: 'assign', value: { content: textContent('Submit') } }],
            },
          ],
        }),
      )

      expect(textOf('label')).toBe('Submit')
      expect(textOf(twin(copyId, 'label'))).toBe('Save')
    })

    it('resolves declared defaults for props the copy never set', async () => {
      const labelProp = (await addProp(componentId, {
        name: 'label',
        type: 'text',
        defaultValue: 'Click me',
        targets: [{ nodeId: 'label', attr: 'content' }],
      }))!
      await addProp(componentId, {
        name: 'showIcon',
        type: 'boolean',
        defaultValue: true,
        targets: [{ nodeId: 'icon', attr: 'hidden' }],
      })
      await setPropValue(copyId, labelProp, 'Save')

      expect(resolvePropValues(copyId)).toEqual({ label: 'Save', showIcon: true })
    })

    it('refuses a prop type that has no implementation yet', async () => {
      const propId = (await addProp(componentId, {
        name: 'icon',
        type: 'instance-swap',
        defaultValue: null,
        targets: [{ nodeId: 'icon', attr: 'componentId' }],
      }))!
      expect(await setPropValue(copyId, propId, 'other')).toBe(false)
      expect(getPropValues(copyId)).toEqual({})
    })

    it('refuses a main or a non-copy target', async () => {
      const propId = (await addProp(componentId, {
        name: 'label',
        type: 'text',
        defaultValue: 'Click me',
        targets: [{ nodeId: 'label', attr: 'content' }],
      }))!
      expect(await setPropValue('button', propId, 'Save')).toBe(false)
      expect(textOf('label')).toBe('Click me')
    })
  })

  describe('reset', () => {
    it('clears prop values along with freeform overrides', async () => {
      const propId = (await addProp(componentId, {
        name: 'label',
        type: 'text',
        defaultValue: 'Click me',
        targets: [{ nodeId: 'label', attr: 'content' }],
      }))!
      await setPropValue(copyId, propId, 'Save')

      expect(await resetOverrides(copyId)).toBe(true)
      expect(getPropValues(copyId)).toEqual({})
      expect(textOf(twin(copyId, 'label'))).toBe('Click me')
    })
  })
})
