/**
 * Apply / detach token (P2.4). Wires the resolver (P2.2) + attr table (P2.1)
 * onto real shapes: each apply writes the resolved concrete value into the
 * normal prop AND sets node.appliedTokens[attr] = name, in one undoable page
 * change. Detach strips the link, keeps the value.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode, Stroke } from 'penpot-exporter/types'
import { redo, setDocument, undo } from '../../../src/lib/page-crud'
import { docProxy } from '../../../src/lib/renderer/store/doc-proxy'
import { applyToken, detachToken } from '../../../src/lib/tokens/apply'
import { createToken, createTokenSet, type Token, type TokensLib } from '../../../src/lib/tokens/types'
import {
  RECT_ID,
  TEXT_ID,
  makeBaseDocument,
  readFirstSpan,
  readRectFill,
  readRectStroke,
  resetWorkspace,
} from '../fixtures'

const PAGE = 'page-1'
const STROKE: Stroke = { strokeColor: '#000000', strokeOpacity: 1, strokeWidth: 1, strokeAlignment: 'center' }

beforeEach(resetWorkspace)

/** Install a tokens lib directly (no history frames), so the only undoable frame is the apply. */
function installTokens(tokens: Token[]): void {
  const set = createTokenSet({
    id: 'set-1',
    name: 'core',
    tokens,
  })
  // No active theme → effectiveActiveTokens falls back to all sets (single implicit mode).
  docProxy.meta!.tokens = { sets: [set], themes: [], activeThemes: [] } satisfies TokensLib
}

function nodeOf(id: string): PenpotNode {
  return docProxy.pageMap.get(PAGE)!.objects[id] as PenpotNode
}
function appliedOf(id: string): Record<string, string> | undefined {
  return nodeOf(id).appliedTokens as Record<string, string> | undefined
}

describe('apply color → fill', () => {
  it('writes the resolved color and stamps appliedTokens.fill', async () => {
    await setDocument(makeBaseDocument())
    installTokens([createToken({ id: 'c', name: 'color.brand', type: 'color', value: '#00FF00' })])

    await applyToken(RECT_ID, 'color.brand', ['fill'])

    expect(readRectFill()?.fillColor?.toLowerCase()).toBe('#00ff00')
    expect(appliedOf(RECT_ID)?.fill).toBe('color.brand')
    // Token model: the link is on the node, NOT inside the fill.
    expect(readRectFill()).not.toHaveProperty('fillColorRefId')
  })

  it('resolves an alias end-to-end', async () => {
    await setDocument(makeBaseDocument())
    installTokens([
      createToken({ id: 'b', name: 'color.base', type: 'color', value: '#FF0000' }),
      createToken({ id: 'f', name: 'color.fg', type: 'color', value: '{color.base}' }),
    ])

    await applyToken(RECT_ID, 'color.fg', ['fill'])
    expect(readRectFill()?.fillColor?.toLowerCase()).toBe('#ff0000')
    expect(appliedOf(RECT_ID)?.fill).toBe('color.fg')
  })
})

describe('apply color → strokeColor', () => {
  it('writes the resolved stroke color and stamps appliedTokens.strokeColor', async () => {
    await setDocument(makeBaseDocument({ rectStroke: STROKE }))
    installTokens([createToken({ id: 'c', name: 'color.line', type: 'color', value: '#0000FF' })])

    await applyToken(RECT_ID, 'color.line', ['strokeColor'])

    expect(readRectStroke()?.strokeColor?.toLowerCase()).toBe('#0000ff')
    expect(readRectStroke()?.strokeWidth).toBe(1) // non-color stroke attrs preserved
    expect(appliedOf(RECT_ID)?.strokeColor).toBe('color.line')
  })
})

describe('apply borderRadius → r1..r4', () => {
  it('sets all four corners and stamps the four appliedTokens keys', async () => {
    await setDocument(makeBaseDocument())
    installTokens([createToken({ id: 'r', name: 'radius.md', type: 'borderRadius', value: '8' })])

    await applyToken(RECT_ID, 'radius.md', ['r1', 'r2', 'r3', 'r4'])

    const node = nodeOf(RECT_ID) as Record<string, unknown>
    expect([node.r1, node.r2, node.r3, node.r4]).toEqual([8, 8, 8, 8])
    expect(appliedOf(RECT_ID)).toMatchObject({
      r1: 'radius.md',
      r2: 'radius.md',
      r3: 'radius.md',
      r4: 'radius.md',
    })
  })
})

describe('apply opacity / strokeWidth', () => {
  it('opacity writes a 0..1 number', async () => {
    await setDocument(makeBaseDocument())
    installTokens([createToken({ id: 'o', name: 'opacity.half', type: 'opacity', value: '0.5' })])

    await applyToken(RECT_ID, 'opacity.half', ['opacity'])
    expect((nodeOf(RECT_ID) as { opacity?: number }).opacity).toBe(0.5)
    expect(appliedOf(RECT_ID)?.opacity).toBe('opacity.half')
  })

  it('strokeWidth (dimension on the stroke) writes the number', async () => {
    await setDocument(makeBaseDocument({ rectStroke: STROKE }))
    installTokens([createToken({ id: 'w', name: 'border.thick', type: 'dimension', value: '4' })])

    await applyToken(RECT_ID, 'border.thick', ['strokeWidth'])
    expect(readRectStroke()?.strokeWidth).toBe(4)
    expect(appliedOf(RECT_ID)?.strokeWidth).toBe('border.thick')
  })
})

describe('apply typography → spans', () => {
  it('decomposes the composite onto every span and stamps appliedTokens.typography', async () => {
    await setDocument(makeBaseDocument())
    installTokens([
      createToken({
        id: 't',
        name: 'type.heading',
        type: 'typography',
        value: { fontFamily: 'Inter', fontSize: '24', fontWeight: '700' },
      }),
    ])

    await applyToken(TEXT_ID, 'type.heading', ['typography'])

    const span = readFirstSpan()
    expect(span?.fontFamily).toBe('Inter')
    expect(span?.fontSize).toBe('24')
    expect(span?.fontWeight).toBe('700')
    expect(appliedOf(TEXT_ID)?.typography).toBe('type.heading')
  })
})

describe('detach', () => {
  it('strips appliedTokens but keeps the concrete value; empties to {}', async () => {
    await setDocument(makeBaseDocument())
    installTokens([createToken({ id: 'c', name: 'color.brand', type: 'color', value: '#00FF00' })])
    await applyToken(RECT_ID, 'color.brand', ['fill'])

    await detachToken(RECT_ID, ['fill'])

    expect(readRectFill()?.fillColor?.toLowerCase()).toBe('#00ff00') // value kept
    expect(appliedOf(RECT_ID)).toEqual({}) // link removed, map emptied
  })
})

describe('no-ops', () => {
  it('unknown token leaves the shape untouched', async () => {
    await setDocument(makeBaseDocument())
    installTokens([createToken({ id: 'c', name: 'color.brand', type: 'color', value: '#00FF00' })])
    const before = readRectFill()
    await applyToken(RECT_ID, 'color.missing', ['fill'])
    expect(readRectFill()).toEqual(before)
    expect(appliedOf(RECT_ID)).toBeUndefined()
  })

  it('non-appliable attr is skipped (color cannot fill r1)', async () => {
    await setDocument(makeBaseDocument())
    installTokens([createToken({ id: 'c', name: 'color.brand', type: 'color', value: '#00FF00' })])
    const beforeR1 = (nodeOf(RECT_ID) as { r1?: number }).r1
    await applyToken(RECT_ID, 'color.brand', ['r1'])
    expect((nodeOf(RECT_ID) as { r1?: number }).r1).toBe(beforeR1) // unchanged
    expect(appliedOf(RECT_ID)).toBeUndefined()
  })

  it('a token that resolves with errors is not applied', async () => {
    await setDocument(makeBaseDocument())
    installTokens([createToken({ id: 'x', name: 'color.bad', type: 'color', value: '{does.not.exist}' })])
    const before = readRectFill()
    await applyToken(RECT_ID, 'color.bad', ['fill'])
    expect(readRectFill()).toEqual(before)
    expect(appliedOf(RECT_ID)).toBeUndefined()
  })
})

describe('undo / redo', () => {
  it('apply reverts value + appliedTokens in one frame; redo re-applies', async () => {
    await setDocument(makeBaseDocument())
    installTokens([createToken({ id: 'c', name: 'color.brand', type: 'color', value: '#00FF00' })])
    const original = readRectFill()?.fillColor

    await applyToken(RECT_ID, 'color.brand', ['fill'])
    expect(readRectFill()?.fillColor?.toLowerCase()).toBe('#00ff00')
    expect(appliedOf(RECT_ID)?.fill).toBe('color.brand')

    await undo()
    expect(readRectFill()?.fillColor).toBe(original)
    expect(appliedOf(RECT_ID)?.fill).toBeUndefined()

    await redo()
    expect(readRectFill()?.fillColor?.toLowerCase()).toBe('#00ff00')
    expect(appliedOf(RECT_ID)?.fill).toBe('color.brand')
  })
})
