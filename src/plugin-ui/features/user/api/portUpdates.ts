import { createStreamingConnection, StreamingConnection } from '@api/eventSource-fetcher.ts';

export interface AppState {
  port: number | null;
  nonce?: number;
}

interface PortUpdatesData {
  connection: StreamingConnection;
  currentPort: number | null;
  isConnected: boolean;
  error: string | null;
}

/**
 * Creates a streaming connection for port updates.
 */
export function createPortUpdatesConnection(
  onPortUpdate?: (port: number | null) => void,
  onConnectionStatusChange?: (connected: boolean) => void,
  onError?: (error: string) => void
): PortUpdatesData {
  let connection: StreamingConnection | null = null;
  let currentPort: number | null = null;

  connection = createStreamingConnection<AppState>('/user/port/listen', {
    includeAuth: true, // Uses apiFetch with bearer token
    maxRetries: 5,
    retryInterval: 5000,
    onOpen: () => {
      console.log('Port updates streaming connection opened');
      onConnectionStatusChange?.(true);
    },
    onMessage: (appState: AppState) => {
      if (appState.port !== currentPort) {
        console.log('Port updated:', appState.port);
        currentPort = appState.port;
        onPortUpdate?.(appState.port);
      }
    },
    onError: (streamError: Error) => {
      console.error('Port updates streaming connection error:', streamError);
      onError?.(streamError.message);
    },
    onClose: () => {
      console.log('Port updates streaming connection closed');
      onConnectionStatusChange?.(false);
    }
  });

  return {
    connection,
    currentPort,
    isConnected: true, // Initial connection successful
    error: null
  };
}


export type { PortUpdatesData };
