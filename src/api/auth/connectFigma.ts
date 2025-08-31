import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "@/api/auth/api-fetcher"; // Import apiFetch

interface ConnectResponse {
  readTokenJwt: string;
  loginUrl: string;
}

interface ConnectResultResponse {
  result: string;
}

/**
 * Fetches the Figma login info.
 */
export async function figmaConnect(signal?: AbortSignal): Promise<boolean> {

  const initLoginResponse = await apiFetch<ConnectResponse>(
    "/auth/figma/connect/init",
    {
      method: "GET",
      headers: { Accept: "application/json"},
      signal,
    },
    true
  );

  window.open(initLoginResponse.loginUrl, "_blank");

  await apiFetch<ConnectResultResponse>(
    "/auth/figma/connect/result",
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${initLoginResponse.readTokenJwt}`,
      },
      signal,
    },
    true
  );

  return true;
}

/**
 * React Query hook to retrieve the Figma login info.
 * By default the query is disabled (manual trigger). Pass { enabled: true } to fetch automatically.
 */
export function useFigmaConnect(opts?: { enabled?: boolean }): UseQueryResult<boolean, Error> {
  return useQuery({
    queryKey: ["figma-login", import.meta.env.VITE_BACKEND_URL],
    queryFn: ({ signal }) => figmaConnect(signal),
    staleTime: 5 * 60 * 1000,
    enabled: opts?.enabled ?? false,
  });
}