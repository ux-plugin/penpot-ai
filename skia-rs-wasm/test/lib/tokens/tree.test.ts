/**
 * Folder-tree builder — sets nest by "/", tokens nest by "." (pure rendering of
 * the model, no schema change).
 */

import { describe, expect, it } from 'vitest'
import {
  buildTokenTree,
  countTokenLeaves,
  pruneTokenTree,
  tokenNodeId,
  type TokenTreeNode,
} from '../../../src/lib/tokens/tree'
import { createToken, createTokenSet, type TokensLib } from '../../../src/lib/tokens/types'

function lib(): TokensLib {
  return {
    sets: [
      createTokenSet({
        id: 'g',
        name: 'Global',
        tokens: [createToken({ id: 'p', name: 'color.primary', type: 'color', value: '#3B82F6' })],
      }),
      createTokenSet({
        id: 'b',
        name: 'brand',
        tokens: [
          createToken({ id: 'br', name: 'color.brand', type: 'color', value: '#EF4444' }),
          createToken({ id: 'ac', name: 'color.accent', type: 'color', value: '#F59E0B' }),
        ],
      }),
      createTokenSet({
        id: 'cc',
        name: 'core/colors',
        tokens: [
          createToken({ id: 'bg', name: 'color.bg.default', type: 'color', value: '#0F172A' }),
          createToken({ id: 'tx', name: 'color.text', type: 'color', value: '#E2E8F0' }),
        ],
      }),
    ],
    themes: [],
    activeThemes: [],
  }
}

function byName(nodes: TokenTreeNode[], name: string): TokenTreeNode {
  const n = nodes.find((x) => x.name === name)
  if (!n) throw new Error(`no node ${name} in [${nodes.map((x) => x.name).join(', ')}]`)
  return n
}

describe('buildTokenTree — sets nest by "/"', () => {
  it('flat sets are top-level; "core/colors" nests under a core folder', () => {
    const roots = buildTokenTree(lib())
    expect(roots.map((n) => `${n.kind}:${n.name}`)).toEqual(['set:Global', 'set:brand', 'folder:core'])

    const core = byName(roots, 'core')
    expect(core.kind).toBe('folder')
    if (core.kind !== 'folder') return
    expect(core.children.map((n) => `${n.kind}:${n.name}`)).toEqual(['set:colors'])
  })
})

describe('buildTokenTree — tokens nest by "."', () => {
  it('groups color.* and nests color.bg.default two deep', () => {
    const roots = buildTokenTree(lib())
    const colors = (() => {
      const core = byName(roots, 'core')
      return core.kind === 'folder' ? byName(core.children, 'colors') : core
    })()
    expect(colors.kind).toBe('set')
    if (colors.kind !== 'set') return

    // colors set → group "color" → { group "bg" → leaf "default", leaf "text" }
    const color = byName(colors.children, 'color')
    expect(color.kind).toBe('group')
    if (color.kind !== 'group') return
    expect(color.children.map((n) => `${n.kind}:${n.name}`)).toEqual(['group:bg', 'token:text'])

    const bg = byName(color.children, 'bg')
    if (bg.kind !== 'group') return
    expect(bg.children.map((n) => `${n.kind}:${n.name}`)).toEqual(['token:default'])
  })

  it('brand set exposes color.brand + color.accent as leaves under group color', () => {
    const roots = buildTokenTree(lib())
    const brand = byName(roots, 'brand')
    if (brand.kind !== 'set') return
    const color = byName(brand.children, 'color')
    if (color.kind !== 'group') return
    expect(color.children.map((n) => n.name).sort()).toEqual(['accent', 'brand'])
  })
})

describe('countTokenLeaves + pruneTokenTree', () => {
  it('counts leaves under a set', () => {
    const roots = buildTokenTree(lib())
    expect(countTokenLeaves(byName(roots, 'brand'))).toBe(2)
    expect(roots.reduce((n, r) => n + countTokenLeaves(r), 0)).toBe(5)
  })

  it('prunes to only visible token ids, dropping empty branches', () => {
    const roots = buildTokenTree(lib())
    const visible = new Set([tokenNodeId('b', 'br')]) // only brand/color.brand
    const pruned = pruneTokenTree(roots, visible)
    expect(pruned.map((n) => n.name)).toEqual(['brand'])
    expect(countTokenLeaves(pruned[0])).toBe(1)
  })
})
