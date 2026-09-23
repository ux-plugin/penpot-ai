/**
 * Canonical bytes: JSON with object keys sorted, UTF-8. The same value always
 * encodes to the same bytes, so its hash names its content.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortKeys(x)
    }
    return out
  }
  return v
}

/** Canonical JSON text. `undefined` fields are dropped. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v))
}

export function encode(v: unknown): Uint8Array {
  return encoder.encode(canonicalJson(v))
}

export function decode<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T
}
