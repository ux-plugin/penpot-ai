/**
 * Companion App SSE (Server-Sent Events) fetcher with encryption support
 * Similar to eventSource-fetcher but for companion app with encrypted POST requests
 */

import { parseSSEStream, SSEEvent } from "@shared/api/sse-parser.ts";
import { createCompanionMessage, decryptIfValid } from "./encryption.ts";

export interface CompanionSSEOptions<T> {
  /**
   * Request data to encrypt and send in POST body
   */
  requestData: string;
  
  /**
   * Callback when a decrypted message is received
   */
  onMessage: (data: T) => void;
  
  /**
   * Callback when an error event is received or decryption fails
   */
  onError?: (error: Error) => void;
  
  /**
   * Callback when connection is established
   */
  onOpen?: () => void;
  
  /**
   * Callback when connection is closed
   */
  onClose?: () => void;
  
  /**
   * Encryption key (base64)
   */
  encryptionKey: string;
  
  /**
   * Port for the companion app
   */
  port: number;
  
  /**
   * Nonce validator function
   * Should return true if nonce is valid, false if already seen
   */
  validateNonce: (nonce: Uint8Array) => boolean;
  
  /**
   * Nonce generator function
   */
  generateNonce: () => Uint8Array;
}

export interface CompanionSSEConnection {
  close(): void;
  isConnected(): boolean;
}

class CompanionSSEConnectionImpl implements CompanionSSEConnection {
  private isActive = false;
  private abortController: AbortController | null = null;

  constructor(
    private endpoint: string,
    private options: CompanionSSEOptions<any>
  ) {}

  async connect(): Promise<void> {
    const {
      requestData,
      onMessage,
      onError,
      onOpen,
      onClose,
      encryptionKey,
      port,
      validateNonce,
      generateNonce
    } = this.options;

    try {
      this.abortController = new AbortController();

      // Generate nonce and create encrypted message
      const nonce = generateNonce();
      const encryptedMessage = await createCompanionMessage(
        requestData,
        encryptionKey,
        nonce
      );

      // Make POST request with encrypted body
      const url = `http://localhost:${port}${this.endpoint}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({ encrypted_data: encryptedMessage }),
        signal: this.abortController.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      this.isActive = true;
      console.log('Companion SSE connection established');
      onOpen?.();

      const reader = response.body.getReader();

      try {
        await parseSSEStream(reader, {
          onEvent: (event: SSEEvent) => {
            // Handle error events from the server
            if (event.event === 'error' || event.data.includes('Audio error')) {
              const error = new Error(event.data);
              onError?.(error);
              this.close();
            }
          },
          parseData: async (encryptedData: string) => {
            // Decrypt the data
            const decrypted = await decryptIfValid(
              encryptedData,
              encryptionKey,
              validateNonce
            );
            return decrypted.data;
          },
          onMessage: (decryptedData) => {
            onMessage(decryptedData);
          },
          onError: (error) => {
            console.error('SSE parse/decrypt error:', error);
            onError?.(error);
          },
          shouldContinue: () => this.isActive
        });

        // Stream ended normally
        console.log('Companion SSE stream completed');
        
      } finally {
        reader.releaseLock();
        this.close();
        onClose?.();
      }

    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Connection was manually closed
        console.log('Companion SSE connection aborted');
        return;
      }

      console.error('Companion SSE connection error:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      onError?.(err);
      this.close();
      onClose?.();
    }
  }

  close(): void {
    if (!this.isActive) return;
    
    this.isActive = false;
    
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    
    console.log('Companion SSE connection closed');
  }

  isConnected(): boolean {
    return this.isActive;
  }
}

/**
 * Create a companion SSE connection with encryption support
 * Returns a connection object that can be closed
 */
export async function createCompanionSSEConnection<T>(
  endpoint: string,
  options: CompanionSSEOptions<T>
): Promise<CompanionSSEConnection> {
  const connection = new CompanionSSEConnectionImpl(endpoint, options);
  
  // Start the connection (don't await, let it run in background)
  connection.connect().catch((error) => {
    console.error('Failed to establish companion SSE connection:', error);
  });
  
  return connection;
}
