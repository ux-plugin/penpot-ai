import { describe, it, expect, beforeAll } from 'vitest'
import { initDefaultCatalog } from '../../../../src/lib/renderer/interactions/catalog'
import { demoBehaviour } from '../../../../src/lib/renderer/interactions/preview/demo'
import {
  initRuntime,
  buildEnv,
  runRule,
  type RuntimeState,
} from '../../../../src/lib/renderer/interactions/preview/runtime'
import type { Behaviour } from '../../../../src/lib/renderer/interactions/ir'

beforeAll(() => initDefaultCatalog())

/** Fire the first rule on a node — mirrors a click in the panel. */
function press(b: Behaviour, rt: RuntimeState, nodeId: string): RuntimeState {
  const rule = b.rules.find((r) => r.node === nodeId)
  if (!rule) throw new Error(`no rule on ${nodeId}`)
  return runRule(b, rt, rule, buildEnv(b, rt))
}

describe('preview runtime — live interpreter semantics', () => {
  it('starts empty with Clear disabled (isEmpty = true)', () => {
    const b = demoBehaviour()
    const env = buildEnv(b, initRuntime(b))
    expect((env.items as unknown[]).length).toBe(0)
    expect(env.isEmpty).toBe(true)
  })

  it('Add appends numbered rows and flips isEmpty', () => {
    const b = demoBehaviour()
    let rt = initRuntime(b)
    rt = press(b, rt, 'addBtn')
    rt = press(b, rt, 'addBtn')
    rt = press(b, rt, 'addBtn')
    const env = buildEnv(b, rt)
    expect((env.items as Array<{ label: string }>).map((i) => i.label)).toEqual(['Item 1', 'Item 2', 'Item 3'])
    expect(env.isEmpty).toBe(false)
  })

  it('Clear empties the list and re-disables Clear', () => {
    const b = demoBehaviour()
    let rt = initRuntime(b)
    rt = press(b, rt, 'addBtn')
    rt = press(b, rt, 'clearBtn')
    const env = buildEnv(b, rt)
    expect((env.items as unknown[]).length).toBe(0)
    expect(env.isEmpty).toBe(true)
  })
})
