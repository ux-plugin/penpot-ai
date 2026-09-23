import { beforeEach, describe, it, expect } from 'vitest'
import type { PenpotDocument, PenpotPage } from 'penpot-exporter/types'
import { nodesToPresentation } from '../../../../src/lib/renderer/interactions/document/nodes-to-presentation'
import { initRuntime, applyAction, activeSlotView } from '../../../../src/lib/renderer/interactions/preview/runtime'
import { EMPTY_BEHAVIOUR, LIT } from '../../../../src/lib/renderer/interactions/ir'
import type { Action } from '../../../../src/lib/renderer/interactions/ir'
import type { PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { resetWorkspace, seedDocument } from '../../fixtures'

/** Root → shell → slot(outlet) referencing two top-level view frames. */
function slotDoc(activeView?: string): PenpotDocument {
  const page = {
    id: 'p',
    name: 'P',
    children: [
      {
        id: 'shell',
        type: 'frame',
        name: 'Shell',
        children: [{ id: 'outlet', type: 'slot', name: 'Outlet', views: ['home', 'about'], activeView }],
      },
      {
        id: 'home',
        type: 'frame',
        name: 'Home',
        children: [{ id: 'homeTxt', type: 'text', name: 'HomeText', content: 'Home view' }],
      },
      {
        id: 'about',
        type: 'frame',
        name: 'About',
        children: [{ id: 'aboutTxt', type: 'text', name: 'AboutText', content: 'About view' }],
      },
    ],
  } as unknown as PenpotPage
  return {
    name: 'Test',
    children: [page],
    components: {},
    images: {},
    paintStyles: {},
    textStyles: {},
    componentProperties: {},
    externalLibraries: {},
    missingFonts: [],
    isShared: false,
  }
}

/** Seed the slot page and project its outlet. */
function outletOf(activeView?: string): PNode {
  seedDocument(slotDoc(activeView))
  const slot = nodesToPresentation('p')
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

beforeEach(resetWorkspace)

describe('slot preview — document → projection → runtime resolution', () => {
  it('renders the design-time default view before any interaction fires', () => {
    const slot = outletOf('home')
    const rt = initRuntime(EMPTY_BEHAVIOUR)
    expect(shownView(slot, rt.slotViews)?.children?.[0]?.text).toBe('Home view')
  })

  it('a fired show-in-slot swaps the shown view to the targeted one', () => {
    const slot = outletOf('home')
    const show: Action = { type: 'show-in-slot', target: { kind: 'node', node: 'outlet' }, value: LIT('about') }
    const rt = applyAction(show, {}, initRuntime(EMPTY_BEHAVIOUR), EMPTY_BEHAVIOUR)

    expect(rt.slotViews.outlet).toBe('about')
    // the override wins over the 'home' design default
    expect(shownView(slot, rt.slotViews)?.children?.[0]?.text).toBe('About view')
  })

  it('an empty slot (no default, no override) shows nothing', () => {
    const slot = outletOf(undefined)
    const rt = initRuntime(EMPTY_BEHAVIOUR)
    expect(shownView(slot, rt.slotViews)).toBeUndefined()
  })
})
