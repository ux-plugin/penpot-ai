// Single session id per page load — recorder posts under it, replay UI fetches it.
// Persisted in sessionStorage so a SPA navigation reuses the same id; cleared on
// new tab so each tab is its own recording.
const KEY = 'demo-session-id';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getSessionId(): string {
  const existing = sessionStorage.getItem(KEY);
  if (existing) return existing;
  const id = newId();
  sessionStorage.setItem(KEY, id);
  return id;
}
