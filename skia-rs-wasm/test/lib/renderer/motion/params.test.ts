import { afterEach, describe, expect, it } from 'vitest'
import { evaluateTimeline } from '../../../../src/lib/renderer/anim/evaluate'
import {
  addNumberParam,
  bindPropertyToParam,
  motionParamDefs,
  motionParams,
  motionShapes,
  removeParam,
  setMotionShapes,
  setParamValue,
} from '../../../../src/lib/renderer/motion/motion-store'

afterEach(() => {
  setMotionShapes([])
  motionParamDefs.value = []
  motionParams.value = {}
})

describe('parameter store', () => {
  it('adds a number parameter initialised at its min', () => {
    const id = addNumberParam(0, 1)
    expect(motionParamDefs.value.find((d) => d.id === id)).toMatchObject({ kind: 'number', min: 0, max: 1 })
    expect(motionParams.value[id]).toBe(0)
  })

  it('clamps a set value to the parameter range', () => {
    const id = addNumberParam(0, 1)
    setParamValue(id, 0.5)
    expect(motionParams.value[id]).toBe(0.5)
    setParamValue(id, 5)
    expect(motionParams.value[id]).toBe(1)
    setParamValue(id, -3)
    expect(motionParams.value[id]).toBe(0)
  })

  it('removes a parameter and its value', () => {
    const id = addNumberParam()
    removeParam(id)
    expect(motionParamDefs.value).toHaveLength(0)
    expect(motionParams.value[id]).toBeUndefined()
  })

  it('binds a property to a parameter so the evaluator drives it live', () => {
    const id = addNumberParam(0, 1)
    bindPropertyToParam('s1', 'x', id, 100)
    const tl = motionShapes.value.find((s) => s.targetId === 's1')!.timeline
    // param at min -> delta 0; at mid -> 50; at max -> 100 (through the real evaluator)
    expect(evaluateTimeline(tl, { time: 0, params: { [id]: 0 } }).get('s1')).toEqual({ x: 0 })
    expect(evaluateTimeline(tl, { time: 0, params: { [id]: 0.5 } }).get('s1')).toEqual({ x: 50 })
    expect(evaluateTimeline(tl, { time: 0, params: { [id]: 1 } }).get('s1')).toEqual({ x: 100 })
  })
})
