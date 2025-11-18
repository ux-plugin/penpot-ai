/**
 * Companion API exports
 * Provides singleton instances and main exports for companion app connectivity
 */

import { ConnectionManager } from './ConnectionManager.ts';
import { CompanionWebSocketClient } from './companionWebSocketClient.ts';

// Export types
export { WebSocketState } from './companionWebSocketClient.ts';
export type { WebSocketCommand, WebSocketResponseType, DecryptedPayload } from './websocketMessageTypes.ts';

// Create singleton WebSocket client instance
const wsClient = new CompanionWebSocketClient({
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  reconnectDecayFactor: 1.5,
  maxReconnectAttempts: 10,
  commandTimeout: 10000
});

// Create a singleton ConnectionManager instance (private to this module)
/** @internal */
export const connectionManager = new ConnectionManager(wsClient);

/**
 * Handle port update from companion app
 * This is the public API for handling port changes
 * ConnectionManager is kept private to this module
 */
export async function handlePortUpdate(newPort: number): Promise<void> {
  try {
    console.log(`Handling port update to ${newPort}...`);
    await connectionManager.onPortUpdate(newPort);
    console.log('Port update handled successfully');
  } catch (error) {
    console.error('Failed to handle port update:', error);
    throw error;
  }
}

// Export hooks
export {
  useCompanionConnection,
  useAudioRecording,
  useAudioPlayback
} from './companionAppHooks.ts';
