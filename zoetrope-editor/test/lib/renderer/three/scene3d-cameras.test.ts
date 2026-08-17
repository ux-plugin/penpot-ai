import { describe, expect, it } from 'vitest'
import {
  defaultSceneDocument,
  defaultCamera,
  sceneCameras,
  activeCamera,
  type Scene3DDocument,
} from '@/lib/renderer/three/scene3d-store'

describe('scene cameras model', () => {
  it('a default scene has one active perspective camera', () => {
    const s = defaultSceneDocument('s1')
    expect(s.cameras).toHaveLength(1)
    expect(s.activeCameraId).toBe(s.cameras![0].id)
    const cam = activeCamera(s)
    expect(cam).toBe(s.cameras![0])
    expect(cam.projection).toBe('perspective')
  })

  it('derives the default camera id from the scene id', () => {
    expect(defaultCamera('abc').id).toBe('abc:cam0')
  })

  it('synthesises a camera for a legacy scene (no cameras[]), carrying camera.fov', () => {
    const legacy = {
      sceneId: 's1',
      camera: { fov: 60 },
      env: { preset: 'studio', intensity: 1 },
      objects: [],
    } as Scene3DDocument
    const cams = sceneCameras(legacy)
    expect(cams).toHaveLength(1)
    expect(cams[0].projection).toBe('perspective')
    expect(cams[0].fov).toBe(60)
    expect(activeCamera(legacy).fov).toBe(60)
  })

  it('activeCamera falls back to the first when activeCameraId is unknown', () => {
    const s = defaultSceneDocument('s1')
    s.activeCameraId = 'does-not-exist'
    expect(activeCamera(s)).toBe(sceneCameras(s)[0])
  })
})
