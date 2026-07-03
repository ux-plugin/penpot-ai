/**
 * camera3d — pure camera math for the 3D scene overlay (no three side-effects on
 * import beyond type usage). Keeps the projection/framing arithmetic unit-testable
 * apart from the WebGL wiring in three-scene / Scene3DLayer.
 *
 * A scene renders through its ACTIVE camera, which is perspective or orthographic:
 *  - perspective is framed by vertical FOV + aspect (the default look);
 *  - orthographic is framed by a world half-height + aspect (parallel projection —
 *    "centre fixed, invariant to window size", no perspective distortion).
 * When the two projections must look the same (a persp⇄ortho swap), the shared
 * quantity is the world half-height visible AT THE PIVOT DISTANCE — the helpers
 * below convert between FOV and that half-height so a swap preserves framing.
 */

import * as THREE from 'three'

/** Near/far planes shared by both projections. */
export const CAM_NEAR = 0.01
export const CAM_FAR = 100
const DEG = Math.PI / 180

export function isOrtho(cam: THREE.Camera): cam is THREE.OrthographicCamera {
  return (cam as THREE.OrthographicCamera).isOrthographicCamera === true
}
export function isPersp(cam: THREE.Camera): cam is THREE.PerspectiveCamera {
  return (cam as THREE.PerspectiveCamera).isPerspectiveCamera === true
}

/** World half-height visible at `dist` in front of a perspective camera of `fovDeg`. */
export function perspHalfHeightAtDistance(fovDeg: number, dist: number): number {
  return Math.tan((Math.max(1, fovDeg) * DEG) / 2) * Math.max(dist, 1e-4)
}

/** Vertical FOV (deg) that shows `halfHeight` at `dist` — the inverse of the above. */
export function perspFovForHalfHeight(halfHeight: number, dist: number): number {
  return (Math.atan(Math.max(halfHeight, 1e-4) / Math.max(dist, 1e-4)) * 2) / DEG
}

/** Symmetric orthographic frustum bounds for a world half-height + viewport aspect. */
export function orthoFrustum(
  halfHeight: number,
  aspect: number,
): { left: number; right: number; top: number; bottom: number } {
  const h = Math.max(halfHeight, 1e-4)
  const w = h * Math.max(aspect, 1e-4)
  return { left: -w, right: w, top: h, bottom: -h }
}
