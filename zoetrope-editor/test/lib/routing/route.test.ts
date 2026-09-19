/**
 * The URL is the source of truth for what's open, so parsing has to be total:
 * every pathname resolves to a route, and a bad one lands on the documents screen
 * rather than throwing during boot.
 */

import { describe, expect, it } from 'vitest'
import {
  parseRoute,
  routeToPath,
  routesEqual,
  type Route,
} from '../../../src/lib/routing/route'

describe('route parsing', () => {
  it('maps the root to home', () => {
    expect(parseRoute('/')).toEqual({ kind: 'home' })
    expect(parseRoute('')).toEqual({ kind: 'home' })
  })

  it('maps /d/<id> to that document', () => {
    expect(parseRoute('/d/9f3a2b')).toEqual({ kind: 'doc', id: '9f3a2b' })
  })

  it('ignores trailing and doubled slashes', () => {
    expect(parseRoute('/d/9f3a2b/')).toEqual({ kind: 'doc', id: '9f3a2b' })
    expect(parseRoute('//d//9f3a2b//')).toEqual({ kind: 'doc', id: '9f3a2b' })
  })

  it('falls back to home for anything unrecognised', () => {
    expect(parseRoute('/d')).toEqual({ kind: 'home' })
    expect(parseRoute('/d/')).toEqual({ kind: 'home' })
    expect(parseRoute('/documents/9f3a2b')).toEqual({ kind: 'home' })
    // A deeper path is not a document route today — page segments are additive
    // and would be handled explicitly, not by accident.
    expect(parseRoute('/d/9f3a2b/p/page-1')).toEqual({ kind: 'home' })
  })

  it('survives a malformed percent-escape instead of throwing during boot', () => {
    expect(parseRoute('/d/%')).toEqual({ kind: 'home' })
    expect(parseRoute('/d/%E0%A4%A')).toEqual({ kind: 'home' })
  })

  it('round-trips ids that need encoding', () => {
    const route: Route = { kind: 'doc', id: 'a b/c?d#e' }
    expect(parseRoute(routeToPath(route))).toEqual(route)
  })

  it('formats routes back to paths', () => {
    expect(routeToPath({ kind: 'home' })).toBe('/')
    expect(routeToPath({ kind: 'doc', id: '9f3a2b' })).toBe('/d/9f3a2b')
  })
})

describe('routesEqual', () => {
  it('compares kind and id', () => {
    expect(routesEqual({ kind: 'home' }, { kind: 'home' })).toBe(true)
    expect(routesEqual({ kind: 'doc', id: 'a' }, { kind: 'doc', id: 'a' })).toBe(true)
    expect(routesEqual({ kind: 'doc', id: 'a' }, { kind: 'doc', id: 'b' })).toBe(false)
    expect(routesEqual({ kind: 'home' }, { kind: 'doc', id: 'a' })).toBe(false)
  })
})
