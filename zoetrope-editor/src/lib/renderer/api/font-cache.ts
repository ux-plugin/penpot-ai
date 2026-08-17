/**
 * Disk-backed, offline-first font fetching.
 *
 * Font `.ttf` bytes are fetched once and kept in the Cache Storage API
 * (`skia-fonts-v1`). Cache Storage is on-disk origin storage (NOT in-memory), so a
 * font used once renders offline across app restarts.
 *
 * On desktop (Electron) the storage lives in the app profile; we also request
 * persistent storage so it's never evicted under disk pressure (the desktop main
 * process auto-grants the `persistent-storage` permission). On the web this gives
 * the same PWA-style offline behaviour, best-effort.
 *
 * Falls back to a plain `fetch` when the Cache API is unavailable (e.g. a
 * non-secure context).
 */

const CACHE_NAME = 'skia-fonts-v1'

let persistRequested = false

/** Ask the platform to keep our storage on disk. Idempotent, best-effort. */
async function ensurePersistentStorage(): Promise<void> {
  if (persistRequested) return
  persistRequested = true
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
    if (storage?.persist) {
      const already = (await storage.persisted?.()) ?? false
      if (!already) await storage.persist()
    }
  } catch {
    // Caching still works without a persistence guarantee.
  }
}

/** True when the Cache Storage API is usable (requires a secure context). */
function cacheAvailable(): boolean {
  return typeof caches !== 'undefined'
}

/**
 * Cache-first fetch for font files. Returns a cached `Response` when present,
 * otherwise fetches, stores a successful response on disk, and returns it. Throws
 * (like `fetch`) when offline with no cached copy — the caller surfaces that as a
 * substituted / missing font.
 */
export async function cachedFontFetch(url: string): Promise<Response> {
  if (!cacheAvailable()) return fetch(url)

  void ensurePersistentStorage()

  const cache = await caches.open(CACHE_NAME)
  const hit = await cache.match(url)
  if (hit) return hit

  const res = await fetch(url)
  // Clone before the body is consumed by the caller; only cache real responses.
  if (res.ok) await cache.put(url, res.clone())
  return res
}
