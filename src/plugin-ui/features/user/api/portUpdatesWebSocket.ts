/**
 * Port updates using WebSocket
 * Replaces SSE-based port updates with unified WebSocket infrastructure
 */

import { SharedWebSocketClient } from '@shared/api/SharedWebSocketClient.ts';

export interface AppState {
  port: number | null;
  nonce?: number;
}

export interface PortUpdatesConnection {
  close(): void;
  isConnected(): boolean;
}

interface PortUpdatesOptions {
  onPortUpdate?: (port: number | null) => void;
  onConnectionStatusChange?: (connected: boolean) => void;
  onError?: (error: string) => void;
}

/**
 * Creates a WebSocket connection for port updates.
 * Subscribes to user:port_update events from the backend.
 */
export function createPortUpdatesConnection(
  onPortUpdate?: (port: number | null) => void,
  onConnectionStatusChange?: (connected: boolean) => void,
  onError?: (error: string) => void
): PortUpdatesConnection {
  let currentPort: number | null = null;

  const wsClient = new SharedWebSocketClient({
    reconnectDelay: 5000,
    maxReconnectDelay: 30000,
    reconnectDecayFactor: 1.5,
    maxReconnectAttempts: 5,
    onOpen: () => {
      console.log('Port updates WebSocket connection opened');
      onConnectionStatusChange?.(true);

      // Subscribe to port updates after connection opens
      wsClient.send({
        event: 'user:subscribe_ports',
      });
      console.log('Subscribed to port updates');
    },
    onClose: () => {
      console.log('Port updates WebSocket connection closed');
      onConnectionStatusChange?.(false);
    },
    onError: (event) => {
      console.error('Port updates WebSocket connection error:', event);
      onError?.('WebSocket connection error');
    },
  });

  // Subscribe to port update events
  const unsubscribe = wsClient.on('user:port_update', (data: AppState) => {
    if (data.port !== currentPort) {
      console.log('Port updated:', data.port);
      currentPort = data.port;
      onPortUpdate?.(data.port);
    }
  });

  // Connect to WebSocket
  wsClient.connect().catch((error) => {
    console.error('Failed to connect to port updates WebSocket:', error);
    onError?.(error.message || 'Failed to connect to WebSocket');
  });

  return {
    close: () => {
      console.log('Closing port updates WebSocket connection');
      unsubscribe();
      wsClient.close();
    },
    isConnected: () => wsClient.isConnected(),
  };
}
