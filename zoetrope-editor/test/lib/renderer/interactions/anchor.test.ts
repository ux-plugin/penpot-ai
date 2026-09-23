import { describe, it, expect, beforeAll } from 'vitest'
import {
  requiredAnchors,
  collectAnchors,
  collectAnchorsFromTree,
  validateGeneratedSource,
  validatePresentation,
  formatAnchorReport,
} from '../../../../src/lib/renderer/interactions/anchor'
import { emitReactComponent, type PNode } from '../../../../src/lib/renderer/interactions/compile/emit-react'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import { todo } from './behaviour-fixtures'

const presentation: PNode = {
  nodeId: 'page',
  role: 'container',
  children: [
    { nodeId: 'addBtn', role: 'button', text: 'Add' },
    { nodeId: 'list', role: 'list', children: [{ nodeId: 'row', role: 'item' }] },
  ],
}

beforeAll(() => initDefaultCatalog())

describe('requiredAnchors', () => {
  it('is exactly the behavior-bearing nodes (presentational ones are optional)', () => {
    expect([...requiredAnchors(todo())].sort()).toEqual(['addBtn', 'row'])
  })
})

describe('collectAnchors', () => {
  it('counts both literal forms', () => {
    const counts = collectAnchors('<a data-node-id="x" /><b data-node-id={"y"} /><c data-node-id="x" />')
    expect(counts.get('x')).toBe(2)
    expect(counts.get('y')).toBe(1)
  })
})

describe('validate the real generated component', () => {
  const source = emitReactComponent(todo(), presentation, { componentName: 'TodoDemo' })

  it('passes the 1:1 anchor invariant', () => {
    const report = validateGeneratedSource(todo(), source)
    expect(report.ok).toBe(true)
    expect(formatAnchorReport(report)).toBe('anchors OK')
    // repeater template appears exactly once in the static source
    expect(collectAnchors(source).get('row')).toBe(1)
  })

  it('flags a dropped anchor (AI removed the button anchor)', () => {
    const broken = source.replace('data-node-id="addBtn"', '')
    const report = validateGeneratedSource(todo(), broken)
    expect(report.ok).toBe(false)
    expect(report.violations).toContainEqual({ node: 'addBtn', kind: 'missing', count: 0 })
  })

  it('flags a duplicated anchor (AI split a node into two)', () => {
    const broken = source + '\n<li data-node-id="row" />'
    const report = validateGeneratedSource(todo(), broken)
    expect(report.ok).toBe(false)
    expect(report.violations).toContainEqual({ node: 'row', kind: 'duplicate', count: 2 })
  })
})

describe('validate a presentation tree', () => {
  it('accepts a tree that anchors every behavior-bearing node once', () => {
    expect(validatePresentation(todo(), presentation).ok).toBe(true)
  })

  it('rejects a tree missing a required anchor', () => {
    const missingRow: PNode = { nodeId: 'page', role: 'container', children: [{ nodeId: 'addBtn', role: 'button' }] }
    const report = validatePresentation(todo(), missingRow)
    expect(report.ok).toBe(false)
    expect(report.violations.some((v) => v.node === 'row' && v.kind === 'missing')).toBe(true)
  })

  it('counts tree anchors correctly', () => {
    expect(collectAnchorsFromTree(presentation).get('addBtn')).toBe(1)
  })
})
