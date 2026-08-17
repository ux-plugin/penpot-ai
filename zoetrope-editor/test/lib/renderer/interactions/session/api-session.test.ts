import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiSession } from '../../../../../src/lib/renderer/interactions/session/api-session'
import { emptyPageInteractions } from '../../../../../src/lib/renderer/interactions/ir'

/**
 * Integration test for the web/platform chat path: real ApiSession → aiChat → the
 * Vercel AI SDK (`streamText` over the OpenAI-compatible provider) → parseResult.
 * The ONLY stub is the network boundary — `fetch` returns a real OpenAI
 * `text/event-stream`, exactly what the backend facade emits — so the SDK's SSE
 * parsing, our envelope parsing, history, and the offline fallback are all exercised.
 */

/** Build the OpenAI SSE body the backend produces: role chunk, content deltas, stop, [DONE]. */
function sseResponse(contentChunks: string[]): Response {
  const enc = new TextEncoder()
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'cmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'platform',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(chunk({ role: 'assistant' })))
      for (const part of contentChunks) c.enqueue(enc.encode(chunk({ content: part })))
      c.enqueue(enc.encode(chunk({}, 'stop')))
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A minimal valid `{ reply, ir }` envelope, split into small chunks to exercise streaming reassembly. */
function envelopeChunks(): string[] {
  const ir = {
    version: 1,
    variables: [],
    derived: [],
    ports: [],
    interactions: [{ id: 'i1', on: { node: 'btn', trigger: { type: 'click' } }, do: [{ type: 'set', target: 'open', value: 'true' }] }],
    appRules: [],
    bindings: [],
    states: [],
    repeaters: [],
  }
  const envelope = JSON.stringify({ reply: 'Added a click handler', ir })
  return envelope.match(/.{1,12}/g) ?? [envelope]
}

describe('ApiSession (web/platform path)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('streams a reply + IR from the backend facade and records both turns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(envelopeChunks())))

    const session = new ApiSession()
    const res = await session.send({
      text: 'on click, open the menu',
      nodes: [{ id: 'btn', name: 'Button' }],
      ir: emptyPageInteractions(),
    })

    expect(res.offline).toBeFalsy()
    expect(res.reply).toBe('Added a click handler')
    expect(res.ir?.version).toBe(1)
    expect(res.ir?.interactions).toHaveLength(1)
    expect(session.history().map((t) => t.role)).toEqual(['user', 'assistant'])
  })

  it('falls back to the offline interpreter when the backend is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )

    const session = new ApiSession()
    const res = await session.send({ text: 'hello', nodes: [], ir: emptyPageInteractions() })

    expect(res.offline).toBe(true)
    expect(res.reply).toMatch(/offline/i)
    expect(session.history().map((t) => t.role)).toEqual(['user', 'assistant'])
  })
})
