import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "@/api/api-fetcher.ts";

export interface UserConfig {
  id: string;
  name?: string;
  username?: string;
  allowSavingCompletions: boolean;
}

/**
 * Fetches the current user's configuration.
 */
export async function fetchUserConfig(signal?: AbortSignal): Promise<UserConfig> {
  return apiFetch<UserConfig>("/user/info", { method: "GET", signal });
}

/**
 * React Query hook to retrieve the current user's configuration.
 */
export function useUserConfigQuery(opts?: { enabled?: boolean }): UseQueryResult<UserConfig, Error> {
  return useQuery({
    queryKey: ["user-config"],
    queryFn: ({ signal }) => fetchUserConfig(signal),
    enabled: opts?.enabled ?? false,
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });
}
