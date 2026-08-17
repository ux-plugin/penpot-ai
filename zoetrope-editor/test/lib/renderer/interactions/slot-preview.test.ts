import { describe, it, expect } from 'vitest'
import type { IndexedPage } from '../../../../src/lib/worker/types'
import { nodesToPresentation } from '../../../../src/lib/renderer/interactions/document/nodes-to-presentation'
import { initRuntime, applyAction, activeSlotView } from '../../../../src/lib/renderer/interactions/preview/runtime'
import { emptyPageInteractions } from '../../../../src/lib/renderer/interactions/ir'
import type { Action } from '../../../../src/lib/renderer/interactions/ir'
import type { PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'

const ZERO = '00000000-0000-0000-0000-000000000000'

/** Root → shell → slot(outlet) referencing two top-level view frames. */
function slotPage(activeView?: string): IndexedPage {
  const objects: Record<string, unknown> = {
    [ZERO]: { id: ZERO, type: 'frame', name: 'Root', parentId: null, shapes: ['shell', 'home', 'about'] },
    shell: { id: 'shell', type: 'frame', name: 'Shell', parentId: ZERO, shapes: ['outlet'] },
    outlet: { id: 'outlet', type: 'slot', name: 'Outlet', parentId: 'shell', views: ['home', 'about'], activeView },
    home: { id: 'home', type: 'frame', name: 'Home', parentId: ZERO, shapes: ['homeTxt'] },
    homeTxt: { id: 'homeTxt', type: 'text', name: 'HomeText', parentId: 'home', content: 'Home view' },
    about: { id: 'about', type: 'frame', name: 'About', parentId: ZERO, shapes: ['aboutTxt'] },
    aboutTxt: { id: 'aboutTxt', type: 'text', name: 'AboutText', parentId: 'about', content: 'About view' },
  }
  return { id: 'p', name: 'P', objects } as unknown as IndexedPage
}

function outletOf(page: IndexedPage): PNode {
  const slot = nodesToPresentation(page)
    ?.children?.find((c) => c.nodeId === 'shell')
    ?.children?.find((c) => c.nodeId === 'outlet')
  if (!slot?.slot) throw new Error('expected a projected slot')
  return slot
}

/** The exact resolution InteractionRuntime performs: pick the view PNode to render. */
function shownView(slot: PNode, slotViews: Record<string, string>): PNode | undefined {
  const id = activeSlotView(slotViews, slot.nodeId, slot.slot?.activeView)
  return id ? slot.slot?.views[id] : undefined
}

describe('slot preview — document → projection → runtime resolution', () => {
  it('renders the design-time default view before any interaction fires', () => {
    const slot = outletOf(slotPage('home'))
    const rt = initRuntime(emptyPageInteractions())
    expect(shownView(slot, rt.slotViews)?.children?.[0]?.text).toBe('Home view')
  })

  it('a fired show-in-slot swaps the shown view to the targeted one', () => {
    const slot = outletOf(slotPage('home'))
    const show: Action = { type: 'show-in-slot', target: 'outlet', value: 'about' }
    const rt = applyAction(show, {}, initRuntime(emptyPageInteractions()))

    expect(rt.slotViews.outlet).toBe('about')
    // the override wins over the 'home' design default
    expect(shownView(slot, rt.slotViews)?.children?.[0]?.text).toBe('About view')
  })

  it('an empty slot (no default, no override) shows nothing', () => {
    const slot = outletOf(slotPage(undefined))
    const rt = initRuntime(emptyPageInteractions())
    expect(shownView(slot, rt.slotViews)).toBeUndefined()
  })
})
