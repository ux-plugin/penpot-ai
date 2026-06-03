import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import 'rrweb-player/dist/style.css';
import rrwebPlayer from 'rrweb-player';
import { fetchReplay } from '../lib/api';

export function ReplayPage() {
  const { sessionId = '' } = useParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let player: rrwebPlayer | null = null;
    async function load() {
      try {
        const payload = await fetchReplay(sessionId);
        if (cancelled || !containerRef.current) return;
        setCount(payload.eventCount);
        if (payload.events.length < 2) {
          setError('Not enough events to replay (need at least 2 — full snapshot + one mutation).');
          return;
        }
        // rrweb-player mounts into the target div. Width auto-fills by default.
        player = new rrwebPlayer({
          target: containerRef.current,
          props: {
            events: payload.events as object[],
            width: containerRef.current.clientWidth,
            autoPlay: true,
            showController: true,
          },
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void load();
    return () => {
      cancelled = true;
      // rrweb-player has no public destroy; clearing the container is enough for SPA nav.
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [sessionId]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold mb-1">Replay</h1>
        <p className="text-sm text-zinc-500">
          Session <code className="font-mono text-accent">{sessionId.slice(0, 12)}…</code>
          {count !== null && <> · {count} events after anonymization</>}
        </p>
      </div>
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300 mb-4">
          {error}
        </div>
      )}
      <div ref={containerRef} className="rounded-xl overflow-hidden border border-zinc-800 bg-white" />
      <p className="mt-6 text-xs text-zinc-500 leading-relaxed max-w-2xl">
        ↑ The login page in this replay will look empty even if you typed something. The
        backend anonymizer drops every rrweb Input event (source==5) before persisting,
        and the email-pattern regex replaces any literal address with{' '}
        <code className="font-mono text-accent">[EMAIL]</code> in the visible text content.
      </p>
    </div>
  );
}
