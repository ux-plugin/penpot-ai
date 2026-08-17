import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedFontFetch } from '@/lib/renderer/api/font-cache'

/** Minimal in-memory Cache + CacheStorage stand-ins (the node test env has neither). */
function installFakeCaches() {
  const store = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (url: string) => store.get(url)),
    put: vi.fn(async (url: string, res: Response) => {
      store.set(url, res)
    }),
  }
  const caches = { open: vi.fn(async () => cache) }
  ;(globalThis as unknown as { caches: unknown }).caches = caches
  return { store, cache, caches }
}

const FONT_URL = 'https://fonts.gstatic.com/s/roboto/v1/roboto.ttf'

describe('cachedFontFetch', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { navigator: unknown }).navigator = {
      storage: { persist: vi.fn(async () => true), persisted: vi.fn(async () => true) },
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (globalThis as unknown as { caches?: unknown }).caches
  })

  it('fetches and stores a successful response, then serves it from disk', async () => {
    const { cache } = installFakeCaches()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await cachedFontFetch(FONT_URL)
    expect(first.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cache.put).toHaveBeenCalledTimes(1)

    const second = await cachedFontFetch(FONT_URL)
    expect(second.ok).toBe(true)
    // Served from cache — no second network call.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed response', async () => {
    const { cache } = installFakeCaches()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })))

    const res = await cachedFontFetch(FONT_URL)
    expect(res.ok).toBe(false)
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('falls back to a plain fetch when the Cache API is unavailable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('x', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await cachedFontFetch(FONT_URL)
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
