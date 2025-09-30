/**
 * Pure companion app client with dependency injection
 * No direct store dependencies - all dependencies injected by hooks
 */

import { createCompanionMessage, decryptIfValid } from '@/api/companionApp/encryption.ts';
import { performHandshakeWithDependencies } from './handshake';

// Dependency interface for the client
export interface CompanionClientDependencies {
  encryptionKey: string;
  nonce: string;
  currentPort: number;
  nonceValidator: (nonce: string) => boolean;
  onConnectionStateChange?: (connected: boolean) => void;
  onError?: (error: Error) => void;
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
 * All store dependencies are injected through the dependencies parameter
 */
export class CompanionAppClient {
  private config: ClientConfig;

  constructor(config: ClientConfig = DEFAULT_CONFIG) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Performs handshake with companion app using the new handshake implementation
   */
  async performHandshake(deps: CompanionClientDependencies): Promise<void> {
    try {
      await performHandshakeWithDependencies(
        deps.currentPort,
        deps.encryptionKey,
        deps.nonce,
        deps.nonceValidator
      );
      
      console.log('Handshake completed successfully');
      deps.onConnectionStateChange?.(true);
      
    } catch (error) {
      console.error('Handshake failed:', error);
      deps.onConnectionStateChange?.(false);
      deps.onError?.(error instanceof Error ? error : new Error('Handshake failed'));
      throw error;
    }
  }

  /**
   * Makes a regular HTTP request to the companion app
   */
  async fetch(
    endpoint: string, 
    deps: CompanionClientDependencies, 
    options?: RequestInit
  ): Promise<Response> {
    const url = `http://localhost:${deps.currentPort}${endpoint}`;
    
    try {
      // Prepare request body if provided
      let requestMessage: string | undefined;
      
      if (options?.body && typeof options.body === 'string') {
        requestMessage = await createCompanionMessage(
          options.body,
          deps.encryptionKey,
          deps.nonce
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
      deps.onError?.(error instanceof Error ? error : new Error('Request failed'));
      throw error;
    }
  }

  /**
   * Makes a streaming request to the companion app
   * Returns a ReadableStream that yields validated chunks
   */
  async fetchStream(
    endpoint: string,
    deps: CompanionClientDependencies,
    options?: RequestInit
  ): Promise<ReadableStream<StreamChunk>> {
    const response = await this.fetch(endpoint, deps, options);
    
    if (!response.body) {
      throw new Error('No response body for streaming request');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
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
                  deps.encryptionKey,
                  deps.nonceValidator
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

// Export singleton instance
export const companionAppClient = new CompanionAppClient();
