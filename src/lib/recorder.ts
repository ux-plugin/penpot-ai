import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';
import { getSessionId } from './session-id';
import { postChunk, postClose } from './api';

// Singleton flush/finalize hooks so SessionsList can trigger the close hint without
// having to wait for pagehide or the sanitizer's 10-minute idle timeout.
let flushNow: (() => Promise<void>) | null = null;
let finalizeNow: (() => Promise<void>) | null = null;

export async function flushCurrentSession(): Promise<void> {
  await flushNow?.();
}

export async function finalizeCurrentSession(): Promise<void> {
  await finalizeNow?.();
}

/**
 * Boots the rrweb recorder and ships chunks to /ingest. Buffers events in memory,
 * flushes every {flushIntervalMs} into one gzipped NDJSON chunk, posts to the api.
 *
 * **Crucially: NO client-side masking.** The point of this demo is to prove the
 * server-side anonymizer scrubs PII (email, password, etc.). If we masked here,
 * there would be nothing for the anonymizer to demonstrate.
 *
 * Returns a stop function for tests; in normal use we just leave it running until
 * pagehide and let `postClose` finalize the session.
 */
export function startRecorder(opts: { flushIntervalMs?: number } = {}): () => void {
  const flushIntervalMs = opts.flushIntervalMs ?? 5_000;
  const sessionId = getSessionId();
  let buffer: eventWithTime[] = [];
  let chunkSeq = 0;
  let stopped = false;

  const stopRrweb = record({
    emit(event) {
      buffer.push(event as eventWithTime);
    },
    // Defaults — no masking. (rrweb's defaults already mask password inputs;
    // we explicitly opt OUT here so the backend anonymizer is the only thing
    // protecting PII.)
    maskAllInputs: false,
    maskInputOptions: {},
  });

  async function flush() {
    if (stopped || buffer.length === 0) return;
    const seq = chunkSeq++;
    const events = buffer;
    buffer = [];
    const ndjson = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    try {
      const gz = await gzip(ndjson);
      await postChunk(sessionId, seq, gz);
      console.debug('[recorder] flushed chunk', seq, 'events:', events.length, 'gz bytes:', gz.byteLength);
    } catch (err) {
      console.error('[recorder] chunk', seq, 'failed; events lost:', err);
    }
  }

  const interval = window.setInterval(flush, flushIntervalMs);
  // Final flush + close hint on page unload.
  const onHide = () => {
    void flush().finally(() => postClose(sessionId));
  };
  window.addEventListener('pagehide', onHide);

  flushNow = flush;
  finalizeNow = async () => {
    await flush();
    postClose(sessionId);
    // Reset for next recording — sessionStorage clear + new id on the next page load,
    // but for the demo we keep the same id so the user can keep clicking.
    console.info('[recorder] finalized, sessionId:', sessionId);
  };

  console.info('[recorder] started, sessionId:', sessionId);

  return () => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(interval);
    window.removeEventListener('pagehide', onHide);
    flushNow = null;
    finalizeNow = null;
    stopRrweb?.();
    void flush().finally(() => postClose(sessionId));
  };
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
