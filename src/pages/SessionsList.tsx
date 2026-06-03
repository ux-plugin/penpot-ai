import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listSessions, SessionSummary } from '../lib/api';
import { getSessionId } from '../lib/session-id';
import { finalizeCurrentSession } from '../lib/recorder';

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const dt = (Date.now() - t) / 1000;
  if (dt < 60) return `${Math.round(dt)}s ago`;
  if (dt < 3600) return `${Math.round(dt / 60)}m ago`;
  return `${Math.round(dt / 3600)}h ago`;
}

export function SessionsList() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const myId = getSessionId();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await listSessions();
        if (!cancelled) {
          setSessions(list);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void load();
    const interval = window.setInterval(() => setTick((t) => t + 1), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [tick]);

  return (
    <div>
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold mb-1">Sessions</h1>
          <p className="text-sm text-zinc-500">
            Polling every 2 s. Your current session id is{' '}
            <code className="font-mono text-accent">{myId.slice(0, 8)}</code>. The sanitizer
            holds sessions open until you close the tab or click finalize.
          </p>
        </div>
        <button
          onClick={() => void finalizeCurrentSession()}
          className="shrink-0 text-sm rounded-md bg-accent text-zinc-950 font-medium px-3 py-2 hover:bg-accent-dim hover:text-zinc-100 transition-colors"
        >
          Finalize this session
        </button>
      </div>
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300 mb-4">
          {error}
        </div>
      )}
      {sessions === null && !error && <div className="text-zinc-500">loading…</div>}
      {sessions && sessions.length === 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-10 text-center text-zinc-500">
          <div className="text-4xl mb-3">⌛</div>
          No sessions yet. Click around the demo, then come back — the worker chain takes
          a few seconds to write its first metadata row.
        </div>
      )}
      {sessions && sessions.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-zinc-500 bg-zinc-900/60">
              <tr>
                <th className="px-4 py-3">Session</th>
                <th className="px-4 py-3 text-right">Events</th>
                <th className="px-4 py-3 text-right">Pages</th>
                <th className="px-4 py-3 text-right">Duration</th>
                <th className="px-4 py-3 text-right">Processed</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {sessions.map((s) => {
                const isMine = s.sessionId === myId;
                return (
                  <tr key={s.sessionId} className={isMine ? 'bg-accent/5' : ''}>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-300">
                      {s.sessionId.slice(0, 12)}…
                      {isMine && <span className="ml-2 text-accent">● this tab</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{s.eventCount}</td>
                    <td className="px-4 py-3 text-right font-mono">{s.pageTransitions}</td>
                    <td className="px-4 py-3 text-right font-mono">{fmtDuration(s.durationMs)}</td>
                    <td className="px-4 py-3 text-right text-zinc-500">{fmtRelative(s.processedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/_/sessions/${s.sessionId}`}
                        className="text-xs rounded-md bg-zinc-800 hover:bg-accent hover:text-zinc-950 text-zinc-200 px-2.5 py-1 transition-colors"
                      >
                        replay →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
