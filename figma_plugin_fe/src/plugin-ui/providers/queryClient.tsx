import { QueryCache, QueryClient } from "@tanstack/react-query";
import { useAuthenticationStore } from "@stores/useAuthenticationStore.ts";
import { showErrorToast } from "@utils/showErrorToast.ts";

// Define a custom error class to carry the status code
export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      // Check if the error is an instance of FetchError and if its status is 401
      if (error instanceof AuthError && error.status === 401) {
        console.log('401 Unauthorized error detected. Logging out...');
        // Call the logout function from your authentication store
        useAuthenticationStore.getState().logout();
      } else {
        // Route other errors through Sonner toast
        showErrorToast(error);
      }
    },
  }),
});
