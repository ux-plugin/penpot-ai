/**
 * ConnectionManager - Central orchestrator for companion app connectivity
 * 
 * Responsibilities:
 * - Manages connection lifecycle and state machine
 * - Coordinates encryption key generation
 * - Handles port updates and automatic reconnection
 * - Provides intelligent error handling (404 vs network errors)
 * - Wraps operations with connection validation and error recovery
 */

import { CompanionWebSocketClient, WebSocketState } from "./companionWebSocketClient.ts";
import { useCompanionStore } from "@companion/stores/useCompanionStore.ts";
import { usePortUpdatesStore } from "@user/stores/usePortUpdatesStore.ts";

/**
 * ConnectionManager class - Thin orchestration layer for companion app connectivity
 * State management and key operations are handled by WebSocketClient and stores directly
 */
export class ConnectionManager {
  private wsClient: CompanionWebSocketClient;

  constructor(wsClient: CompanionWebSocketClient) {
    this.wsClient = wsClient;
  }

  /**
   * Get current connection state from store
   */
  getState(): WebSocketState {
    return useCompanionStore.getState().webSocketState;
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.wsClient.isConnected();
  }

  /**
   * Connect to companion app
   * WebSocket client handles key validation and state updates
   */
  async connect(): Promise<void> {
    console.log('Starting connection process...');
    
    const port = usePortUpdatesStore.getState().currentPort;
    if (!port) {
      throw new Error('No companion app port configured');
    }

    await this.wsClient.connect(port);
    console.log('Connection established successfully');
  }

  /**
   * Disconnect from companion app
   */
  disconnect(): void {
    console.log('Disconnecting from companion app...');
    this.wsClient.close();
    console.log('Disconnected successfully');
  }

  /**
   * Handle port update event (companion app restart)
   * Disconnects and reconnects to new port
   */
  async onPortUpdate(newPort: number): Promise<void> {
    console.log(`Port updated to ${newPort}, initiating reconnection...`);

    this.disconnect();

    try {
      await this.wsClient.connect(newPort);
      console.log('Reconnection successful after port update');
    } catch (error) {
      console.error('Failed to reconnect after port update:', error);
      throw error;
    }
  }

  /**
   * Start audio recording via WebSocket
   * Returns an object with a close function
   * Subscribes to audio-chunk messages
   * 
   * IMPORTANT: This method does NOT close the WebSocket connection when recording stops.
   * The WebSocket remains open and ready for subsequent recording sessions.
   */
  async startRecording(options: {
    onAudioChunk: (base64Audio: string) => void;
    onError: (error: Error) => void;
  }): Promise<{ close: () => void }> {
    if (!this.isConnected()) {
      throw new Error('Not connected to companion app');
    }

    console.log('📡 Starting recording session - WebSocket will remain open');
    
    // Track if cleanup has already been done to prevent double cleanup
    let isCleanedUp = false;
    
    const cleanup = () => {
      if (isCleanedUp) {
        console.log('⚠️ Cleanup already performed, skipping');
        return;
      }
      isCleanedUp = true;
      
      console.log('🧹 Cleaning up recording subscriptions (WebSocket stays open)');
      unsubscribeAudioChunk();
      unsubscribeError();
      unsubscribeRecordingStopped();
    };

    // Subscribe to audio chunks
    const unsubscribeAudioChunk = this.wsClient.on('audio-chunk', (data: string) => {
      try {
        options.onAudioChunk(data);
      } catch (error) {
        console.error('Error processing audio chunk:', error);
      }
    });

    // Subscribe to errors (but don't close WebSocket on recording errors)
    const unsubscribeError = this.wsClient.on('error', (errorData: any) => {
      console.error('🔴 Recording error (WebSocket stays open):', errorData);
      options.onError(new Error(errorData.message || 'Recording error'));
      // Note: WebSocket connection is NOT closed here
    });

    // Subscribe to recording-stopped (companion app initiated stop)
    const unsubscribeRecordingStopped = this.wsClient.on('recording-stopped', () => {
      console.log('⏹️ Recording stopped by companion app (WebSocket stays open)');
      cleanup();
      // IMPORTANT: WebSocket connection is NOT closed here
    });

    // Send start-recording command and wait for confirmation
    await this.wsClient.sendCommand('start-recording');
    console.log('✅ Recording started successfully - WebSocket remains open for this and future sessions');

    // Return close function that stops recording but keeps WebSocket open
    return {
      close: () => {
        console.log('⏹️ Stopping recording (WebSocket stays open)...');
        cleanup();
        
        // Send stop command to companion app
        // Note: This only stops recording, does NOT close the WebSocket
        this.wsClient.sendCommand('stop-recording').catch(error => {
          console.error('Error sending stop-recording command:', error);
        });
        
        console.log('✅ Recording stopped - WebSocket remains open and ready');
      }
    };
  }
}
