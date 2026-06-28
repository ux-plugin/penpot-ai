import { describe, it, expect } from 'vitest'
import { Link2, Move, Plus, Spline } from 'lucide-react'
import {
  effectiveSubTool,
  resolvePathInteraction,
  type PathInteractionInput,
} from '@/lib/components/Overlay/path-interaction'
import { PEN_CURSOR, SELECT_CURSOR } from '@/lib/components/cursors'

const base = (over: Partial<PathInteractionInput>): PathInteractionInput => ({
  subTool: 'move',
  panHeld: false,
  altHeld: false,
  hover: 'empty',
  ...over,
})

describe('resolvePathInteraction — precedence', () => {
  it('pan preempts everything: no hint, no capture, no ghost, grab cursor', () => {
    const r = resolvePathInteraction(base({ subTool: 'add', hover: 'node-target', panHeld: true }))
    expect(r.mode).toBe('pan')
    expect(r.hint).toBeNull()
    expect(r.capture).toBe(false)
    expect(r.ghost).toBe(false)
    expect(r.cursor).toBe('grab')
  })

  it('a drag in flight suppresses hover affordances (hint + ghost) but not capture', () => {
    const r = resolvePathInteraction(base({ subTool: 'add', hover: 'empty', dragging: true }))
    expect(r.mode).toBe('add-free')
    expect(r.hint).toBeNull()
    expect(r.ghost).toBe(false)
    expect(r.capture).toBe(true)
  })
})

describe('resolvePathInteraction — Add sub-tool', () => {
  it('empty → add-free: plus hint, ghost + capture on, pen cursor', () => {
    const r = resolvePathInteraction(base({ subTool: 'add', hover: 'empty' }))
    expect(r.mode).toBe('add-free')
    expect(r.hint).toBe(Plus)
    expect(r.ghost).toBe(true)
    expect(r.capture).toBe(true)
    expect(r.cursor).toBe(PEN_CURSOR)
  })

  it('near an edge → add-edge: ghost + capture on', () => {
    const r = resolvePathInteraction(base({ subTool: 'add', hover: 'edge' }))
    expect(r.mode).toBe('add-edge')
    expect(r.hint).toBe(Plus)
    expect(r.ghost).toBe(true)
  })

  it('over a connectable node → connect: link hint, no ghost', () => {
    const r = resolvePathInteraction(base({ subTool: 'add', hover: 'node-target' }))
    expect(r.mode).toBe('connect')
    expect(r.hint).toBe(Link2)
    expect(r.ghost).toBe(false)
    expect(r.capture).toBe(true)
  })
})

describe('resolvePathInteraction — Move / Bend', () => {
  it('move over a node → move hint, arrow cursor, no capture/ghost', () => {
    const r = resolvePathInteraction(base({ subTool: 'move', hover: 'node' }))
    expect(r.mode).toBe('move')
    expect(r.hint).toBe(Move)
    expect(r.cursor).toBe(SELECT_CURSOR)
    expect(r.capture).toBe(false)
    expect(r.ghost).toBe(false)
  })

  it('move over empty → idle: no hint, arrow cursor', () => {
    const r = resolvePathInteraction(base({ subTool: 'move', hover: 'empty' }))
    expect(r.mode).toBe('idle')
    expect(r.hint).toBeNull()
    expect(r.cursor).toBe(SELECT_CURSOR)
  })

  it('bend over a node → bend hint, arrow cursor', () => {
    const r = resolvePathInteraction(base({ subTool: 'bend', hover: 'node' }))
    expect(r.mode).toBe('bend')
    expect(r.hint).toBe(Spline)
    expect(r.cursor).toBe(SELECT_CURSOR)
  })

  it('move + Alt over a node → bend (transient override)', () => {
    const r = resolvePathInteraction(base({ subTool: 'move', hover: 'node', altHeld: true }))
    expect(r.mode).toBe('bend')
    expect(r.hint).toBe(Spline)
  })
})

describe('resolvePathInteraction — Add + Alt (transient bend)', () => {
  it('Add + Alt over a connectable node → bend (not connect), spline hint, no capture/ghost', () => {
    const r = resolvePathInteraction(base({ subTool: 'add', hover: 'node-target', altHeld: true }))
    expect(r.mode).toBe('bend')
    expect(r.hint).toBe(Spline)
    expect(r.cursor).toBe(SELECT_CURSOR)
    expect(r.capture).toBe(false)
    expect(r.ghost).toBe(false)
  })

  it('Add + Alt over empty → idle: no add ghost, no capture, arrow cursor', () => {
    const r = resolvePathInteraction(base({ subTool: 'add', hover: 'empty', altHeld: true }))
    expect(r.mode).toBe('idle')
    expect(r.hint).toBeNull()
    expect(r.cursor).toBe(SELECT_CURSOR)
    expect(r.capture).toBe(false)
    expect(r.ghost).toBe(false)
  })

  it('Add + Alt over an edge → idle (nothing to bend on an edge)', () => {
    const r = resolvePathInteraction(base({ subTool: 'add', hover: 'edge', altHeld: true }))
    expect(r.mode).toBe('idle')
    expect(r.ghost).toBe(false)
  })
})

describe('effectiveSubTool', () => {
  it('Alt ⇒ Bend from any base tool (Move/Add/Bend)', () => {
    expect(effectiveSubTool('move', true)).toBe('bend')
    expect(effectiveSubTool('move', false)).toBe('move')
    expect(effectiveSubTool('bend', false)).toBe('bend')
    expect(effectiveSubTool('add', true)).toBe('bend')
    expect(effectiveSubTool('add', false)).toBe('add')
  })
})
