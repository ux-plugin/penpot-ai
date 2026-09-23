/** Content hashes: SHA-256, lowercase hex. */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  let out = ''
  for (const b of digest) out += HEX[b]
  return out
}

const encoder = new TextEncoder()

export function sha256Text(text: string): Promise<string> {
  return sha256(encoder.encode(text))
}
