/**
 * Token CRUD (P2.3) — focuses on undo/redo. Every op must revert with a single
 * Cmd+Z and re-apply with redo; deletes must restore verbatim and in place; a
 * mode switch (setActiveThemes) must round-trip; and deleting an *active* theme
 * must restore both the theme and its active state in one frame.
 *
 * Reuses the Phase-1 doc-meta commit/history/undo pipeline unchanged.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { redo, setDocument, undo } from '../../../src/lib/page-crud'
import { docProxy } from '../../../src/lib/renderer/store/doc-proxy'
import {
  createToken,
  createTokenSet,
  createTokenTheme,
  type TokensLib,
} from '../../../src/lib/tokens/types'
import {
  addToken,
  addTheme,
  addTokenSet,
  deleteTheme,
  deleteToken,
  deleteTokenSet,
  modifyToken,
  moveToken,
  setActiveThemes,
} from '../../../src/lib/tokens/crud'
import { makeBaseDocument, resetWorkspace } from '../fixtures'

const SET = 'set-1'

beforeEach(resetWorkspace)

function lib(): TokensLib {
  return docProxy.meta!.tokens as TokensLib
}
function getSet(id: string) {
  return lib().sets.find((s) => s.id === id)
}
function getToken(setId: string, name: string) {
  return getSet(setId)?.tokens.find((t) => t.name === name)
}
function setNames(): string[] {
  return lib().sets.map((s) => s.id)
}

/** Load the base doc, then add an empty set + one color token to it (two frames). */
async function withSetAndToken(): Promise<void> {
  await setDocument(makeBaseDocument())
  await addTokenSet(createTokenSet({ id: SET, name: 'core' }))
  await addToken(SET, createToken({ id: 't1', name: 'color.bg', type: 'color', value: '#FFFFFF' }))
}

describe('loadDocument initialises an empty tokens lib', () => {
  it('coerces meta.tokens to a runtime TokensLib', async () => {
    await setDocument(makeBaseDocument())
    expect(lib()).toEqual({ sets: [], themes: [], activeThemes: [] })
  })
})

describe('addTokenSet', () => {
  it('undo removes the set; redo restores it', async () => {
    await setDocument(makeBaseDocument())
    await addTokenSet(createTokenSet({ id: SET, name: 'core' }))
    expect(getSet(SET)).toBeDefined()

    await undo()
    expect(getSet(SET)).toBeUndefined()

    await redo()
    expect(getSet(SET)?.name).toBe('core')
  })
})

describe('addToken', () => {
  it('undo removes only the token; the set (a prior frame) survives', async () => {
    await withSetAndToken()
    expect(getToken(SET, 'color.bg')?.value).toBe('#FFFFFF')

    await undo()
    expect(getToken(SET, 'color.bg')).toBeUndefined()
    expect(getSet(SET)).toBeDefined()

    await redo()
    expect(getToken(SET, 'color.bg')?.value).toBe('#FFFFFF')
  })
})

describe('modifyToken', () => {
  it('value edit: undo restores prior, redo re-applies', async () => {
    await withSetAndToken()
    await modifyToken(
      SET,
      't1',
      createToken({ id: 't1', name: 'color.bg', type: 'color', value: '#000000' }),
    )
    expect(getToken(SET, 'color.bg')?.value).toBe('#000000')

    await undo()
    expect(getToken(SET, 'color.bg')?.value).toBe('#FFFFFF')

    await redo()
    expect(getToken(SET, 'color.bg')?.value).toBe('#000000')
  })

  it('rename re-keys the token; undo restores the old key', async () => {
    await withSetAndToken()
    await modifyToken(
      SET,
      't1',
      createToken({ id: 't1', name: 'color.background', type: 'color', value: '#FFFFFF' }),
    )
    expect(getToken(SET, 'color.background')).toBeDefined()
    expect(getToken(SET, 'color.bg')).toBeUndefined()

    await undo()
    expect(getToken(SET, 'color.bg')).toBeDefined()
    expect(getToken(SET, 'color.background')).toBeUndefined()
  })
})

describe('deleteToken', () => {
  it('undo restores the prior token verbatim', async () => {
    await withSetAndToken()
    const before = JSON.parse(JSON.stringify(getToken(SET, 'color.bg')))

    await deleteToken(SET, 't1')
    expect(getToken(SET, 'color.bg')).toBeUndefined()

    await undo()
    expect(JSON.parse(JSON.stringify(getToken(SET, 'color.bg')))).toEqual(before)

    await redo()
    expect(getToken(SET, 'color.bg')).toBeUndefined()
  })
})

describe('deleteTokenSet', () => {
  it('undo restores the set at its original index (order preserved)', async () => {
    await setDocument(makeBaseDocument())
    await addTokenSet(createTokenSet({ id: 'a', name: 'a' }))
    await addTokenSet(createTokenSet({ id: 'b', name: 'b' }))
    await addTokenSet(createTokenSet({ id: 'c', name: 'c' }))
    expect(setNames()).toEqual(['a', 'b', 'c'])

    await deleteTokenSet('b')
    expect(setNames()).toEqual(['a', 'c'])

    await undo()
    expect(setNames()).toEqual(['a', 'b', 'c']) // b back in the middle, not appended

    await redo()
    expect(setNames()).toEqual(['a', 'c'])
  })
})

describe('themes + modes', () => {
  it('setActiveThemes round-trips through undo/redo', async () => {
    await setDocument(makeBaseDocument())
    await addTheme(createTokenTheme({ id: 'th1', name: 'light', group: 'mode' }))
    await addTheme(createTokenTheme({ id: 'th2', name: 'dark', group: 'mode' }))
    await setActiveThemes(['th1'])
    await setActiveThemes(['th2'])
    expect(lib().activeThemes).toEqual(['th2'])

    await undo()
    expect(lib().activeThemes).toEqual(['th1'])

    await redo()
    expect(lib().activeThemes).toEqual(['th2'])
  })

  it('deleting an active theme restores the theme AND its active state in one undo', async () => {
    await setDocument(makeBaseDocument())
    await addTheme(createTokenTheme({ id: 'th-d', name: 'dark', group: 'mode' }))
    await setActiveThemes(['th-d'])

    await deleteTheme('th-d')
    expect(lib().themes.find((t) => t.id === 'th-d')).toBeUndefined()
    expect(lib().activeThemes).toEqual([])

    await undo() // single frame
    expect(lib().themes.find((t) => t.id === 'th-d')).toBeDefined()
    expect(lib().activeThemes).toEqual(['th-d'])

    await redo()
    expect(lib().themes.find((t) => t.id === 'th-d')).toBeUndefined()
    expect(lib().activeThemes).toEqual([])
  })
})

describe('moveToken', () => {
  it('moves a token to another set; undo restores it in place', async () => {
    await setDocument(makeBaseDocument())
    await addTokenSet(createTokenSet({ id: 'A', name: 'a' }))
    await addTokenSet(createTokenSet({ id: 'B', name: 'b' }))
    await addToken('A', createToken({ id: 't1', name: 'color.bg', type: 'color', value: '#FFFFFF' }))

    await moveToken('A', 'B', 't1')
    expect(getSet('A')?.tokens.find((t) => t.id === 't1')).toBeUndefined()
    expect(getSet('B')?.tokens.find((t) => t.id === 't1')?.value).toBe('#FFFFFF')

    await undo()
    expect(getSet('A')?.tokens.find((t) => t.id === 't1')?.value).toBe('#FFFFFF')
    expect(getSet('B')?.tokens.find((t) => t.id === 't1')).toBeUndefined()

    await redo()
    expect(getSet('B')?.tokens.find((t) => t.id === 't1')?.value).toBe('#FFFFFF')
  })
})

describe('duplicate names within a set', () => {
  it('adding the same name twice keeps both entries (a flagged duplicate)', async () => {
    await setDocument(makeBaseDocument())
    await addTokenSet(createTokenSet({ id: SET, name: 'core' }))
    await addToken(SET, createToken({ id: 'a', name: 'color.bg', type: 'color', value: '#FFFFFF' }))
    await addToken(SET, createToken({ id: 'b', name: 'color.bg', type: 'color', value: '#000000' }))
    const entries = getSet(SET)!.tokens.filter((t) => t.name === 'color.bg')
    expect(entries.map((t) => t.id)).toEqual(['a', 'b'])
    // removing one leaves the other
    await deleteToken(SET, 'b')
    expect(getSet(SET)!.tokens.filter((t) => t.name === 'color.bg').map((t) => t.id)).toEqual(['a'])
  })
})
