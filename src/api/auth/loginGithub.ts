import { useQuery, UseQueryResult } from "@tanstack/react-query"
import { resolveBackendUrl } from './utils';

interface LoginResponse {
  readTokenJwt: string;
  loginUrl: string;
}

interface GetAccessTokenResponse {
  accessToken: string;
}

interface GetRefreshTokenResponse {
  refreshToken: string;
}

export interface GithubLoginAuthData {
  accessToken: string;
  refreshToken: string;
}

/**
 * Fetches the GitHub login info from `${VITE_BACKEND_URL}/auth/github/login`.
 */
export async function getGithubLogin(signal?: AbortSignal): Promise<GithubLoginAuthData> {
  const baseUrl = resolveBackendUrl()

  const initLoginResponse = await fetch(`${baseUrl}/auth/github/login`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  })

  if (!initLoginResponse.ok) {
    const text = await initLoginResponse.text().catch(() => "")
    throw new Error(`GitHub login request failed: ${initLoginResponse.status} ${text}`)
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
    throw new Error(`GitHub access token request failed: ${getAccessTokenResponse.status} ${text}`);
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
    throw new Error(`GitHub refresh token request failed: ${getRefreshTokenResponse.status} ${text}`);
  }

  const { refreshToken }: GetRefreshTokenResponse = await getRefreshTokenResponse.json();

  return { accessToken: accessToken, refreshToken: refreshToken };
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
  })
}