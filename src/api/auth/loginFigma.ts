import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { resolveBackendUrl } from "@/api/auth/utils.ts";
import { open } from '@tauri-apps/plugin-shell';

interface LoginResponse {
  readTokenJwt: string;
  loginUrl: string;
}

interface GetAccessTokenResponse {
  accessToken: string;
}

interface GetRefreshTokenResponse {
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface FigmaLoginAuthData {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/**
 * Fetches the Figma login info from `${VITE_BACKEND_URL}/auth/figma/login`.
 */
export async function getFigmaLogin(signal?: AbortSignal): Promise<FigmaLoginAuthData> {
  const baseUrl = resolveBackendUrl()

  const initLoginResponse = await fetch(`${baseUrl}/auth/figma/login`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  })

  if (!initLoginResponse.ok) {
    const text = await initLoginResponse.text().catch(() => "")
    throw new Error(`Figma login request failed: ${initLoginResponse.status} ${text}`)
  }

  const loginResponse: LoginResponse = await initLoginResponse.json();

  open(loginResponse.loginUrl);

  const getAccessTokenResponse = await fetch(`${baseUrl}/auth/figma/access-token`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${loginResponse.readTokenJwt}`
    },
    signal,
  });

  if (!getAccessTokenResponse.ok) {
    const text = await getAccessTokenResponse.text().catch(() => "");
    throw new Error(`Figma access token request failed: ${getAccessTokenResponse.status} ${text}`);
  }

  const { accessToken }: GetAccessTokenResponse = await getAccessTokenResponse.json();

  const getRefreshTokenResponse = await fetch(`${baseUrl}/auth/plugin-ui/refresh-token`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    signal,
  })

  const { refreshToken, refreshTokenExpiresAt }: GetRefreshTokenResponse = await getRefreshTokenResponse.json();

  return {accessToken: accessToken, refreshToken: refreshToken, refreshTokenExpiresAt: refreshTokenExpiresAt};
}

/**
 * React Query hook to retrieve the Figma login info.
 * By default the query is disabled (manual trigger). Pass { enabled: true } to fetch automatically.
 */
export function useFigmaLoginQuery(opts?: { enabled?: boolean }): UseQueryResult<FigmaLoginAuthData, Error> {
  return useQuery({
    queryKey: ["figma-login", import.meta.env.VITE_BACKEND_URL],
    queryFn: ({ signal }) => getFigmaLogin(signal),
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: opts?.enabled ?? false, // default disabled so it can be triggered manually
  })
}
