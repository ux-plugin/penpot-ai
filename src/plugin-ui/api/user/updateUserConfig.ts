import { useMutation, UseMutationResult, useQueryClient } from "@tanstack/react-query";
import { apiJsonFetch } from "@/plugin-ui/api/api-fetcher.ts";

export interface UpdateUserRequest {
  name?: string;
  username?: string;
  allowSavingCompletions?: boolean;
}

/**
 * Updates the current user's configuration.
 */
export async function updateUserConfig(
  updateData: UpdateUserRequest,
  signal?: AbortSignal
): Promise<void> {
  // apiJsonFetch automatically includes the Authorization header if an accessToken is present
  await apiJsonFetch<void>("/user/update", {
    method: "POST",
    signal,
    body: JSON.stringify(updateData)
  });
}

/**
 * React Query mutation hook to update the current user's configuration.
 */
export function useUpdateUserConfigMutation(): UseMutationResult<
  void,
  Error,
  UpdateUserRequest
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (updateData: UpdateUserRequest) => updateUserConfig(updateData),
    onSuccess: () => {
      // Invalidate and refetch the user config query after successful update
      queryClient.invalidateQueries({ queryKey: ["user-config"] });
    }
  });
}
