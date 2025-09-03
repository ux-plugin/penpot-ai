/**
 * Resolves the backend URL from environment variables.
 * Throws an error if VITE_BACKEND_URL is not set.
 */
export function resolveBackendUrl(): string {
  const url = import.meta.env.VITE_BACKEND_URL as string | undefined
  if (!url) {
    throw new Error("VITE_BACKEND_URL is not set. Define it in your .env.development.local/.env.development.local.local file.")
  }
  // Ensure no trailing slash
  return url.replace(/\/+$/, "")
}
