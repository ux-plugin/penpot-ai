/**
 * Per-mode value editing (Slice 2) — pins the rule the editor's mode rows rely on.
 *
 * An edit for a theme is written to that theme's TOP set (`themeTopSet`): the last
 * of its sets in lib order, which is the one that wins resolution. Writing anywhere
 * else would be accepted but silently shadowed by a later set — the failure this
 * suite exists to catch. It also pins that one mode's edit never leaks into another.
 *
 * These call the same CRUD the `ModeValueRow` UI calls, so they exercise the real
 * write path (propagation + single-frame undo included).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { setDocument, undo } from '../../../src/lib/page-crud'
import { docProxy } from '../../../src/lib/renderer/store/doc-proxy'
import {
  createToken,
  createTokenSet,
  createTokenTheme,
  effectiveActiveTokens,
  findToken,
  themeTopSet,
  type TokensLib,
} from '../../../src/lib/tokens/types'
import {
  addTheme,
  addToken,
  addTokenSet,
  deleteToken,
  modifyToken,
  setActiveThemes,
} from '../../../src/lib/tokens/crud'
import { makeBaseDocument, resetWorkspace } from '../fixtures'

const BASE = 'set-base'
const DARK = 'set-dark'
const LIGHT_THEME = 'th-light'
const DARK_THEME = 'th-dark'

beforeEach(resetWorkspace)

function lib(): TokensLib {
  return docProxy.meta!.tokens as TokensLib
}
function theme(id: string) {
  return lib().themes.find((t) => t.id === id)!
}
function set(id: string) {
  return lib().sets.find((s) => s.id === id)!
}
/** What the canvas would resolve color.bg to under the active theme. */
function resolvedBg(): unknown {
  return effectiveActiveTokens(lib()).get('color.bg')?.value
}

/** base(color.bg #FFFFFF) then an empty dark set; Light=[base], Dark=[base,dark]. */
async function setup(): Promise<void> {
  await setDocument(makeBaseDocument())
  await addTokenSet(createTokenSet({ id: BASE, name: 'base' }))
  await addToken(BASE, createToken({ id: 't-bg', name: 'color.bg', type: 'color', value: '#FFFFFF' }))
  await addTokenSet(createTokenSet({ id: DARK, name: 'dark' }))
  await addTheme(createTokenTheme({ id: LIGHT_THEME, name: 'Light', sets: ['base'] }))
  await addTheme(createTokenTheme({ id: DARK_THEME, name: 'Dark', sets: ['base', 'dark'] }))
}

/** Exactly what ModeValueRow.commit does: write into the theme's top set. */
async function editModeValue(themeId: string, name: string, value: string): Promise<void> {
  const top = themeTopSet(lib(), theme(themeId))!
  const own = findToken(top, name)
  if (own) await modifyToken(top.id, own.id, { ...own, value })
  else await addToken(top.id, createToken({ name, type: 'color', value }))
}

describe('per-mode value editing', () => {
  it('a theme’s top set is the last of its sets in lib order', async () => {
    await setup()
    expect(themeTopSet(lib(), theme(LIGHT_THEME))?.name).toBe('base')
    expect(themeTopSet(lib(), theme(DARK_THEME))?.name).toBe('dark')
  })

  it('editing Dark writes an override into dark that wins for Dark only', async () => {
    await setup()
    await editModeValue(DARK_THEME, 'color.bg', '#000000')

    // Landed in dark; base is untouched.
    expect(findToken(set(DARK), 'color.bg')?.value).toBe('#000000')
    expect(findToken(set(BASE), 'color.bg')?.value).toBe('#FFFFFF')

    await setActiveThemes([DARK_THEME])
    expect(resolvedBg()).toBe('#000000') // dark overrides base
    await setActiveThemes([LIGHT_THEME])
    expect(resolvedBg()).toBe('#FFFFFF') // the other mode is unaffected
  })

  it('editing Light modifies the base token in place, creating no override', async () => {
    await setup()
    await editModeValue(LIGHT_THEME, 'color.bg', '#EEEEEE')

    expect(findToken(set(BASE), 'color.bg')?.value).toBe('#EEEEEE')
    expect(set(DARK).tokens).toHaveLength(0)
    await setActiveThemes([LIGHT_THEME])
    expect(resolvedBg()).toBe('#EEEEEE')
  })

  it('removing the Dark override falls back to the inherited base value', async () => {
    await setup()
    await editModeValue(DARK_THEME, 'color.bg', '#000000')
    await setActiveThemes([DARK_THEME])
    expect(resolvedBg()).toBe('#000000')

    const top = themeTopSet(lib(), theme(DARK_THEME))!
    await deleteToken(top.id, findToken(top, 'color.bg')!.id)
    expect(resolvedBg()).toBe('#FFFFFF') // inherits base again
  })

  it('a per-mode override reverts in a single undo', async () => {
    await setup()
    await setActiveThemes([DARK_THEME])
    await editModeValue(DARK_THEME, 'color.bg', '#000000')
    expect(resolvedBg()).toBe('#000000')

    await undo()
    expect(resolvedBg()).toBe('#FFFFFF')
    expect(set(DARK).tokens).toHaveLength(0)
  })
})
