import { useAuthenticationStore } from "@/plugin-ui/stores/useAuthenticationStore.ts";
import { resolveBackendUrl } from "@/plugin-ui/api/auth/utils.ts";

let isRefreshing = false;
let failedQueue: { resolve: (value?: any) => void; reject: (reason?: any) => void; }[] = [];

const processQueue = (error: Error | null = null) => {
  failedQueue.forEach(promise => {
    if (error) {
      promise.reject(error);
    } else {
      promise.resolve();
    }
  });
  failedQueue = [];
};

export async function apiFetch(
  endpoint: string,
  options?: RequestInit,
  includeAuth: boolean = true
): Promise<Response> {
  const baseUrl = resolveBackendUrl();
  if (!baseUrl) {
    throw new Error('Backend not configured. Set VITE_BACKEND_URL in your .env file.');
  }
  const authStore = useAuthenticationStore.getState();
  const url = `${baseUrl}${endpoint}`;

  let headers: HeadersInit = {
    "Content-Type": "application/json",
    ...options?.headers
  };

  if (includeAuth && authStore.accessToken) {
    headers = {
      ...headers,
      Authorization: `Bearer ${authStore.accessToken}`,
    };
  }

  try {
    let response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
      if (isRefreshing) {
        return new Promise<Response>((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(() => {
          // Retry the original request with the new token
          return apiFetch(endpoint, options, includeAuth);
        });
      }

      isRefreshing = true;

      const refreshToken = authStore.refreshToken;
      const userId = authStore.userId;
      if (!refreshToken) {
        authStore.logout();
        isRefreshing = false;
        processQueue(new Error("No refresh token available. User unauthenticated."));
        return Promise.reject(new Error("No refresh token available. User unauthenticated."));
      }

      try {
        const refreshResponse = await fetch(`${baseUrl}/auth/plugin-ui/access-token/refresh`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ refreshToken: refreshToken, userId: userId }),
        });

        if (!refreshResponse.ok) {
          throw new Error("Failed to refresh token");
        }

        const data = await refreshResponse.json();
        authStore.setAccessToken(data.accessToken);
        authStore.setRefreshToken(data.refreshToken, null);

        isRefreshing = false;
        processQueue(null);

        // Retry the original request with the new token
        headers = {
          ...headers,
          Authorization: `Bearer ${authStore.accessToken}`,
        };
        response = await fetch(url, { ...options, headers });

      } catch (refreshError) {
        isRefreshing = false;
        processQueue(refreshError as Error);
        authStore.logout();
        return Promise.reject(refreshError);
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || "API request failed");
    }

    return response;
  } catch (error) {
    console.error("API fetch error:", error);
    throw error;
  }
}

export async function apiJsonFetch<T>(
  endpoint: string,
  options?: RequestInit,
  includeAuth: boolean = true
): Promise<T> {
  const response = await apiFetch(endpoint, options, includeAuth);
  return response.json() as Promise<T>;
}
