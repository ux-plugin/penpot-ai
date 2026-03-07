import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { resolveBackendUrl } from "./utils.ts";

interface LoginResponse {
  readTokenJwt: string;
  loginUrl: string;
}

interface GetAccessTokenResponse {
  accessToken: string;
}

interface GetRefreshTokenResponse {
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

export interface FigmaLoginAuthData {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

/**
 * Fetches the Figma login info from `${VITE_BACKEND_URL}/auth/figma/login`.
 */
export async function getFigmaLogin(signal?: AbortSignal): Promise<FigmaLoginAuthData> {
  try {
    const baseUrl = resolveBackendUrl();
    if (!baseUrl) {
      throw new Error('Backend not configured. Set VITE_BACKEND_URL in your .env file.');
    }

    const initLoginResponse = await fetch(`${baseUrl}/auth/figma/login`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    })

    if (!initLoginResponse.ok) {
      const text = await initLoginResponse.text().catch(() => "")
      const error = new Error(`Figma login request failed: ${initLoginResponse.status} ${text}`)
      console.error('[Figma Login] Initial login request failed:', {
        status: initLoginResponse.status,
        statusText: initLoginResponse.statusText,
        responseText: text,
        error
      })
      throw error
    }

    const loginResponse: LoginResponse = await initLoginResponse.json();

    window.open(loginResponse.loginUrl, "_blank");

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
      const error = new Error(`Figma access token request failed: ${getAccessTokenResponse.status} ${text}`);
      console.error('[Figma Login] Access token request failed:', {
        status: getAccessTokenResponse.status,
        statusText: getAccessTokenResponse.statusText,
        responseText: text,
        error
      })
      throw error;
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

    if (!getRefreshTokenResponse.ok) {
      const text = await getRefreshTokenResponse.text().catch(() => "");
      const error = new Error(`Figma refresh token request failed: ${getRefreshTokenResponse.status} ${text}`);
      console.error('[Figma Login] Refresh token request failed:', {
        status: getRefreshTokenResponse.status,
        statusText: getRefreshTokenResponse.statusText,
        responseText: text,
        error
      })
      throw error;
    }

    const { refreshToken, refreshTokenExpiresAt }: GetRefreshTokenResponse = await getRefreshTokenResponse.json();

    return {accessToken: accessToken, refreshToken: refreshToken, refreshTokenExpiresAt: new Date(refreshTokenExpiresAt).getTime()};
  } catch (error) {
    console.error('[Figma Login] Authentication flow failed:', error);
    throw error;
  }
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
    retry: false, // Don't retry on failure to prevent multiple redirections
  })
}
