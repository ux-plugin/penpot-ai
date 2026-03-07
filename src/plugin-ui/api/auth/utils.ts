/**
 * Resolves the backend URL from environment variables.
 * Returns undefined when VITE_BACKEND_URL is not set (plugin remains loadable).
 */
export function resolveBackendUrl(): string | undefined {
  const url = import.meta.env.VITE_BACKEND_URL as string | undefined
  if (!url || typeof url !== 'string') return undefined
  // Ensure no trailing slash
  return url.replace(/\/+$/, '')
}
