/**
 * Host-surface capability probes.
 *
 * The web build runs in a plain browser, which has no secure secret storage — so
 * BYOK (the user supplying their own provider key) is offered ONLY on surfaces
 * that expose an OS-backed key store: the desktop shell (Electron `safeStorage`,
 * surfaced on `window.zoetrope.keyStore`) and the terminal. Everything keyed off
 * `hasSecureKeyStore()` stays disabled on the web.
 */

interface ZoetropeBridge {
  keyStore?: unknown
}

/** True when a secure (OS-backed) key store is available — desktop/terminal, not a browser. */
export function hasSecureKeyStore(): boolean {
  if (typeof window === 'undefined') return false
  const bridge = (window as unknown as { zoetrope?: ZoetropeBridge }).zoetrope
  return !!bridge?.keyStore
}
