import { useQuery, UseQueryResult } from "@tanstack/react-query"
import { resolveBackendUrl } from './utils.ts';

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

export interface GithubLoginAuthData {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

/**
 * Fetches the GitHub login info from `${VITE_BACKEND_URL}/auth/github/login`.
 */
export async function getGithubLogin(signal?: AbortSignal): Promise<GithubLoginAuthData> {
  try {
    const baseUrl = resolveBackendUrl();
    if (!baseUrl) {
      throw new Error('Backend not configured. Set VITE_BACKEND_URL in your .env file.');
    }

    const initLoginResponse = await fetch(`${baseUrl}/auth/github/login`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    })

    if (!initLoginResponse.ok) {
      const text = await initLoginResponse.text().catch(() => "")
      const error = new Error(`GitHub login request failed: ${initLoginResponse.status} ${text}`)
      console.error('[GitHub Login] Initial login request failed:', {
        status: initLoginResponse.status,
        statusText: initLoginResponse.statusText,
        responseText: text,
        error
      })
      throw error
    }

    const loginResponse: LoginResponse = await initLoginResponse.json();

    window.open(loginResponse.loginUrl, "_blank");

    const getAccessTokenResponse = await fetch(`${baseUrl}/auth/github/access-token`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${loginResponse.readTokenJwt}`
      },
      signal,
    });

    if (!getAccessTokenResponse.ok) {
      const text = await getAccessTokenResponse.text().catch(() => "");
      const error = new Error(`GitHub access token request failed: ${getAccessTokenResponse.status} ${text}`);
      console.error('[GitHub Login] Access token request failed:', {
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
      const error = new Error(`GitHub refresh token request failed: ${getRefreshTokenResponse.status} ${text}`);
      console.error('[GitHub Login] Refresh token request failed:', {
        status: getRefreshTokenResponse.status,
        statusText: getRefreshTokenResponse.statusText,
        responseText: text,
        error
      })
      throw error;
    }

    const { refreshToken, refreshTokenExpiresAt }: GetRefreshTokenResponse = await getRefreshTokenResponse.json();

    return { accessToken: accessToken, refreshToken: refreshToken, refreshTokenExpiresAt: new Date(refreshTokenExpiresAt).getTime() };
  } catch (error) {
    console.error('[GitHub Login] Authentication flow failed:', error);
    throw error;
  }
}

/**
 * React Query hook to retrieve the GitHub login info.
 * By default the query is disabled (manual trigger). Pass { enabled: true } to fetch automatically.
 */
export function useGithubLoginQuery(opts?: { enabled?: boolean }): UseQueryResult<GithubLoginAuthData, Error> {
  return useQuery({
    queryKey: ["github-login", import.meta.env.VITE_BACKEND_URL],
    queryFn: ({ signal }) => getGithubLogin(signal),
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: opts?.enabled ?? false, // default disabled so it can be triggered manually
    retry: false, // Don't retry on failure to prevent multiple redirections
  })
}
