/**
 * Port updates using WebSocket
 * Replaces SSE-based port updates with unified WebSocket infrastructure
 */

import { getSharedWebSocket } from '@shared/api/SharedWebSocketClient';

export interface AppState {
  port: number | null;
  nonce?: number;
}

export interface PortUpdatesConnection {
  close(): void;
  isConnected(): boolean;
}

/**
 * Creates a WebSocket connection for port updates.
 * Subscribes to user:port_update events from the backend.
 * Uses the shared singleton WebSocket instance.
 */
export function createPortUpdatesConnection(
  onPortUpdate?: (port: number | null) => void,
  onConnectionStatusChange?: (connected: boolean) => void,
  onError?: (error: string) => void
): PortUpdatesConnection {
  let currentPort: number | null = null;

  // Get the shared WebSocket singleton
  const wsClient = getSharedWebSocket();

  // Register connection callbacks
  const unsubscribeOpen = wsClient.onOpen(() => {
    console.log('Port updates: WebSocket connection opened');
    onConnectionStatusChange?.(true);

    // Subscribe to port updates after connection opens
    wsClient.send({
      event: 'user:subscribe_ports',
    });
    console.log('Subscribed to port updates');
  });

  const unsubscribeClose = wsClient.onClose(() => {
    console.log('Port updates: WebSocket connection closed');
    onConnectionStatusChange?.(false);
  });

  const unsubscribeError = wsClient.onError((event) => {
    console.error('Port updates: WebSocket connection error:', event);
    onError?.('WebSocket connection error');
  });

  // Subscribe to port update events
  const unsubscribePortUpdate = wsClient.on('user:port_update', (data: AppState) => {
    if (data.port !== currentPort) {
      console.log('Port updated:', data.port);
      currentPort = data.port;
      onPortUpdate?.(data.port);
    }
  });

  // Connect to WebSocket (will reuse existing connection if already connected)
  wsClient.connect().catch((error) => {
    console.error('Failed to connect to port updates WebSocket:', error);
    onError?.(error.message || 'Failed to connect to WebSocket');
  });

  return {
    close: () => {
      console.log('Unsubscribing from port updates');
      // Unsubscribe from events but don't close the shared connection
      unsubscribeOpen();
      unsubscribeClose();
      unsubscribeError();
      unsubscribePortUpdate();
    },
    isConnected: () => wsClient.isConnected(),
  };
}
