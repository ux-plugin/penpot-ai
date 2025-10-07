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

// Connection state machine
export type ConnectionState = 'disconnected' | 'key_ready' | 'connected';

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
  private currentState: ConnectionState = 'disconnected';

  constructor(deps: ConnectionManagerDependencies) {
    this.deps = deps;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.currentState;
  }

  /**
   * Check if currently connected (handshake done + port configured)
   * Note: Does not check key validity - key renewal happens automatically before operations
   */
  isConnected(): boolean {
    return this.currentState === 'connected' &&
           !!this.deps.portUpdatesStore.getState().currentPort;
  }

  /**
   * Update connection state and sync with store
   */
  private setState(newState: ConnectionState, error?: ConnectionError): void {
    this.currentState = newState;
    const companionStore = this.deps.companionStore.getState();

    switch (newState) {
      case 'disconnected':
        companionStore.setCompanionConnected(false);
        companionStore.setHandshakeDone(false);
        if (error) {
          companionStore.setCompanionError(error.message);
        }
        break;
      
      case 'key_ready':
        companionStore.setCompanionConnecting(true);
        companionStore.setHandshakeDone(false);
        break;
      
      case 'connected':
        companionStore.setCompanionConnected(true);
        companionStore.setHandshakeDone(true);
        companionStore.setCompanionError(null);
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
      this.setState('disconnected', connectionError);
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
      this.setState('key_ready');

      // Step 2: Perform handshake
      await this.performHandshake();
      this.setState('connected');

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
    this.setState('disconnected');
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
      this.setState('key_ready');

      // Attempt handshake with new key
      await this.performHandshake();
      this.setState('connected');
      
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
    if (this.currentState === 'disconnected') {
      this.setState('key_ready');
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
        this.setState('connected');
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
        this.setState('connected');
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
      state: this.currentState,
      isConnected: this.isConnected(),
      hasKey: this.deps.keyManager.isKeyValid(),
      hasPort: !!this.deps.portUpdatesStore.getState().currentPort,
      canConnect: this.canConnect(),
      port: this.deps.portUpdatesStore.getState().currentPort,
      keyExpiresAt: this.deps.keyManager.getExpiresAt()
    };
  }
}
