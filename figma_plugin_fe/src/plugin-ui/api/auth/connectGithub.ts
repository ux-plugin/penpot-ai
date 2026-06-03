import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { apiJsonFetch } from "@/plugin-ui/api/api-fetcher.ts"; // Import apiJsonFetch

interface ConnectResponse {
  readToken: string;
  loginUrl: string;
}

interface ConnectResultResponse {
  result: string;
}

/**
 * Fetches the GitHub login info from `${VITE_BACKEND_URL}/auth/github/login`.
 */
export async function githubConnect(signal?: AbortSignal): Promise<boolean> {
  try {
    const initLoginResponse = await apiJsonFetch<ConnectResponse>(
      "/auth/github/connect/init",
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      },
      true
    );

    window.open(initLoginResponse.loginUrl, "_blank");

    await apiJsonFetch<ConnectResultResponse>(
      "/auth/github/connect/result",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${initLoginResponse.readToken}`, // Use the temporary token
        },
        signal,
      },
      true
    );

    return true;
  } catch (error) {
    console.error('[GitHub Connect] Connection flow failed:', error);
    throw error;
  }
}

/**
 * React Query hook to retrieve the GitHub login info.
 * By default the query is disabled (manual trigger). Pass { enabled: true } to fetch automatically.
 */
export function useGitHubConnect(opts?: { enabled?: boolean }): UseQueryResult<boolean, Error> {
  return useQuery({
    queryKey: ["github-login", import.meta.env.VITE_BACKEND_URL],
    queryFn: ({ signal }) => githubConnect(signal),
    staleTime: 5 * 60 * 1000,
    enabled: opts?.enabled ?? false,
    retry: false,
  });
}
