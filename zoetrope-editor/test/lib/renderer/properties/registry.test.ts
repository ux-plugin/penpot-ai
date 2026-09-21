import { describe, it, expect, beforeAll } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { getDef, listDefs, propertiesOf, propId, resolve } from '../../../../src/lib/renderer/properties/registry'
import { reinitProperties } from '../../../../src/lib/renderer/properties/shapes'
import { TOKEN_TYPE_ATTRS } from '../../../../src/lib/tokens/types'

const rect = (over: Partial<PenpotNode> = {}): PenpotNode =>
  ({ id: 'r', name: 'r', type: 'rect', x: 10, y: 20, width: 100, height: 50, ...over }) as PenpotNode

const text = (): PenpotNode =>
  ({
    id: 't',
    name: 't',
    type: 'text',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    content: {
      type: 'root',
      children: [
        {
          type: 'paragraph-set',
          children: [
            { type: 'paragraph', fontSize: '14', children: [{ type: 'text', text: 'Hello ', fontSize: '14' }, { type: 'text', text: 'world' }] },
            { type: 'paragraph', children: [{ type: 'text', text: 'two' }] },
          ],
        },
      ],
    },
  }) as unknown as PenpotNode

describe('property registry', () => {
  beforeAll(() => reinitProperties())

  it('every legacy token attr resolves to a descriptor on some shape', () => {
    const ids = new Set(listDefs().map((d) => d.key))
    for (const attr of Object.values(TOKEN_TYPE_ATTRS).flat()) expect(ids.has(attr), attr).toBe(true)
  })

  it('every legacy animatable property resolves on a rect', () => {
    const keys = propertiesOf('rect', { animatable: true }).map((d) => d.key)
    for (const k of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity']) expect(keys, k).toContain(k)
  })

  it('identity is the id, not the label', () => {
    expect(getDef('geometry.x')?.label).toBe('X')
    expect(getDef('modifier.scaleX')?.id).not.toBe(getDef('transform3d.scaleX')?.id)
    expect(getDef('modifier.scaleX')?.label).toBe(getDef('transform3d.scaleX')?.label)
  })

  it('composition: text has text properties, rect does not', () => {
    expect(propertiesOf('text').some((d) => d.id === 'text.content')).toBe(true)
    expect(propertiesOf('rect').some((d) => d.id === 'text.content')).toBe(false)
    expect(resolve('rect', 'text.content')).toBeUndefined()
    expect(resolve('frame', 'layout.rowGap')).toBeDefined()
    expect(resolve('rect', 'layout.rowGap')).toBeUndefined()
  })

  it('infers types from the schema and honours overrides', () => {
    expect(getDef('geometry.x')?.type).toBe('number')
    expect(getDef('base.hidden')?.type).toBe('boolean')
    expect(getDef('appearance.fill')?.type).toBe('color')
    expect(getDef('text.typography')?.type).toBe('object')
  })

  it('derived accessor reads and writes a plain key', () => {
    const p = resolve('rect', propId('geometry.x'))!
    expect(p.accessor.get(rect())).toBe(10)
    expect(p.accessor.set!(rect(), 42)).toEqual({ x: 42 })
  })

  it('derived accessor follows meta.path into nested keys, cloning the parent', () => {
    const p = resolve('frame', 'layout.rowGap')!
    const node = rect({ type: 'frame', layoutGap: { rowGap: 4, columnGap: 8 } } as Partial<PenpotNode>)
    expect(p.accessor.get(node)).toBe(4)
    expect(p.accessor.set!(node, 12)).toEqual({ layoutGap: { rowGap: 12, columnGap: 8 } })
    expect(p.accessor.set!(rect(), 12)).toEqual({ layoutGap: { rowGap: 12 } })
  })

  it('synthetic fill writes the first fill and keeps the rest', () => {
    const p = resolve('rect', 'appearance.fill')!
    const node = rect({ fills: [{ fillColor: '#000', fillOpacity: 0.5 }, { fillColor: '#111' }] } as Partial<PenpotNode>)
    expect(p.accessor.get(node)).toBe('#000')
    expect(p.accessor.set!(node, '#f00')).toEqual({ fills: [{ fillColor: '#f00', fillOpacity: 0.5 }, { fillColor: '#111' }] })
    expect(p.accessor.set!(rect(), '#f00')).toEqual({ fills: [{ fillColor: '#f00', fillOpacity: 1 }] })
  })

  it('strokeColor never fabricates a stroke', () => {
    const p = resolve('rect', 'appearance.strokeColor')!
    expect(p.accessor.set!(rect(), '#f00')).toEqual({})
    const node = rect({ strokes: [{ strokeColor: '#000', strokeWidth: 2 }] } as Partial<PenpotNode>)
    expect(p.accessor.set!(node, '#f00')).toEqual({ strokes: [{ strokeColor: '#f00', strokeWidth: 2, strokeOpacity: 1 }] })
  })

  it('channels and planned properties have no set', () => {
    expect(resolve('rect', 'modifier.scaleX')!.accessor.set).toBeUndefined()
    expect(resolve('rect', 'modifier.scaleX')!.accessor.get(rect())).toBeUndefined()
    expect(getDef('transform3d.positionX')?.status).toBe('planned')
    expect(getDef('appearance.opacity')?.status).toBeUndefined()
  })

  it('text.content reads plain text and writes a single run', () => {
    const p = resolve('text', 'text.content')!
    expect(p.accessor.get(text())).toBe('Hello world\ntwo')
    const out = p.accessor.set!(text(), 'Bye') as { content: { children: Array<{ children: Array<{ children: Array<{ text: string; fontSize?: string }> }> }> } }
    const runs = out.content.children[0].children[0].children
    expect(runs).toEqual([{ type: 'text', text: 'Bye', fontSize: '14' }])
    expect(out.content.children[0].children).toHaveLength(1)
  })

  it('text.fontSize reads the first span and writes every span', () => {
    const p = resolve('text', 'text.fontSize')!
    expect(p.accessor.get(text())).toBe('14')
    const out = p.accessor.set!(text(), 20) as { content: { children: Array<{ children: Array<{ children: Array<{ fontSize?: string }> }> }> } }
    const spans = out.content.children[0].children.flatMap((par) => par.children)
    expect(spans.map((s) => s.fontSize)).toEqual(['20', '20', '20'])
  })

  it('filters by tokenable', () => {
    const ids = propertiesOf('rect', { tokenable: 'borderRadius' }).map((d) => d.id)
    expect(ids).toEqual(['radius.r1', 'radius.r2', 'radius.r3', 'radius.r4'])
  })
})
