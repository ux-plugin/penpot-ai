import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import { demoIR } from '../../../../src/lib/renderer/interactions/preview/demo'
import {
  initRuntime,
  buildEnv,
  runInteraction,
  type RuntimeState,
} from '../../../../src/lib/renderer/interactions/preview/runtime'
import type { PageInteractions } from '../../../../src/lib/renderer/interactions/ir'

beforeAll(() => initDefaultCatalog())

/** Fire the first interaction registered on a node — mirrors a click in the panel. */
function press(ir: PageInteractions, rt: RuntimeState, nodeId: string): RuntimeState {
  const it = ir.interactions.find((x) => x.on.node === nodeId)
  if (!it) throw new Error(`no interaction on ${nodeId}`)
  return runInteraction(ir, rt, it, buildEnv(ir, rt))
}

describe('preview runtime — live interpreter semantics', () => {
  it('starts empty with Clear disabled (isEmpty = true)', () => {
    const ir = demoIR()
    const env = buildEnv(ir, initRuntime(ir))
    expect((env.items as unknown[]).length).toBe(0)
    expect(env.isEmpty).toBe(true)
  })

  it('Add appends numbered rows and flips isEmpty', () => {
    const ir = demoIR()
    let rt = initRuntime(ir)
    rt = press(ir, rt, 'addBtn')
    rt = press(ir, rt, 'addBtn')
    rt = press(ir, rt, 'addBtn')
    const env = buildEnv(ir, rt)
    expect((env.items as Array<{ label: string }>).map((i) => i.label)).toEqual(['Item 1', 'Item 2', 'Item 3'])
    expect(env.isEmpty).toBe(false)
  })

  it('Clear empties the list and re-disables Clear', () => {
    const ir = demoIR()
    let rt = initRuntime(ir)
    rt = press(ir, rt, 'addBtn')
    rt = press(ir, rt, 'clearBtn')
    const env = buildEnv(ir, rt)
    expect((env.items as unknown[]).length).toBe(0)
    expect(env.isEmpty).toBe(true)
  })
})
