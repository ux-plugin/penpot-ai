import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiSession } from '../../../../../src/lib/renderer/interactions/session/api-session'
import { EMPTY_BEHAVIOUR } from '../../../../../src/lib/renderer/interactions/ir'

/**
 * Integration test for the web/platform chat path: real ApiSession → aiChat → the
 * Vercel AI SDK (`streamText` over the OpenAI-compatible provider) → parseResult.
 * The ONLY stub is the network boundary — `fetch` returns a real OpenAI
 * `text/event-stream`, exactly what the backend facade emits — so the SDK's SSE
 * parsing, our envelope parsing, history, and the unreachable-backend reply are all exercised.
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

/** A minimal valid `{ reply, behaviour }` envelope, split into small chunks to exercise streaming reassembly. */
function envelopeChunks(): string[] {
  const behaviour = {
    cells: [{ name: 'open', type: 'boolean', initial: false }],
    bindings: [],
    rules: [{ id: 'i1', node: 'btn', on: { type: 'click' }, do: [{ type: 'set-variable', target: 'open', value: 'true' }] }],
  }
  const envelope = JSON.stringify({ reply: 'Added a click handler', behaviour })
  return envelope.match(/.{1,12}/g) ?? [envelope]
}

describe('ApiSession (web/platform path)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('streams a reply + behaviour from the backend facade and records both turns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(envelopeChunks())))

    const session = new ApiSession()
    const res = await session.send({
      text: 'on click, open the menu',
      nodes: [{ id: 'btn', name: 'Button' }],
      page: 'page-1',
      behaviour: EMPTY_BEHAVIOUR,
    })

    expect(res.offline).toBeFalsy()
    expect(res.reply).toBe('Added a click handler')
    expect(res.behaviour?.rules).toHaveLength(1)
    const open = res.behaviour?.cells.find((c) => c.name === 'open')
    expect(res.behaviour?.rules[0]).toMatchObject({
      id: 'i1',
      page: 'page-1',
      node: 'btn',
      on: { type: 'click' },
      do: [{ type: 'set-variable', target: { kind: 'cell', cell: open?.id } }],
    })
    expect(session.history().map((t) => t.role)).toEqual(['user', 'assistant'])
  })

  it('says the backend is not reachable, with no behaviour, when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )

    const session = new ApiSession()
    const res = await session.send({ text: 'hello', nodes: [], page: 'page-1', behaviour: EMPTY_BEHAVIOUR })

    expect(res.offline).toBe(true)
    expect(res.reply).toBe('The AI backend is not reachable.')
    expect(res.behaviour).toBeUndefined()
    expect(session.history().map((t) => t.role)).toEqual(['user', 'assistant'])
  })
})
