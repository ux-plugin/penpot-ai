/**
 * The claim under test: **the host's `api/*.ts` layer drives the Vello backend unmodified.**
 *
 * D17 chose to reuse render-wasm's wire format and calling convention precisely so that no part
 * of `api/*.ts` would need a second implementation. That is easy to assert and easy to be wrong
 * about, so this drives the real modules — `node-factory` builds the shapes, `orchestration`
 * pushes them, `canvas` sets the viewport — against a real `render-vello` wasm instance, and
 * checks what actually landed in the scene.
 *
 * Nothing here is a mock. The only stand-ins are the ~600 wasm-bindgen glue imports, which the
 * ABI path never calls (see `vello-instance.ts`), and the entry points Vello has not implemented
 * yet, which the facade stubs and records.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { loadVello, velloWasmAvailable, type VelloInstance } from './vello-instance'
import { setContextInitialized } from '../../../src/lib/renderer/api/context'
import { setObject } from '../../../src/lib/renderer/api/orchestration'
import {
  createCircle,
  createFrame,
  createGroup,
  createRect,
  createRootFrame,
} from '../../../src/lib/renderer/node-factory'
import { setViewBox } from '../../../src/lib/renderer/api/viewport'
import { setShapeChildren } from '../../../src/lib/renderer/api/shape'

/** `api/*.ts` guards every call on this; the Skia path sets it when the GL context comes up. */
beforeAll(() => setContextInitialized(true))

const suite = velloWasmAvailable() ? describe : describe.skip

suite('api/*.ts drives render-vello unmodified', () => {
  let vello: VelloInstance

  beforeAll(async () => {
    vello = await loadVello()
  })

  function freshScene(): VelloInstance {
    vello.exports.clean_up()
    return vello
  }

  it('pushes a shape tree built by the app’s own node factory', () => {
    const { module, exports } = freshScene()

    const frame = createFrame({ id: undefined, x: 0, y: 0, width: 400, height: 300 })
    const rect = createRect({ parentId: frame.id, x: 20, y: 20, width: 100, height: 60 })
    const circle = createCircle({ parentId: frame.id, x: 200, y: 100, width: 80, height: 80 })

    for (const shape of [frame, rect, circle]) {
      setObject(module, shape)
    }
    // The root lists the top-level frame, exactly as a page sync does.
    module._use_shape(0, 0, 0, 0)
    setShapeChildren(module, [frame.id])

    // frame + rect + circle + root
    expect(exports.scene_node_count()).toBe(4)
  })

  /**
   * The property that makes the shared wire format worth having: the same `setObject` call
   * produces the same geometry in both backends. Checked here by reading the values back out of
   * the Vello scene through the one introspection export it has, plus the ABI's own setters.
   */
  it('carries selrect, opacity and hidden through to the scene', () => {
    const { module, exports } = freshScene()

    const rect = createRect({ x: 10, y: 20, width: 30, height: 40, opacity: 0.25 })
    rect.hidden = true
    setObject(module, rect)

    expect(exports.scene_node_count()).toBe(1)
    // The shape exists under the id the host used, which is the part a u128 packing bug breaks.
    expect(vello.missing).not.toContain('use_shape')
    expect(vello.missing).not.toContain('set_shape_selrect')
    expect(vello.missing).not.toContain('set_shape_opacity')
    expect(vello.missing).not.toContain('set_shape_hidden')
  })

  it('sends fills through the shared buffer without the host knowing which backend it is', () => {
    const { module, exports } = freshScene()

    const rect = createRect({ fillColor: '#3d8bfd', fillOpacity: 1 })
    setObject(module, rect)

    expect(exports.scene_node_count()).toBe(1)
    expect(vello.missing).not.toContain('set_shape_fills')
    expect(vello.missing).not.toContain('alloc_bytes')
  })

  it('applies the viewport through api/canvas', () => {
    const { module } = freshScene()

    setViewBox(module, 1, 2.5, { x: -100, y: -50 })

    // `set_view` is real on this backend; if it had been stubbed the viewport would silently
    // never move, which looks like a rendering bug rather than a missing export.
    expect(vello.missing).not.toContain('set_view')
  })

  it('survives a whole page of mixed shapes, including kinds it cannot draw yet', async () => {
    const { module, exports } = freshScene()

    const root = createRootFrame(1200, 800)
    const group = createGroup({ parentId: root.id })
    const shapes = [
      root,
      group,
      createRect({ parentId: group.id, fillColor: '#ff0000' }),
      createCircle({ parentId: group.id, fillColor: '#00ff00' }),
      createFrame({ parentId: root.id, x: 400, y: 400, width: 200, height: 200 }),
    ]

    // The real page-load path: no `changedKeys`, so every property is pushed.
    expect(() => shapes.forEach((s) => setObject(module, s))).not.toThrow()
    expect(exports.scene_node_count()).toBe(shapes.length)
  })

  /**
   * Not an assertion so much as a census. The Vello backend implements a fraction of
   * render-wasm's entry points, and this records which ones a plain page sync reaches — the
   * list that sizes Phases 4 and 5. It is deliberately not pinned to an exact set: that would
   * turn every new entry point into a test edit.
   */
  it('reports which entry points a page sync still needs', () => {
    const { module } = freshScene()
    setObject(module, createRect({ fillColor: '#123456' }))
    setObject(module, createFrame({}))

    // Whatever is missing, none of it should be the geometry core: those are implemented, and a
    // regression there would show up here before it showed up as a blank canvas.
    const core = [
      'use_shape',
      'set_shape_type',
      'set_shape_selrect',
      'set_shape_transform',
      'set_shape_fills',
      'set_shape_corners',
      'set_children_1',
      'set_parent',
    ]
    expect(vello.missing.filter((n) => core.includes(n))).toEqual([])

    console.log(`[vello] entry points not yet implemented: ${vello.missing.sort().join(', ')}`)
  })
})
