import { describe, it, expect } from 'vitest'
import {
  parse,
  evaluate,
  toJs,
  freeRefs,
  evalExpr,
  compileToJs,
  refsOf,
  ExprError,
  type ExprEnv,
} from '../../../../src/lib/renderer/interactions/expression'

/** Parse, evaluate, AND run the JS lowering — assert evaluator ≡ lowering. */
function parity(src: string, env: ExprEnv = {}): unknown {
  const node = parse(src)
  const evaluated = evaluate(node, env)
  const keys = Object.keys(env)
  const lowered = new Function(...keys, `return (${toJs(node)})`)(...keys.map((k) => env[k]))
  expect(lowered).toEqual(evaluated)
  return evaluated
}

describe('evaluator ≡ JS lowering (parity)', () => {
  it('arithmetic precedence', () => {
    expect(parity('1 + 2 * 3')).toBe(7)
    expect(parity('(1 + 2) * 3')).toBe(9)
    expect(parity('10 % 3')).toBe(1)
  })

  it('comparisons and logic', () => {
    expect(parity('items.length == 0', { items: [] })).toBe(true)
    expect(parity('items.length == 0', { items: [1] })).toBe(false)
    expect(parity('a > 0 ? "p" : "n"', { a: 5 })).toBe('p')
    expect(parity('a && b', { a: true, b: false })).toBe(false)
    expect(parity('a || b', { a: false, b: 7 })).toBe(7)
  })

  it('strings and concat', () => {
    expect(parity('"a" + "b"')).toBe('ab')
    expect(parity('name.includes("bc")', { name: 'abcd' })).toBe(true)
  })

  it('collection helpers with arrow fns', () => {
    const env = { items: [{ done: false }, { done: true }] }
    expect(parity('items.some(x => x.done)', env)).toBe(true)
    expect(parity('items.every(x => x.done)', env)).toBe(false)
    expect(parity('items.filter(x => x.done).length', env)).toBe(1)
    expect(parity('Math.max(a, b)', { a: 1, b: 2 })).toBe(2)
  })

  it('object and array literals', () => {
    expect(parity('{ label: "" }')).toEqual({ label: '' })
    expect(parity('[1, 2, 3].length')).toBe(3)
  })
})

describe('strict equality', () => {
  it('== is strict (no coercion) and lowers to ===', () => {
    expect(evalExpr('1 == 1')).toBe(true)
    expect(evalExpr('1 == "1"')).toBe(false)
    expect(compileToJs('a == b')).toBe('(a === b)')
    expect(compileToJs('a != b')).toBe('(a !== b)')
  })
})

describe('freeRefs', () => {
  it('collects root identifiers, excluding lambda params and Math', () => {
    expect([...refsOf('items.filter(x => x.done).length')].sort()).toEqual(['items'])
    expect([...refsOf('Math.max(a, b)')].sort()).toEqual(['a', 'b'])
    expect([...refsOf('item.label')].sort()).toEqual(['item'])
    expect([...freeRefs(parse('cart.total > threshold'))].sort()).toEqual(['cart', 'threshold'])
  })
})

describe('rejects unsafe / invalid input', () => {
  it('blocks assignment', () => {
    expect(() => parse('a = 1')).toThrow(ExprError)
  })
  it('blocks arbitrary function calls', () => {
    expect(() => parse('foo(1)')).toThrow(/whitelisted method calls/)
  })
  it('blocks non-whitelisted methods', () => {
    expect(() => parse('items.push(1)')).toThrow(/\.push\(\) is not allowed/)
    expect(() => parse('Math.random()')).toThrow(/Math\.random\(\) is not allowed/)
  })
  it('rejects incomplete input', () => {
    expect(() => parse('1 +')).toThrow(ExprError)
    expect(() => parse('a b')).toThrow(/trailing input/)
  })
})
