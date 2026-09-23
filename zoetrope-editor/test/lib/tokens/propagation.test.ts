/**
 * Token propagation (P2.5). Editing a token's resolved value (or switching the
 * active theme) must fan the new concrete value into every shape that references
 * it — across all pages — folded into the SAME history frame as the token change
 * so one undo reverts everything. Aliasing propagates transitively; renames keep
 * shapes linked; deletes leave the value + a dangling ref.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Fill, PenpotDocument, PenpotNode, PenpotPage } from 'penpot-exporter/types'
import { getNode, meta, redo, undo } from '../../../src/lib/doc'
import {
  deleteToken,
  modifyToken,
  setActiveThemes,
} from '../../../src/lib/tokens/crud'
import {
  createToken,
  createTokenSet,
  createTokenTheme,
  type Token,
  type TokensLib,
} from '../../../src/lib/tokens/types'
import { resetWorkspace, seedDocument } from '../fixtures'

const SET = 'set-1'
const sel = { x: 0, y: 0, width: 100, height: 50, x1: 0, y1: 0, x2: 100, y2: 50 }
const pts = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
  { x: 0, y: 50 },
]

beforeEach(resetWorkspace)

function rect(id: string, fillColor: string, applied: Record<string, string>): PenpotNode {
  return {
    id,
    type: 'rect',
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    selrect: { ...sel },
    points: [...pts],
    fills: [{ fillColor, fillOpacity: 1 }],
    appliedTokens: applied,
  } as unknown as PenpotNode
}

function page(id: string, shapes: PenpotNode[]): PenpotPage {
  return { id, name: id, background: '#FFFFFF', children: shapes }
}

function doc(pages: PenpotPage[]): PenpotDocument {
  return {
    name: 'Test',
    children: pages,
    components: {},
    images: {},
    paintStyles: {},
    textStyles: {},
    componentProperties: {},
    externalLibraries: {},
    missingFonts: [],
    isShared: false,
  } as unknown as PenpotDocument
}

function installLib(libOrToken: TokensLib | Token, ...rest: Token[]): void {
  const tokens = 'sets' in libOrToken ? libOrToken : libWith(libOrToken, ...rest)
  meta.value = { ...meta.peek()!, tokens }
}

function currentLib(): TokensLib {
  return meta.peek()!.tokens as TokensLib
}

/** Edit a token (looked up by name) — CRUD is id-based now. */
async function editToken(setId: string, name: string, value: string, newName?: string): Promise<void> {
  const lib = currentLib()
  const t = lib.sets.find((x) => x.id === setId)!.tokens.find((x) => x.name === name)!
  await modifyToken(setId, t.id, createToken({ id: t.id, name: newName ?? t.name, type: t.type, value }))
}
async function removeToken(setId: string, name: string): Promise<void> {
  const lib = currentLib()
  const t = lib.sets.find((x) => x.id === setId)!.tokens.find((x) => x.name === name)!
  await deleteToken(setId, t.id)
}

function libWith(...tokens: Token[]): TokensLib {
  const set = createTokenSet({
    id: SET,
    name: 'core',
    tokens,
  })
  return { sets: [set], themes: [], activeThemes: [] }
}

function fillOf(id: string): string | undefined {
  const node = getNode(id) as { fills?: Fill[] } | undefined
  return node?.fills?.[0]?.fillColor?.toLowerCase()
}
function appliedOf(id: string): Record<string, string> | undefined {
  return getNode(id)?.appliedTokens as Record<string, string> | undefined
}

describe('value edit propagates', () => {
  it('rewrites every shape using the token; unrelated shapes untouched', async () => {
    seedDocument(
      doc([
        page('page-1', [
          rect('r-a', '#00ff00', { fill: 'color.brand' }),
          rect('r-b', '#00ff00', { fill: 'color.brand' }),
          rect('r-free', '#aaaaaa', {}),
          rect('r-other', '#0000ff', { fill: 'color.accent' }),
        ]),
      ]),
    )
    installLib(
      createToken({ name: 'color.brand', type: 'color', value: '#00FF00' }),
      createToken({ name: 'color.accent', type: 'color', value: '#0000FF' }),
    )

    await editToken(SET, 'color.brand', '#FF0000')

    expect(fillOf('r-a')).toBe('#ff0000')
    expect(fillOf('r-b')).toBe('#ff0000')
    expect(fillOf('r-free')).toBe('#aaaaaa') // no token → untouched
    expect(fillOf('r-other')).toBe('#0000ff') // other token → untouched (diff)
  })

  it('reaches shapes on other pages', async () => {
    seedDocument(
      doc([
        page('page-1', [rect('r-1', '#00ff00', { fill: 'color.brand' })]),
        page('page-2', [rect('r-2', '#00ff00', { fill: 'color.brand' })]),
      ]),
    )
    installLib(createToken({ name: 'color.brand', type: 'color', value: '#00FF00' }))

    await editToken(SET, 'color.brand', '#FF0000')

    expect(fillOf('r-1')).toBe('#ff0000')
    expect(fillOf('r-2')).toBe('#ff0000')
  })
})

describe('aliasing', () => {
  it('editing the base token updates shapes using an alias of it', async () => {
    seedDocument(doc([page('page-1', [rect('r', '#ff0000', { fill: 'color.fg' })])]))
    installLib(
      createToken({ name: 'color.base', type: 'color', value: '#FF0000' }),
      createToken({ name: 'color.fg', type: 'color', value: '{color.base}' }),
    )

    await editToken(SET, 'color.base', '#0000FF')

    expect(fillOf('r')).toBe('#0000ff') // transitive
  })
})

describe('theme switch', () => {
  it('flips shapes to the dark value when the active theme changes', async () => {
    seedDocument(doc([page('page-1', [rect('r', '#ffffff', { fill: 'color.bg' })])]))
    const base = createTokenSet({
      id: 'base',
      name: 'base',
      tokens: [createToken({ name: 'color.bg', type: 'color', value: '#FFFFFF' })],
    })
    const dark = createTokenSet({
      id: 'dark',
      name: 'dark',
      tokens: [createToken({ name: 'color.bg', type: 'color', value: '#111111' })],
    })
    installLib({
      sets: [base, dark],
      themes: [
        createTokenTheme({ id: 'th-light', name: 'light', group: 'mode', sets: ['base'] }),
        createTokenTheme({ id: 'th-dark', name: 'dark', group: 'mode', sets: ['base', 'dark'] }),
      ],
      activeThemes: ['th-light'],
    })

    await setActiveThemes(['th-dark'])
    expect(fillOf('r')).toBe('#111111')

    await undo()
    expect(fillOf('r')).toBe('#ffffff')
    expect(currentLib().activeThemes).toEqual(['th-light'])
  })
})

describe('atomic undo / redo', () => {
  it('one undo reverts the token value AND every shape it touched', async () => {
    seedDocument(
      doc([
        page('page-1', [rect('r-1', '#00ff00', { fill: 'color.brand' })]),
        page('page-2', [rect('r-2', '#00ff00', { fill: 'color.brand' })]),
      ]),
    )
    installLib(createToken({ name: 'color.brand', type: 'color', value: '#00FF00' }))

    await editToken(SET, 'color.brand', '#FF0000')
    expect(fillOf('r-1')).toBe('#ff0000')
    expect(fillOf('r-2')).toBe('#ff0000')

    await undo()
    expect(fillOf('r-1')).toBe('#00ff00')
    expect(fillOf('r-2')).toBe('#00ff00')
    const lib = currentLib()
    expect(lib.sets[0].tokens.find((t) => t.name === 'color.brand')!.value).toBe('#00FF00')

    await redo()
    expect(fillOf('r-1')).toBe('#ff0000')
    expect(fillOf('r-2')).toBe('#ff0000')
  })
})

describe('rename fix-up', () => {
  it('rewrites appliedTokens old→new and keeps the value; undo restores the old name', async () => {
    seedDocument(doc([page('page-1', [rect('r', '#ffffff', { fill: 'color.bg' })])]))
    installLib(createToken({ name: 'color.bg', type: 'color', value: '#FFFFFF' }))

    await editToken(SET, 'color.bg', '#FFFFFF', 'color.background')

    expect(appliedOf('r')?.fill).toBe('color.background')
    expect(fillOf('r')).toBe('#ffffff') // value preserved

    await undo()
    expect(appliedOf('r')?.fill).toBe('color.bg')
  })
})

// A shader-material uniform can bind a token (`material.uniforms[].token`) — a
// different place than `appliedTokens`. Propagation must re-materialize those
// too, so a token/theme edit updates the shape's shader with no editor open.
function matRect(
  id: string,
  uniforms: unknown[],
  applied: Record<string, string> = {},
): PenpotNode {
  return {
    id,
    type: 'rect',
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    selrect: { ...sel },
    points: [...pts],
    fills: [{ fillColor: '#888888', fillOpacity: 1 }],
    appliedTokens: applied,
    material: { source: 'half4 main(float2 p){ return half4(1); }', uniforms },
  } as unknown as PenpotNode
}
function uniformsOf(id: string): { name: string; value: { type: string; value: unknown }; token?: string }[] {
  return (getNode(id) as unknown as { material?: { uniforms: never[] } }).material!.uniforms
}

describe('material-uniform token binding propagates', () => {
  it('re-materializes a color-bound uniform (shape has NO appliedTokens)', async () => {
    seedDocument(
      doc([
        page('page-1', [
          matRect('r', [{ name: 'u_col', token: 'color.brand', value: { type: 'vec4', value: [0, 1, 0, 1] } }]),
        ]),
      ]),
    )
    installLib(createToken({ name: 'color.brand', type: 'color', value: '#00FF00' }))

    await editToken(SET, 'color.brand', '#FF0000')

    const u = uniformsOf('r')[0]
    expect(u.value).toEqual({ type: 'vec4', value: [1, 0, 0, 1] })
    expect(u.token).toBe('color.brand') // link kept
  })

  it('re-materializes a number-bound scalar uniform', async () => {
    seedDocument(
      doc([
        page('page-1', [
          matRect('r', [{ name: 'u_amt', token: 'num.amt', value: { type: 'f32', value: 0.5 } }]),
        ]),
      ]),
    )
    installLib(createToken({ name: 'num.amt', type: 'number', value: '0.5' }))

    await editToken(SET, 'num.amt', '0.8')

    expect(uniformsOf('r')[0].value).toEqual({ type: 'f32', value: 0.8 })
  })

  it('leaves an unbound uniform untouched', async () => {
    seedDocument(
      doc([
        page('page-1', [
          matRect('r', [
            { name: 'u_col', token: 'color.brand', value: { type: 'vec4', value: [0, 1, 0, 1] } },
            { name: 'u_free', value: { type: 'f32', value: 0.25 } },
          ]),
        ]),
      ]),
    )
    installLib(createToken({ name: 'color.brand', type: 'color', value: '#00FF00' }))

    await editToken(SET, 'color.brand', '#FF0000')

    const us = uniformsOf('r')
    expect(us[0].value).toEqual({ type: 'vec4', value: [1, 0, 0, 1] })
    expect(us[1].value).toEqual({ type: 'f32', value: 0.25 }) // no token → untouched
  })

  it('one undo reverts the token AND the materialized uniform', async () => {
    seedDocument(
      doc([
        page('page-1', [
          matRect('r', [{ name: 'u_col', token: 'color.brand', value: { type: 'vec4', value: [0, 1, 0, 1] } }]),
        ]),
      ]),
    )
    installLib(createToken({ name: 'color.brand', type: 'color', value: '#00FF00' }))

    await editToken(SET, 'color.brand', '#FF0000')
    expect(uniformsOf('r')[0].value).toEqual({ type: 'vec4', value: [1, 0, 0, 1] })

    await undo()
    expect(uniformsOf('r')[0].value).toEqual({ type: 'vec4', value: [0, 1, 0, 1] })
    expect(currentLib().sets[0].tokens.find((t) => t.name === 'color.brand')!.value).toBe('#00FF00')

    await redo()
    expect(uniformsOf('r')[0].value).toEqual({ type: 'vec4', value: [1, 0, 0, 1] })
  })

  it('a rename fixes up the uniform token link', async () => {
    seedDocument(
      doc([
        page('page-1', [
          matRect('r', [{ name: 'u_col', token: 'color.brand', value: { type: 'vec4', value: [0, 1, 0, 1] } }]),
        ]),
      ]),
    )
    installLib(createToken({ name: 'color.brand', type: 'color', value: '#00FF00' }))

    await editToken(SET, 'color.brand', '#00FF00', 'color.primary')

    expect(uniformsOf('r')[0].token).toBe('color.primary')
  })
})

describe('delete leaves a dangling reference', () => {
  it('keeps the concrete value and the (now-dangling) appliedTokens link', async () => {
    seedDocument(doc([page('page-1', [rect('r', '#ffffff', { fill: 'color.bg' })])]))
    installLib(createToken({ name: 'color.bg', type: 'color', value: '#FFFFFF' }))

    await removeToken(SET, 'color.bg')

    expect(fillOf('r')).toBe('#ffffff') // value kept
    expect(appliedOf('r')?.fill).toBe('color.bg') // dangling link kept
  })
})
