// #region DEBUG
/**
 * Debug logging utility - sends logs via POST to a local debug server.
 * All instrumentation in this file is temporary for debugging panning lag.
 */

const DEBUG_LOG_URL = 'http://127.0.0.1:7246';

let _seqId = 0;

export function debugLog(hypothesis: string, message: string, data?: Record<string, unknown>): void {
  const entry = {
    seq: ++_seqId,
    ts: performance.now().toFixed(2),
    h: hypothesis,
    msg: message,
    ...(data ?? {}),
  };
  fetch(DEBUG_LOG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    keepalive: true,
  }).catch(() => {
    // silently ignore if debug server is not running
  });
}

export function debugLogTime(hypothesis: string, label: string): () => void {
  const start = performance.now();
  return () => {
    const elapsed = performance.now() - start;
    debugLog(hypothesis, label, { elapsedMs: +elapsed.toFixed(3) });
  };
}
// #endregion DEBUG
