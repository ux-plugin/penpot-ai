import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  isOrtho,
  isPersp,
  orthoFrustum,
  perspFovForHalfHeight,
  perspHalfHeightAtDistance,
} from '@/lib/renderer/three/camera3d'

describe('camera3d', () => {
  it('isPersp / isOrtho classify three cameras', () => {
    const persp = new THREE.PerspectiveCamera()
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1)
    expect(isPersp(persp)).toBe(true)
    expect(isOrtho(persp)).toBe(false)
    expect(isOrtho(ortho)).toBe(true)
    expect(isPersp(ortho)).toBe(false)
  })

  it('perspHalfHeightAtDistance scales linearly with distance and grows with FOV', () => {
    const near = perspHalfHeightAtDistance(45, 2)
    const far = perspHalfHeightAtDistance(45, 4)
    expect(far).toBeCloseTo(near * 2, 6)
    expect(perspHalfHeightAtDistance(60, 3)).toBeGreaterThan(perspHalfHeightAtDistance(30, 3))
  })

  it('perspFovForHalfHeight inverts perspHalfHeightAtDistance (framing-preserving swap)', () => {
    const dist = 4.104
    const fov = 45
    const h = perspHalfHeightAtDistance(fov, dist)
    expect(perspFovForHalfHeight(h, dist)).toBeCloseTo(fov, 4)
  })

  it('orthoFrustum is vertically symmetric and aspect-scaled horizontally', () => {
    const f = orthoFrustum(2, 1.5)
    expect(f.top).toBeCloseTo(2)
    expect(f.bottom).toBeCloseTo(-2)
    expect(f.right).toBeCloseTo(3)
    expect(f.left).toBeCloseTo(-3)
  })

  it('clamps degenerate inputs to safe positive values (no zero/negative frustum)', () => {
    expect(perspHalfHeightAtDistance(45, 0)).toBeGreaterThan(0)
    const f = orthoFrustum(0, 0)
    expect(f.top).toBeGreaterThan(0)
    expect(f.right).toBeGreaterThan(0)
  })
})
