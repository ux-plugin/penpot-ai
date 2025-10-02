/**
 * Pure companion app client with constructor-level dependency injection
 * Stores and managers are injected at construction time
 * Methods pull fresh values from stores/managers when called
 */

import { createCompanionMessage, decryptIfValid } from './encryption.ts';
import { performHandshakeWithDependencies } from './handshake.ts';
import { EncryptionKeyManager, encryptionKeyManager } from '@user/api/EncryptionKeyManager.ts';
import { NonceManager, nonceManager } from '@shared/api/NonceManager.ts';
import { useCompanionStore } from '@companion/stores/useCompanionStore.ts';
import { usePortUpdatesStore } from '@user/stores/usePortUpdatesStore.ts';

// Dependency interface for the client - stores and managers
export interface CompanionClientDependencies {
  keyManager: EncryptionKeyManager;
  nonceManager: NonceManager;
  companionStore: typeof useCompanionStore;
  portUpdatesStore: typeof usePortUpdatesStore;
}

// Response type for streaming
export interface StreamChunk {
  data: any;
  timestamp: number;
}

// Configuration options
interface ClientConfig {
  timeout?: number;
  maxRetries?: number;
}

const DEFAULT_CONFIG: ClientConfig = {
  timeout: 10000, // 10 seconds
  maxRetries: 3
};

/**
 * Pure companion app client class
 * Store dependencies and managers are injected at construction time
 */
export class CompanionAppClient {
  private config: ClientConfig;
  private deps: CompanionClientDependencies;

  constructor(deps: CompanionClientDependencies, config: ClientConfig = DEFAULT_CONFIG) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if connection prerequisites are met
   * Throws error if prerequisites are not satisfied
   */
  private checkConnectionReady(): void {
    if (!this.deps.keyManager.isKeyValid()) {
      throw new Error('No valid encryption key available');
    }
    
    const port = this.deps.portUpdatesStore.getState().currentPort;
    if (!port) {
      throw new Error('No companion app port configured');
    }
  }

  /**
   * Validate a received nonce
   * Returns false if nonce has already been seen, true otherwise
   */
  private validateNonce(nonce: string): boolean {
    if (this.deps.nonceManager.hasNonce(nonce)) {
      return false;
    }
    this.deps.nonceManager.addNonce(nonce);
    return true;
  }

  /**
   * Performs handshake with companion app using the new handshake implementation
   * No parameters needed - pulls fresh values from injected dependencies
   */
  async performHandshake(): Promise<void> {
    this.checkConnectionReady();
    
    const encryptionKey = this.deps.keyManager.getKey()!;
    const nonce = this.deps.nonceManager.generateNonce();
    const port = this.deps.portUpdatesStore.getState().currentPort!;

    try {
      await performHandshakeWithDependencies(
        port,
        encryptionKey,
        nonce,
        (receivedNonce: string) => this.validateNonce(receivedNonce)
      );
      
      console.log('Handshake completed successfully');
      this.deps.companionStore.getState().setCompanionConnected(true);
      
    } catch (error) {
      console.error('Handshake failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Handshake failed';
      this.deps.companionStore.getState().setCompanionError(errorMessage);
      throw error;
    }
  }

  /**
   * Makes a regular HTTP request to the companion app
   * No parameters needed - pulls fresh values from injected dependencies
   */
  async fetch(endpoint: string, options?: RequestInit): Promise<Response> {
    this.checkConnectionReady();
    
    const encryptionKey = this.deps.keyManager.getKey()!;
    const nonce = this.deps.nonceManager.generateNonce();
    const port = this.deps.portUpdatesStore.getState().currentPort!;

    const url = `http://localhost:${port}${endpoint}`;
    
    try {
      // Prepare request body if provided
      let requestMessage: string | undefined;
      
      if (options?.body && typeof options.body === 'string') {
        requestMessage = await createCompanionMessage(
          options.body,
          encryptionKey,
          nonce
        );
      }

      const requestOptions: RequestInit = {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers
        },
        body: requestMessage ? JSON.stringify(requestMessage) : undefined
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      try {
        const response = await fetch(url, {
          ...requestOptions,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Companion app request failed: ${response.status} ${response.statusText}`);
        }

        return response;

      } catch (error) {
        clearTimeout(timeoutId);
        
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Request timed out after ${this.config.timeout}ms`);
        }
        
        throw error;
      }
    } catch (error) {
      console.error('Companion app request failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Request failed';
      this.deps.companionStore.getState().setCompanionError(errorMessage);
      throw error;
    }
  }

  /**
   * Makes a streaming request to the companion app
   * Returns a ReadableStream that yields validated chunks
   * No parameters needed - pulls fresh values from injected dependencies
   */
  async fetchStream(endpoint: string, options?: RequestInit): Promise<ReadableStream<StreamChunk>> {
    this.checkConnectionReady();
    
    const encryptionKey = this.deps.keyManager.getKey()!;
    const response = await this.fetch(endpoint, options);
    
    if (!response.body) {
      throw new Error('No response body for streaming request');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Bind validateNonce to preserve 'this' context
    const validateNonce = (nonce: string) => this.validateNonce(nonce);
    
    return new ReadableStream<StreamChunk>({
      start(controller) {
        async function pump() {
          try {
            while (true) {
              const { done, value } = await reader.read();
              
              if (done) {
                controller.close();
                return;
              }

              // Decode the chunk
              const chunkText = decoder.decode(value, { stream: true });
              
              try {
                // Parse as JSON message
                const chunkMessage = JSON.parse(chunkText);
                
                // Validate the chunk message
                const validatedChunk = await decryptIfValid(
                  chunkMessage,
                  encryptionKey,
                  validateNonce
                );

                // Enqueue the validated chunk
                controller.enqueue({
                  data: validatedChunk.data,
                  timestamp: validatedChunk.timestamp
                });

              } catch (chunkError) {
                console.warn('Invalid chunk received, skipping:', chunkError);
                // Continue processing other chunks rather than failing the entire stream
              }
            }
          } catch (error) {
            controller.error(error);
          }
        }
        
        pump();
      }
    });
  }
}

// Export singleton instance with dependencies
export const companionAppClient = new CompanionAppClient({
  keyManager: encryptionKeyManager,
  nonceManager,
  companionStore: useCompanionStore,
  portUpdatesStore: usePortUpdatesStore
});
