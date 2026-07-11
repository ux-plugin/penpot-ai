/**
 * Token propagation (P2.5). Editing a token's resolved value (or switching the
 * active theme) must fan the new concrete value into every shape that references
 * it — across all pages — folded into the SAME history frame as the token change
 * so one undo reverts everything. Aliasing propagates transitively; renames keep
 * shapes linked; deletes leave the value + a dangling ref.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Fill, PenpotDocument, PenpotNode, PenpotPage } from 'penpot-exporter/types'
import { redo, setDocument, undo } from '../../../src/lib/page-crud'
import { docProxy } from '../../../src/lib/renderer/store/doc-proxy'
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
import { resetWorkspace } from '../fixtures'

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

function root(id: string): PenpotNode {
  return {
    id,
    type: 'frame',
    name: 'Root',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    selrect: { x: 0, y: 0, width: 800, height: 600, x1: 0, y1: 0, x2: 800, y2: 600 },
    points: [
      { x: 0, y: 0 },
      { x: 800, y: 0 },
      { x: 800, y: 600 },
      { x: 0, y: 600 },
    ],
  } as unknown as PenpotNode
}

function page(id: string, shapes: PenpotNode[]): PenpotPage {
  return { id, name: id, background: '#FFFFFF', children: [root(`root-${id}`), ...shapes] }
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
  const lib = 'sets' in libOrToken ? libOrToken : libWith(libOrToken, ...rest)
  docProxy.meta!.tokens = lib
}

/** Edit a token (looked up by name) — CRUD is id-based now. */
async function editToken(setId: string, name: string, value: string, newName?: string): Promise<void> {
  const lib = docProxy.meta!.tokens as TokensLib
  const t = lib.sets.find((x) => x.id === setId)!.tokens.find((x) => x.name === name)!
  await modifyToken(setId, t.id, createToken({ id: t.id, name: newName ?? t.name, type: t.type, value }))
}
async function removeToken(setId: string, name: string): Promise<void> {
  const lib = docProxy.meta!.tokens as TokensLib
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

function fillOf(pageId: string, id: string): string | undefined {
  const node = docProxy.pageMap.get(pageId)?.objects[id] as { fills?: Fill[] } | undefined
  return node?.fills?.[0]?.fillColor?.toLowerCase()
}
function appliedOf(pageId: string, id: string): Record<string, string> | undefined {
  return (docProxy.pageMap.get(pageId)?.objects[id] as PenpotNode).appliedTokens as
    | Record<string, string>
    | undefined
}

describe('value edit propagates', () => {
  it('rewrites every shape using the token; unrelated shapes untouched', async () => {
    await setDocument(
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

    expect(fillOf('page-1', 'r-a')).toBe('#ff0000')
    expect(fillOf('page-1', 'r-b')).toBe('#ff0000')
    expect(fillOf('page-1', 'r-free')).toBe('#aaaaaa') // no token → untouched
    expect(fillOf('page-1', 'r-other')).toBe('#0000ff') // other token → untouched (diff)
  })

  it('reaches shapes on other pages', async () => {
    await setDocument(
      doc([
        page('page-1', [rect('r-1', '#00ff00', { fill: 'color.brand' })]),
        page('page-2', [rect('r-2', '#00ff00', { fill: 'color.brand' })]),
      ]),
    )
    installLib(createToken({ name: 'color.brand', type: 'color', value: '#00FF00' }))

    await editToken(SET, 'color.brand', '#FF0000')

    expect(fillOf('page-1', 'r-1')).toBe('#ff0000')
    expect(fillOf('page-2', 'r-2')).toBe('#ff0000')
  })
})

describe('aliasing', () => {
  it('editing the base token updates shapes using an alias of it', async () => {
    await setDocument(doc([page('page-1', [rect('r', '#ff0000', { fill: 'color.fg' })])]))
    installLib(
      createToken({ name: 'color.base', type: 'color', value: '#FF0000' }),
      createToken({ name: 'color.fg', type: 'color', value: '{color.base}' }),
    )

    await editToken(SET, 'color.base', '#0000FF')

    expect(fillOf('page-1', 'r')).toBe('#0000ff') // transitive
  })
})

describe('theme switch', () => {
  it('flips shapes to the dark value when the active theme changes', async () => {
    await setDocument(doc([page('page-1', [rect('r', '#ffffff', { fill: 'color.bg' })])]))
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
    expect(fillOf('page-1', 'r')).toBe('#111111')

    await undo()
    expect(fillOf('page-1', 'r')).toBe('#ffffff')
    expect((docProxy.meta!.tokens as TokensLib).activeThemes).toEqual(['th-light'])
  })
})

describe('atomic undo / redo', () => {
  it('one undo reverts the token value AND every shape it touched', async () => {
    await setDocument(
      doc([
        page('page-1', [rect('r-1', '#00ff00', { fill: 'color.brand' })]),
        page('page-2', [rect('r-2', '#00ff00', { fill: 'color.brand' })]),
      ]),
    )
    installLib(createToken({ name: 'color.brand', type: 'color', value: '#00FF00' }))

    await editToken(SET, 'color.brand', '#FF0000')
    expect(fillOf('page-1', 'r-1')).toBe('#ff0000')
    expect(fillOf('page-2', 'r-2')).toBe('#ff0000')

    await undo()
    expect(fillOf('page-1', 'r-1')).toBe('#00ff00')
    expect(fillOf('page-2', 'r-2')).toBe('#00ff00')
    const lib = docProxy.meta!.tokens as TokensLib
    expect(lib.sets[0].tokens.find((t) => t.name === 'color.brand')!.value).toBe('#00FF00')

    await redo()
    expect(fillOf('page-1', 'r-1')).toBe('#ff0000')
    expect(fillOf('page-2', 'r-2')).toBe('#ff0000')
  })
})

describe('rename fix-up', () => {
  it('rewrites appliedTokens old→new and keeps the value; undo restores the old name', async () => {
    await setDocument(doc([page('page-1', [rect('r', '#ffffff', { fill: 'color.bg' })])]))
    installLib(createToken({ name: 'color.bg', type: 'color', value: '#FFFFFF' }))

    await editToken(SET, 'color.bg', '#FFFFFF', 'color.background')

    expect(appliedOf('page-1', 'r')?.fill).toBe('color.background')
    expect(fillOf('page-1', 'r')).toBe('#ffffff') // value preserved

    await undo()
    expect(appliedOf('page-1', 'r')?.fill).toBe('color.bg')
  })
})

describe('delete leaves a dangling reference', () => {
  it('keeps the concrete value and the (now-dangling) appliedTokens link', async () => {
    await setDocument(doc([page('page-1', [rect('r', '#ffffff', { fill: 'color.bg' })])]))
    installLib(createToken({ name: 'color.bg', type: 'color', value: '#FFFFFF' }))

    await removeToken(SET, 'color.bg')

    expect(fillOf('page-1', 'r')).toBe('#ffffff') // value kept
    expect(appliedOf('page-1', 'r')?.fill).toBe('color.bg') // dangling link kept
  })
})
