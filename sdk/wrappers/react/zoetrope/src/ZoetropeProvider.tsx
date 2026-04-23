import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { record } from 'rrweb';

import type {
  ZoetropeContextValue,
  ZoetropeEvent,
  ZoetropeProviderProps,
} from './types';

export const ZoetropeContext = createContext<ZoetropeContextValue | null>(null);

// Module-level guard: rrweb hooks globals (document/window), so running two
// recorders in the same tab double-emits events. This is a dev-time warning,
// not a hard error — that way tests or HMR reloads stay permissive.
let activeRecorder: symbol | null = null;

export function ZoetropeProvider({
  endpoint,
  sessionId,
  onEvent,
  flushIntervalMs = 5_000,
  recordOptions,
  enabled = true,
  children,
}: ZoetropeProviderProps) {
  const bufferRef = useRef<ZoetropeEvent[]>([]);
  const onEventRef = useRef(onEvent);
  const stopRef = useRef<(() => void) | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  // Keep the latest onEvent available without re-running the recorder effect.
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const flush = useCallback(async () => {
    if (!endpoint || bufferRef.current.length === 0) return;
    const batch = bufferRef.current.splice(0);
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, events: batch }),
        // Lets the final flush survive pagehide on mobile.
        keepalive: true,
      });
    } catch {
      // Requeue for the next tick; drop on unmount if still failing.
      bufferRef.current.unshift(...batch);
    }
  }, [endpoint, sessionId]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setIsRecording(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const token = Symbol('zoetrope-provider');
    if (activeRecorder !== null) {
      // eslint-disable-next-line no-console
      console.warn(
        '[zoetrope] multiple <ZoetropeProvider /> instances detected — ' +
          'only the first should be mounted or events will be duplicated.',
      );
    }
    activeRecorder = token;

    const stopRrweb = record({
      ...recordOptions,
      emit: (event) => {
        const evt = event as ZoetropeEvent;
        bufferRef.current.push(evt);
        onEventRef.current?.(evt);
      },
    });

    stopRef.current = stopRrweb ?? null;
    setIsRecording(Boolean(stopRrweb));

    const timer = window.setInterval(() => {
      void flush();
    }, flushIntervalMs);

    const onPageHide = () => {
      void flush();
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      if (activeRecorder === token) activeRecorder = null;
      window.clearInterval(timer);
      window.removeEventListener('pagehide', onPageHide);
      stopRrweb?.();
      stopRef.current = null;
      setIsRecording(false);
      void flush();
    };
  }, [enabled, flush, flushIntervalMs, recordOptions]);

  const value = useMemo<ZoetropeContextValue>(
    () => ({ sessionId, isRecording, flush, stop }),
    [sessionId, isRecording, flush, stop],
  );

  return (
    <ZoetropeContext.Provider value={value}>
      {children}
    </ZoetropeContext.Provider>
  );
}
