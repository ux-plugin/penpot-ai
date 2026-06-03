const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const KEY = (import.meta.env.VITE_DEV_API_KEY as string | undefined) ?? '';

function authHeader(): HeadersInit {
  if (!KEY) {
    console.warn('[api] VITE_DEV_API_KEY is not set; requests will 401');
    return {};
  }
  return { Authorization: `Bearer ${KEY}` };
}

export async function postChunk(sessionId: string, chunkSeq: number, body: Uint8Array): Promise<void> {
  // Body is gzipped NDJSON. The api validates content-length and content-type.
  const res = await fetch(`${BASE}/ingest/sessions/${sessionId}/chunks/${chunkSeq}`, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': 'application/gzip',
      'Content-Length': String(body.byteLength),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`ingest chunk ${chunkSeq} failed: ${res.status} ${await res.text()}`);
  }
}

export function postClose(sessionId: string): void {
  const url = `${BASE}/ingest/sessions/${sessionId}/close`;
  // sendBeacon is fire-and-forget on unload; can't set Authorization header, so
  // fall back to fetch with keepalive when an API key is required.
  const data = new Blob([], { type: 'text/plain' });
  if (!KEY && navigator.sendBeacon?.(url, data)) return;
  fetch(url, { method: 'POST', headers: authHeader(), keepalive: true }).catch(() => {});
}

export interface SessionSummary {
  sessionId: string;
  orgId: string;
  chunkCount: number;
  eventCount: number;
  durationMs: number;
  pageTransitions: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  processedAt: string;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch(`${BASE}/api/replay/sessions`, { headers: authHeader() });
  if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
  const json = (await res.json()) as { sessions: SessionSummary[] };
  return json.sessions;
}

export interface ReplayPayload {
  sessionId: string;
  eventCount: number;
  // rrweb event shape — left untyped here because rrweb-player accepts any[].
  events: unknown[];
}

export async function fetchReplay(sessionId: string): Promise<ReplayPayload> {
  const res = await fetch(`${BASE}/api/replay/sessions/${sessionId}/events`, {
    headers: authHeader(),
  });
  if (!res.ok) throw new Error(`replay fetch failed: ${res.status}`);
  return (await res.json()) as ReplayPayload;
}
