/**
 * route — what the URL says is on screen.
 *
 * Two patterns is not worth a router dependency, and a signal is what this app
 * already uses for state that crosses the React boundary (see
 * ../renderer/signals/editor-mode.ts). The boot effect in App.tsx reads this from
 * an effect; the documents screen writes it from a click.
 *
 *   /            documents home
 *   /d/<docId>   that document
 *
 * The grammar deliberately stops at the document. Page and selection are ordinary
 * in-memory state — a later `/p/<pageId>` segment or `?node=` param is additive
 * and would not break a link written today.
 *
 * Real paths rather than a hash: Vite dev serves index.html for unknown paths, and
 * the Electron shell's `app://` handler resolves extension-less paths to
 * index.html too (zoetrope-desktop-app/src/main/index.ts).
 */

import { signal } from '@preact/signals-core'

export type Route = { kind: 'home' } | { kind: 'doc'; id: string }

const HOME: Route = { kind: 'home' }

/** Parse a pathname into a route. Anything unrecognised is home — a bad URL
 *  should land somewhere usable, not blank. */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 2 && segments[0] === 'd') {
    const id = safeDecode(segments[1]!)
    if (id) return { kind: 'doc', id }
  }
  return HOME
}

/** `decodeURIComponent` throws on a malformed escape (`/d/%`), which would take
 *  down the whole boot. A malformed id is just an unknown route. */
function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw) || null
  } catch {
    return null
  }
}

export function routeToPath(route: Route): string {
  return route.kind === 'doc' ? `/d/${encodeURIComponent(route.id)}` : '/'
}

export function routesEqual(a: Route, b: Route): boolean {
  return a.kind === 'doc' && b.kind === 'doc' ? a.id === b.id : a.kind === b.kind
}

/** Current route. Initialised from the URL so a reload or a pasted link lands in
 *  the right place with no redirect flash. */
export const route = signal<Route>(
  typeof window === 'undefined' ? HOME : parseRoute(window.location.pathname),
)

/** A message for the documents screen to show after an involuntary redirect —
 *  a link to a document that no longer exists. Cleared once shown. */
export const routeNotice = signal<string | null>(null)

export interface NavigateOptions {
  /** Replace instead of pushing. Use for corrections (a dead link), so Back
   *  doesn't bounce the user straight back into the broken URL. */
  replace?: boolean
  notice?: string | null
}

export function navigate(next: Route, options: NavigateOptions = {}): void {
  const { replace = false, notice = null } = options
  routeNotice.value = notice

  if (routesEqual(route.peek(), next)) return
  route.value = next

  if (typeof window === 'undefined') return
  const path = routeToPath(next)
  if (replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
}

/** Keep the signal in step with Back/Forward. Returns a disposer. */
export function startRouting(): () => void {
  if (typeof window === 'undefined') return () => {}
  const onPopState = () => {
    routeNotice.value = null
    route.value = parseRoute(window.location.pathname)
  }
  window.addEventListener('popstate', onPopState)
  return () => window.removeEventListener('popstate', onPopState)
}
