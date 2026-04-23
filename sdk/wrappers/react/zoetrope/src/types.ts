import type { ReactNode } from 'react';
import type { record } from 'rrweb';

/**
 * A single rrweb event. Kept loosely typed at this layer so we don't pin to
 * a specific rrweb internal shape; consumers can narrow to `eventWithTime`
 * from `@rrweb/types` at the call site if they need richer typing.
 */
export interface ZoetropeEvent {
  type: number;
  data: unknown;
  timestamp: number;
}

/**
 * Pass-through options for the underlying rrweb.record() call, minus `emit`
 * (which the provider owns so it can buffer + forward events).
 */
export type ZoetropeRecordOptions = Omit<
  NonNullable<Parameters<typeof record>[0]>,
  'emit'
>;

export interface ZoetropeProviderProps {
  /** HTTPS endpoint that receives batched events as JSON. */
  endpoint?: string;
  /** Correlation id sent with every batch. */
  sessionId?: string;
  /** Called for every event emitted by rrweb. */
  onEvent?: (event: ZoetropeEvent) => void;
  /** Flush buffered events this often, in milliseconds. Default 5000. */
  flushIntervalMs?: number;
  /** rrweb passthrough options (masking, sampling, plugins, …). */
  recordOptions?: ZoetropeRecordOptions;
  /** Turn recording on/off without unmounting the provider. Default true. */
  enabled?: boolean;
  children: ReactNode;
}

export interface ZoetropeContextValue {
  sessionId: string | undefined;
  isRecording: boolean;
  /** Immediately flush any buffered events to `endpoint`. */
  flush: () => Promise<void>;
  /** Stop recording without unmounting the provider. */
  stop: () => void;
}
