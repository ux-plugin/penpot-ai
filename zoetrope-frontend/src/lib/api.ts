import { useAuth0 } from "@auth0/auth0-react";
import { useCallback, useMemo } from "react";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8080";

export type OrgRole = "OWNER" | "ADMIN" | "MEMBER";

export type Organization = {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
  createdAt: string;
};

export type ApiKeyRecord = {
  id: string;
  orgId: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type CreatedApiKey = ApiKeyRecord & { plaintext: string };

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let detail = res.statusText;
  try {
    const body = await res.text();
    if (body) detail = body;
  } catch {
    // ignore
  }
  return new ApiError(res.status, `${res.status} ${detail}`);
}

export function useApi() {
  const { getAccessTokenSilently, isAuthenticated } = useAuth0();

  const authedFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const token = await getAccessTokenSilently();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
    },
    [getAccessTokenSilently],
  );

  return useMemo(
    () => ({
      isAuthenticated,

      async listOrganizations(): Promise<Organization[]> {
        const res = await authedFetch("/api/orgs");
        if (!res.ok) throw await parseError(res);
        const body = (await res.json()) as { organizations: Organization[] };
        return body.organizations;
      },

      async createOrganization(req: { name: string; slug?: string }): Promise<Organization> {
        const res = await authedFetch("/api/orgs", {
          method: "POST",
          body: JSON.stringify(req),
        });
        if (!res.ok) throw await parseError(res);
        return (await res.json()) as Organization;
      },

      async deleteOrganization(orgId: string): Promise<void> {
        const res = await authedFetch(`/api/orgs/${encodeURIComponent(orgId)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw await parseError(res);
      },

      async listApiKeys(orgId: string): Promise<ApiKeyRecord[]> {
        const res = await authedFetch(`/api/api-keys?orgId=${encodeURIComponent(orgId)}`);
        if (!res.ok) throw await parseError(res);
        const body = (await res.json()) as { apiKeys: ApiKeyRecord[] };
        return body.apiKeys;
      },

      async createApiKey(orgId: string, name: string): Promise<CreatedApiKey> {
        const res = await authedFetch("/api/api-keys", {
          method: "POST",
          body: JSON.stringify({ orgId, name }),
        });
        if (!res.ok) throw await parseError(res);
        return (await res.json()) as CreatedApiKey;
      },

      async revokeApiKey(id: string): Promise<void> {
        const res = await authedFetch(`/api/api-keys/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!res.ok && res.status !== 304) throw await parseError(res);
      },
    }),
    [authedFetch, isAuthenticated],
  );
}
