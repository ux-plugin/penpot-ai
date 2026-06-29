/**
 * Scene anchor (peephole model) — the box is a window onto a FIXED scene. The
 * anchor freezes while the box resizes (scene stays put, more world revealed) and
 * translates while the box moves (scene travels with it). Undo of a move is an
 * inverse move, so the anchor restores itself.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  ensureSceneAnchor,
  reconcileSceneAnchorOnRect,
  clearAllSceneAnchors,
} from '../../../../src/lib/renderer/three/scene3d-store'

const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

describe('scene anchor reconcile', () => {
  beforeEach(() => clearAllSceneAnchors())

  it('seeds on first sight, then translates on a pure move (size unchanged)', () => {
    const a = ensureSceneAnchor('s', 100, 50)
    reconcileSceneAnchorOnRect('s', R(100, 50, 360, 260)) // first sight → establish, no shift
    reconcileSceneAnchorOnRect('s', R(140, 40, 360, 260)) // move by (+40, -10)
    expect(a).toEqual({ x: 140, y: 40 })
  })

  it('freezes the anchor on a right/bottom resize (left/top edge fixed)', () => {
    const a = ensureSceneAnchor('s', 100, 50)
    reconcileSceneAnchorOnRect('s', R(100, 50, 360, 260))
    reconcileSceneAnchorOnRect('s', R(100, 50, 500, 400)) // grow right + down
    expect(a).toEqual({ x: 100, y: 50 })
  })

  it('freezes on a left/top resize even though x/y move (size changed ⇒ resize)', () => {
    const a = ensureSceneAnchor('s', 100, 50)
    reconcileSceneAnchorOnRect('s', R(100, 50, 360, 260))
    reconcileSceneAnchorOnRect('s', R(40, 20, 420, 290)) // drag left+top edges out
    expect(a).toEqual({ x: 100, y: 50 })
  })

  it('restores the anchor when a move is undone (inverse move)', () => {
    const a = ensureSceneAnchor('s', 100, 50)
    reconcileSceneAnchorOnRect('s', R(100, 50, 360, 260))
    reconcileSceneAnchorOnRect('s', R(160, 90, 360, 260)) // move
    expect(a).toEqual({ x: 160, y: 90 })
    reconcileSceneAnchorOnRect('s', R(100, 50, 360, 260)) // undo = inverse move
    expect(a).toEqual({ x: 100, y: 50 })
  })

  it('isolates anchors per scene', () => {
    const a = ensureSceneAnchor('a', 0, 0)
    const b = ensureSceneAnchor('b', 200, 200)
    reconcileSceneAnchorOnRect('a', R(0, 0, 360, 260))
    reconcileSceneAnchorOnRect('b', R(200, 200, 360, 260))
    reconcileSceneAnchorOnRect('a', R(10, 0, 360, 260)) // move only 'a'
    expect(a).toEqual({ x: 10, y: 0 })
    expect(b).toEqual({ x: 200, y: 200 })
  })
})
