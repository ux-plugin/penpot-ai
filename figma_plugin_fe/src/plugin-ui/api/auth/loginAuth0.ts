import { useQuery, UseQueryResult } from "@tanstack/react-query"
import { resolveBackendUrl } from "./utils.ts"

interface LoginInitResponse {
  readToken: string;
  loginUrl: string;
}

interface PluginTokensResponse {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface Auth0LoginAuthData {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

/**
 * Drives the Auth0 login flow against the backend.
 * 1. GET /auth/auth0/login → { readToken, loginUrl }
 * 2. Open Auth0 hosted login in a popup; user picks GitHub/Figma/etc.
 * 3. GET /auth/auth0/access-token?readToken=... (long-poll) → Auth0 tokens once the popup completes.
 * Tokens returned are issued by Auth0 directly; the backend just relays them.
 */
export async function getAuth0Login(signal?: AbortSignal): Promise<Auth0LoginAuthData> {
  const baseUrl = resolveBackendUrl();
  if (!baseUrl) {
    throw new Error("Backend not configured. Set VITE_BACKEND_URL in your .env file.");
  }

  const initResponse = await fetch(`${baseUrl}/auth/auth0/login`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!initResponse.ok) {
    const text = await initResponse.text().catch(() => "");
    throw new Error(`Auth0 login init failed: ${initResponse.status} ${text}`);
  }

  const { readToken, loginUrl }: LoginInitResponse = await initResponse.json();

  window.open(loginUrl, "_blank");

  const tokensUrl = new URL(`${baseUrl}/auth/auth0/access-token`);
  tokensUrl.searchParams.set("readToken", readToken);

  const tokensResponse = await fetch(tokensUrl.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!tokensResponse.ok) {
    const text = await tokensResponse.text().catch(() => "");
    throw new Error(`Auth0 token retrieval failed: ${tokensResponse.status} ${text}`);
  }

  const tokens: PluginTokensResponse = await tokensResponse.json();

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: new Date(tokens.refreshTokenExpiresAt).getTime(),
  };
}

export function useAuth0LoginQuery(opts?: { enabled?: boolean }): UseQueryResult<Auth0LoginAuthData, Error> {
  return useQuery({
    queryKey: ["auth0-login", import.meta.env.VITE_BACKEND_URL],
    queryFn: ({ signal }) => getAuth0Login(signal),
    staleTime: 5 * 60 * 1000,
    enabled: opts?.enabled ?? false,
    retry: false,
  });
}
