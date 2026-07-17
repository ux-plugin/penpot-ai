import { describe, expect, it } from 'vitest'
import { parseSkslDiagnostics } from '../../../../src/lib/renderer/shader-lang/sksl'

/**
 * Inputs are the exact strings Skia's compiler returned (captured live), so
 * this pins the parser to the real format rather than an assumed one.
 */
describe('parseSkslDiagnostics', () => {
  it('extracts line, message, and the caret column + span', () => {
    const raw =
      "error: 2: unknown identifier 'oops'\n" +
      'half4 main(float2 p){ return oops; \n' +
      '                             ^^^^\n' +
      '1 error\n'
    expect(parseSkslDiagnostics(raw)).toEqual([
      {
        line: 2,
        severity: 'error',
        message: "unknown identifier 'oops'",
        column: 30, // 29 leading spaces + 1
        endColumn: 34, // + 4 carets
      },
    ])
  })

  it('parses every diagnostic in a multi-error block', () => {
    const raw =
      "error: 2: unknown identifier 'nope'\n" +
      'half4 main(float2 p){ return nope + alsonope; \n' +
      '                             ^^^^\n' +
      "error: 2: unknown identifier 'alsonope'\n" +
      'half4 main(float2 p){ return nope + alsonope; \n' +
      '                                    ^^^^^^^^\n' +
      '2 errors\n'
    const out = parseSkslDiagnostics(raw)
    expect(out).toHaveLength(2)
    expect(out[0].message).toBe("unknown identifier 'nope'")
    expect(out[1].message).toBe("unknown identifier 'alsonope'")
    // Second caret is further right and wider.
    expect(out[1].column!).toBeGreaterThan(out[0].column!)
    expect(out[1].endColumn! - out[1].column!).toBe(8) // "alsonope"
  })

  it('handles a diagnostic with no caret (no source context)', () => {
    const raw = "error: 1: expected a type, but found ''\n1 error\n"
    expect(parseSkslDiagnostics(raw)).toEqual([
      { line: 1, severity: 'error', message: "expected a type, but found ''" },
    ])
  })

  it('does not mistake a following error head for a caret line', () => {
    // Two headed errors back-to-back with no echo/caret between them.
    const raw = 'error: 3: first\nerror: 5: second\n2 errors\n'
    const out = parseSkslDiagnostics(raw)
    expect(out.map((d) => [d.line, d.column])).toEqual([
      [3, undefined],
      [5, undefined],
    ])
  })

  it('returns nothing for empty / non-diagnostic text', () => {
    expect(parseSkslDiagnostics('')).toEqual([])
    expect(parseSkslDiagnostics('just some text\nno errors here')).toEqual([])
  })
})
