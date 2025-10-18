/**
 * ConnectionManager - Central orchestrator for companion app connectivity
 * 
 * Responsibilities:
 * - Manages connection lifecycle and state machine
 * - Coordinates encryption key generation and handshake
 * - Handles port updates and automatic reconnection
 * - Provides intelligent error handling (404 vs network errors)
 * - Wraps API calls with connection validation and error recovery
 */

import { CompanionAppClient } from "./companionAppClient.ts";
import { EncryptionKeyManager } from "@user/api/EncryptionKeyManager.ts";
import { NonceManager } from "@shared/api/NonceManager.ts";
import { useCompanionStore } from "@companion/stores/useCompanionStore.ts";
import { usePortUpdatesStore } from "@user/stores/usePortUpdatesStore.ts";

// Connection state machine as enum for type safety and performance
export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  KEY_READY = 'KEY_READY',
  CONNECTED = 'CONNECTED'
}

// Error types for intelligent handling
export type ConnectionErrorType = '404' | 'network' | 'timeout' | 'handshake' | 'other';

export interface ConnectionError {
  type: ConnectionErrorType;
  message: string;
  timestamp: Date;
}

// Dependencies interface
export interface ConnectionManagerDependencies {
  client: CompanionAppClient;
  keyManager: EncryptionKeyManager;
  nonceManager: NonceManager;
  companionStore: typeof useCompanionStore;
  portUpdatesStore: typeof usePortUpdatesStore;
}

/**
 * ConnectionManager class - Single entry point for all companion app connectivity
 */
export class ConnectionManager {
  private deps: ConnectionManagerDependencies;

  constructor(deps: ConnectionManagerDependencies) {
    this.deps = deps;
  }

  /**
   * Get current connection state from store
   */
  getState(): ConnectionState {
    return this.deps.companionStore.getState().connectionState;
  }

  /**
   * Check if currently connected (handshake done + port configured)
   * Note: Does not check key validity - key renewal happens automatically before operations
   */
  isConnected(): boolean {
    const companionState = this.deps.companionStore.getState();
    return companionState.connectionState === ConnectionState.CONNECTED &&
           !!this.deps.portUpdatesStore.getState().currentPort;
  }

  /**
   * Update connection state in store
   */
  private setState(newState: ConnectionState, error?: ConnectionError): void {
    const companionStore = this.deps.companionStore.getState();

    // Update connection state
    companionStore.setConnectionState(newState);

    // Handle side effects based on state
    switch (newState) {
      case ConnectionState.DISCONNECTED:
        if (error) {
          companionStore.setCompanionError(error.message);
        }
        break;
      
      case ConnectionState.KEY_READY:
        companionStore.setCompanionConnecting(true);
        break;
      
      case ConnectionState.CONNECTED:
        companionStore.setCompanionError(null);
        companionStore.setCompanionConnecting(false);
        break;
    }
  }

  /**
   * Classify error type for intelligent handling
   */
  private classifyError(error: Error): ConnectionErrorType {
    const message = error.message.toLowerCase();
    
    if (message.includes('404')) return '404';
    if (message.includes('timeout')) return 'timeout';
    if (message.includes('handshake')) return 'handshake';
    if (message.includes('network') || message.includes('fetch') || message.includes('econnrefused')) {
      return 'network';
    }
    
    return 'other';
  }

  /**
   * Handle connection error with intelligent recovery logic
   */
  private handleConnectionError(error: Error): ConnectionError {
    const errorType = this.classifyError(error);
    const connectionError: ConnectionError = {
      type: errorType,
      message: error.message,
      timestamp: new Date()
    };

    console.error(`Connection error (${errorType}):`, error.message);

    // For 404 and network errors, mark as disconnected and wait
    // (Don't retry automatically - companion app may not exist)
    if (errorType === '404' || errorType === 'network') {
      this.setState(ConnectionState.DISCONNECTED, connectionError);
    }

    return connectionError;
  }

  /**
   * Ensure valid encryption key exists (generate if needed)
   */
  private async ensureKey(): Promise<void> {
    if (!this.deps.keyManager.isKeyValid()) {
      console.log('Generating new encryption key...');
      await this.deps.keyManager.generateKey();
      console.log('Encryption key generated successfully');
    }
  }

  /**
   * Perform handshake with companion app
   * This is the internal implementation - external code should call connect()
   * 
   * Implements automatic key refresh on 403:
   * - If handshake fails with 403, fetches new key from backend
   * - Retries handshake once with new key
   * - If 403 again, throws the error
   */
  private async performHandshake(): Promise<void> {
    const port = this.deps.portUpdatesStore.getState().currentPort;
    
    if (!port) {
      throw new Error('No companion app port configured');
    }

    if (!this.deps.keyManager.isKeyValid()) {
      throw new Error('No valid encryption key available');
    }

    console.log('Performing handshake with companion app...');
    
    try {
      await this.deps.client.connect();
      console.log('Handshake completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Check if error is a 403 (Forbidden) - key mismatch
      if (errorMessage.includes('403')) {
        console.log('Received 403 during handshake, fetching new encryption key from backend...');
        
        try {
          // Fetch the current key from backend
          await this.deps.keyManager.fetchCurrentKey();
          console.log('New encryption key fetched, retrying handshake...');
          
          // Retry handshake once with new key
          await this.deps.client.connect();
          console.log('Handshake completed successfully after key refresh');
          return; // Success on retry
        } catch (retryError) {
          const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError);
          
          // If we get 403 again, the issue is not key-related
          if (retryErrorMessage.includes('403')) {
            console.error('Received 403 again after key refresh, authentication issue persists');
          } else {
            console.error('Handshake failed on retry:', retryError);
          }
          
          throw retryError; // Throw the retry error
        }
      }
      
      // For non-403 errors, throw immediately
      console.error('Handshake failed:', error);
      throw error;
    }
  }

  /**
   * Full connection flow: ensure key + perform handshake
   * This is the main public API for establishing connection
   */
  async connect(): Promise<void> {
    console.log('Starting connection process...');
    
    const companionStore = this.deps.companionStore.getState();
    companionStore.setCompanionConnecting(true);
    companionStore.setCompanionError(null);

    try {
      // Step 1: Ensure valid encryption key
      await this.ensureKey();
      this.setState(ConnectionState.KEY_READY);

      // Step 2: Perform handshake
      await this.performHandshake();
      this.setState(ConnectionState.CONNECTED);

      console.log('Connection established successfully');
    } catch (error) {

      throw this.handleConnectionError(
        error instanceof Error ? error : new Error("Connection failed"),
      );
    } finally {
      companionStore.setCompanionConnecting(false);
    }
  }

  /**
   * Disconnect and reset all connection state
   */
  disconnect(): void {
    console.log('Disconnecting from companion app...');
    this.setState(ConnectionState.DISCONNECTED);
    console.log('Disconnected successfully');
  }

  /**
   * Handle port update event (companion app restart)
   * Generates new key and attempts handshake automatically
   */
  async onPortUpdate(newPort: number): Promise<void> {
    console.log(`Port updated to ${newPort}, initiating reconnection...`);

    // Reset connection state
    this.disconnect();

    try {
      // Generate fresh encryption key for new companion session
      console.log('Generating new encryption key for companion restart...');
      await this.deps.keyManager.generateKey();
      this.setState(ConnectionState.KEY_READY);

      // Attempt handshake with new key
      await this.performHandshake();
      this.setState(ConnectionState.CONNECTED);
      
      console.log('Reconnection successful after port update');
    } catch (error) {
      const connectionError = this.handleConnectionError(
        error instanceof Error ? error : new Error('Reconnection failed')
      );
      
      console.warn(
        `Failed to reconnect after port update (${connectionError.type}). ` +
        'Waiting for manual reconnection or next port update.'
      );
      
      // Don't throw - just mark as disconnected and wait
      // User can manually retry or wait for next port update
    }
  }

  /**
   * Handle key generation event
   * Marks system as ready for handshake
   */
  onKeyGenerated(): void {
    console.log('New encryption key generated, ready for handshake');
    const currentState = this.getState();
    if (currentState === ConnectionState.DISCONNECTED) {
      this.setState(ConnectionState.KEY_READY);
    }
  }

  /**
   * Wrap API call with connection validation and error handling
   * Automatically renews expired keys and reconnects before executing
   * Use this for regular fetch operations
   */
  async apiCall<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isConnected()) {
      throw new Error('Not connected to companion app');
    }

    // Check if key has expired and renew if needed
    if (!this.deps.keyManager.isKeyValid()) {
      console.log('Encryption key expired, generating new key and reconnecting...');
      try {
        await this.ensureKey();
        await this.performHandshake();
        this.setState(ConnectionState.CONNECTED);
        console.log('Key renewed and reconnected successfully');
      } catch (error) {
        const renewalError = error instanceof Error ? error : new Error('Key renewal failed');
        console.error('Failed to renew key:', renewalError);
        throw this.handleConnectionError(renewalError);
      }
    }

    try {
      return await fn();
    } catch (error) {

      throw this.handleConnectionError(
        error instanceof Error ? error : new Error("API call failed"),
      );
    }
  }

  /**
   * Wrap streaming call with connection validation and error handling
   * Automatically renews expired keys and reconnects before executing
   * Use this for streaming operations
   */
  async streamCall<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isConnected()) {
      throw new Error('Not connected to companion app');
    }

    // Check if key has expired and renew if needed
    if (!this.deps.keyManager.isKeyValid()) {
      console.log('Encryption key expired, generating new key and reconnecting...');
      try {
        await this.ensureKey();
        await this.performHandshake();
        this.setState(ConnectionState.CONNECTED);
        console.log('Key renewed and reconnected successfully');
      } catch (error) {
        const renewalError = error instanceof Error ? error : new Error('Key renewal failed');
        console.error('Failed to renew key:', renewalError);
        throw this.handleConnectionError(renewalError);
      }
    }

    try {
      return await fn();
    } catch (error) {

      throw this.handleConnectionError(
        error instanceof Error ? error : new Error("Stream call failed"),
      );
    }
  }

  /**
   * Check if prerequisites for connection are met
   */
  canConnect(): boolean {
    const port = this.deps.portUpdatesStore.getState().currentPort;
    return !!port;
  }

  /**
   * Get current connection status information
   */
  getConnectionInfo(): {
    state: ConnectionState;
    isConnected: boolean;
    hasKey: boolean;
    hasPort: boolean;
    canConnect: boolean;
    port: number | null;
    keyExpiresAt: Date | null;
  } {
    return {
      state: this.getState(),
      isConnected: this.isConnected(),
      hasKey: this.deps.keyManager.isKeyValid(),
      hasPort: !!this.deps.portUpdatesStore.getState().currentPort,
      canConnect: this.canConnect(),
      port: this.deps.portUpdatesStore.getState().currentPort,
      keyExpiresAt: this.deps.keyManager.getExpiresAt()
    };
  }

  /**
   * Start audio recording stream
   * Returns an object with a close function
   * Handles encrypted SSE stream with audio chunks
   */
  async startRecording(options: {
    onAudioChunk: (base64Audio: string) => void;
    onError: (error: Error) => void;
  }): Promise<{ close: () => void }> {
    return this.streamCall(async () => {
      const port = this.deps.portUpdatesStore.getState().currentPort;
      if (!port) {
        throw new Error('No companion app port configured');
      }

      const base64EncryptionKey = this.deps.keyManager.getKey();
      if (!base64EncryptionKey) {
        throw new Error('No valid encryption key available');
      }

      // Import SSE connection utility
      const { createCompanionSSEConnection } = await import('./companionSSE-fetcher.ts');
      
      // Create SSE connection with encryption
      const connection = await createCompanionSSEConnection<string>('/start-recording', {
        requestData: 'CMD',
        encryptionKey: base64EncryptionKey,
        port,
        generateNonce: () => this.deps.nonceManager.generateNonce(),
        validateNonce: (nonce: Uint8Array) => {
          if (this.deps.nonceManager.hasNonce(nonce)) {
            return false;
          }
          this.deps.nonceManager.addNonce(nonce);
          return true;
        },
        onMessage: options.onAudioChunk,
        onError: options.onError,
        onOpen: () => {
          console.log('Audio recording stream started');
        },
        onClose: () => {
          console.log('Audio recording stream closed');
        }
      });

      // Return close function
      return {
        close: () => connection.close()
      };
    });
  }
}
