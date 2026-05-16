// Auth0 SPA configuration. Values come from Vite env vars (see .env.example).
// The audience must match the figma_plugin_api backend (AUTH0_AUDIENCE) so
// access tokens this SPA mints are accepted as bearers.

export const auth0Config = {
  domain: import.meta.env.VITE_AUTH0_DOMAIN as string | undefined,
  clientId: import.meta.env.VITE_AUTH0_CLIENT_ID as string | undefined,
  audience: import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined,
};

export function isAuth0Configured(): boolean {
  return Boolean(auth0Config.domain && auth0Config.clientId);
}
