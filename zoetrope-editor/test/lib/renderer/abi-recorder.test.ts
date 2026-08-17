/**
 * The differential harness (slice F).
 *
 * The shape of the thing: record the ABI call stream once, replay it into a backend, and read
 * out a digest of the scene it built. Because the recording contains only the host's intent —
 * entry point names, arguments, and the bytes staged in the shared buffer — the same capture
 * drives any backend that speaks the wire format. A divergence is then attributable: identical
 * bytes in, different scene out.
 *
 * Diffing at the *model* rather than at pixels is deliberate. Two rasterisers will always differ
 * slightly on antialiasing, and a pixel diff cannot tell "we disagree about the document" from
 * "we disagree about coverage on this edge". `Scene::digest` answers the first question alone,
 * which is the one that has to be settled first.
 *
 * Only the Vello side is exercised here. render-wasm cannot be driven in Node — its `_init`
 * brings up a GL context — so the cross-backend comparison needs a browser, and this is the
 * transport that will carry it there.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { loadVello, velloWasmAvailable, type VelloInstance } from './vello-instance'
import { createRecorder, replay, type Recording } from '../../../src/lib/renderer/abi-recorder'
import { setContextInitialized } from '../../../src/lib/renderer/api/context'
import { setObject } from '../../../src/lib/renderer/api/orchestration'
import { createCircle, createFrame, createRect } from '../../../src/lib/renderer/node-factory'
import { setShapeChildren } from '../../../src/lib/renderer/api/shape'
import type { EmscriptenLikeModule } from '../../../src/lib/renderer/vello-module-facade'

beforeAll(() => setContextInitialized(true))

const suite = velloWasmAvailable() ? describe : describe.skip

suite('ABI record/replay', () => {
  let vello: VelloInstance

  beforeAll(async () => {
    vello = await loadVello()
  })

  /** Push a small page through the real `api/*.ts`, returning what crossed the boundary. */
  function recordPageSync(module: EmscriptenLikeModule): Recording {
    const recorder = createRecorder(module)
    const m = recorder.module

    const frame = createFrame({ x: 0, y: 0, width: 400, height: 300 })
    const rect = createRect({
      parentId: frame.id,
      x: 20,
      y: 20,
      width: 100,
      height: 60,
      fillColor: '#3d8bfd',
      borderRadius: 12,
    })
    const circle = createCircle({
      parentId: frame.id,
      x: 200,
      y: 100,
      width: 80,
      height: 80,
      fillColor: '#f05a28',
    })

    for (const shape of [frame, rect, circle]) setObject(m, shape)
    m._use_shape(0, 0, 0, 0)
    setShapeChildren(m, [frame.id])

    return recorder.recording()
  }

  function digest(): number {
    return vello.exports.scene_digest()
  }

  /**
   * The digest covers only what is reachable from the root, so a scene whose root children were
   * never set hashes exactly like an empty one. That is the harness's sharpest trap: every
   * comparison would pass, proving nothing. Every assertion below is guarded against it.
   */
  function emptyDigest(): number {
    vello.exports.clean_up()
    return digest()
  }

  it('captures the call stream, including bytes staged in the shared buffer', () => {
    vello.exports.clean_up()
    const recording = recordPageSync(vello.module)

    expect(recording.calls.length).toBeGreaterThan(20)
    expect(recording.calls.map((c) => c.fn)).toContain('use_shape')

    // Fills live in the buffer, not in the arguments. A recording without them would replay
    // into a colourless scene and still look plausible.
    const fills = recording.calls.filter((c) => c.fn === 'set_shape_fills')
    expect(fills.length).toBeGreaterThan(0)
    expect(fills.some((c) => c.buffer !== undefined && c.buffer.length > 0)).toBe(true)
  })

  /**
   * The load-bearing property. If replay does not reproduce the scene exactly, every downstream
   * comparison is measuring the harness rather than the backends.
   */
  it('replays to a byte-identical scene', () => {
    const empty = emptyDigest()

    const recording = recordPageSync(vello.module)
    const direct = digest()
    const nodes = vello.exports.scene_node_count()
    expect(direct, 'the recorded page must not digest as an empty scene').not.toBe(empty)

    vello.exports.clean_up()
    expect(digest()).toBe(empty)

    replay(vello.module, recording)
    expect(vello.exports.scene_node_count()).toBe(nodes)
    expect(digest()).toBe(direct)
  })

  /**
   * The resolution the harness actually needs. A digest that only notices whole shapes appearing
   * and disappearing would miss the divergences worth catching — a rounding difference in a
   * selrect, a corner radius read from the wrong offset.
   *
   * Two things this has to control for, both of which made an earlier version of this test pass
   * without exercising geometry at all:
   *
   * - **Fixed ids.** `node-factory` mints a fresh uuid per call and the digest hashes ids, so
   *   two rebuilds differ no matter what the geometry does.
   * - **A listed child.** `setObject` takes a container's children from its own `shapes` array;
   *   `parentId` alone leaves the rect unreachable from the root, and the digest never sees it.
   */
  it('notices a one-unit geometry difference in a nested child', () => {
    const empty = emptyDigest()
    const FRAME = '44444444-4444-4444-8444-444444444444'
    const RECT = '55555555-5555-4555-8555-555555555555'

    const sync = (height: number): number => {
      vello.exports.clean_up()
      const frame = createFrame({
        id: FRAME,
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        shapes: [RECT],
      })
      const rect = createRect({
        id: RECT,
        parentId: FRAME,
        x: 20,
        y: 20,
        width: 100,
        height,
        fillColor: '#3d8bfd',
      })
      setObject(vello.module, frame)
      setObject(vello.module, rect)
      vello.module._use_shape(0, 0, 0, 0)
      setShapeChildren(vello.module, [FRAME])
      return digest()
    }

    const a = sync(60)
    expect(a).not.toBe(empty)
    expect(vello.exports.scene_paintable_count(), 'the rect must be reachable').toBe(1)

    const b = sync(61)
    expect(b, 'one unit of child geometry must move the digest').not.toBe(a)
  })

  it('survives a JSON round trip, so a browser capture can become a fixture', () => {
    const empty = emptyDigest()
    const recording = recordPageSync(vello.module)
    const direct = digest()
    expect(direct).not.toBe(empty)

    const revived = JSON.parse(JSON.stringify(recording)) as Recording

    vello.exports.clean_up()
    replay(vello.module, revived)
    expect(digest()).toBe(direct)
  })

  /**
   * Replay must re-run `alloc_bytes` rather than trusting the recorded pointer: the address is
   * the backend's own business, and two backends will not agree on it.
   */
  it('writes staged bytes wherever the replaying backend allocates', () => {
    const empty = emptyDigest()
    const recording = recordPageSync(vello.module)
    const direct = digest()
    expect(direct).not.toBe(empty)

    // Perturb the allocator so a replay that reused recorded pointers would land elsewhere.
    vello.exports.clean_up()
    const ptr = vello.exports.alloc_bytes(4096)
    expect(ptr).not.toBe(0)
    vello.exports.free_bytes()

    replay(vello.module, recording)
    expect(digest()).toBe(direct)
  })

  it('rejects a recording it cannot honour rather than replaying it partially', () => {
    const bogus = { version: 1, calls: [{ fn: 'no_such_entry_point', args: [] }] } as Recording
    // The raw exports have no stubbing, so a missing entry point is a hard error — which is
    // what a harness wants, unlike the host path where stubs keep a page alive.
    expect(() =>
      replay(vello.exports as unknown as EmscriptenLikeModule, bogus)
    ).toThrow(/no entry point/)

    expect(() => replay(vello.module, { version: 2 } as unknown as Recording)).toThrow(
      /unsupported recording version/
    )
  })

  /** The digest has to move when the document does, or the comparison proves nothing. */
  it('produces a different digest for a different document', () => {
    const empty = emptyDigest()
    recordPageSync(vello.module)
    const a = digest()
    expect(a).not.toBe(empty)

    vello.exports.clean_up()
    const frame = createFrame({ x: 0, y: 0, width: 400, height: 300 })
    setObject(vello.module, frame)
    vello.module._use_shape(0, 0, 0, 0)
    setShapeChildren(vello.module, [frame.id])
    const b = digest()

    expect(b).not.toBe(a)
  })
})
