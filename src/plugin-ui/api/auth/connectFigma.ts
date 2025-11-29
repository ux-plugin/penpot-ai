import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { apiJsonFetch } from "@/plugin-ui/api/api-fetcher.ts";

interface ConnectResponse {
  readToken: string;
  loginUrl: string;
}

interface ConnectResultResponse {
  result: string;
}

/**
 * Initiates the Figma connect flow and waits for the result.
 */
export async function figmaConnect(signal?: AbortSignal): Promise<boolean> {
  try {
    const initLoginResponse = await apiJsonFetch<ConnectResponse>(
      "/auth/figma/connect/init",
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      },
      true
    );

    // Open Figma OAuth/login flow in a new tab
    window.open(initLoginResponse.loginUrl, "_blank");

    // Wait for backend to confirm the connect result using the temporary read token
    await apiJsonFetch<ConnectResultResponse>(
      "/auth/figma/connect/result",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${initLoginResponse.readToken}`,
        },
        signal,
      },
      true
    );

    return true;
  } catch (error) {
    console.error('[Figma Connect] Connection flow failed:', error);
    throw error;
  }
}

/**
 * React Query hook to trigger Figma connect.
 * Query is disabled by default so it can be triggered manually.
 */
export function useFigmaConnect(opts?: { enabled?: boolean }): UseQueryResult<boolean, Error> {
  return useQuery({
    queryKey: ["figma-connect", import.meta.env.VITE_BACKEND_URL],
    queryFn: ({ signal }) => figmaConnect(signal),
    staleTime: 5 * 60 * 1000,
    enabled: opts?.enabled ?? false,
    retry: false,
  });
}
