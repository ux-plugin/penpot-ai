/**
 * Build-time configuration baked into the bundle.
 *
 * Values come from Vite's env files (`.env`, `.env.development`,
 * `.env.production`, …) via `import.meta.env`, so they're replaced with
 * literals at build time and cost nothing at runtime.
 */

/**
 * Base URL of a backend/proxy that serves font files, read from the
 * `VITE_FONT_BACKEND_URL` env var (see `.env.development` / `.env.production`).
 *
 * When set, font requests are routed through this origin instead of the public
 * font CDN — the same model Penpot uses for its `internal/gfonts` proxy, so the
 * browser never fetches fonts from a third-party CDN directly. Empty/unset means
 * "fetch fonts directly from the public CDN".
 *
 * - dev: `.env.development` points it at the public Google Fonts CDN.
 * - prod: `.env.production` (or a `VITE_FONT_BACKEND_URL=… npm run build`
 *   override) points it at the self-hosted proxy; empty falls back to the CDN.
 *
 * Trailing slashes are stripped so callers can join paths with a leading `/`.
 */
const raw = import.meta.env.VITE_FONT_BACKEND_URL as string | undefined
export const FONT_BACKEND_URL: string =
  typeof raw === 'string' ? raw.replace(/\/+$/, '') : ''
