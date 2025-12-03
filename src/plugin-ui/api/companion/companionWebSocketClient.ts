/**
 * WebSocket client for companion app communication
 * Handles persistent WebSocket connection with encrypted messaging
 */

import { decryptMessage, validateTimestamp, createCompanionMessage } from './encryption.ts';
import type { 
  WebSocketCommand, 
  WebSocketResponseType, 
  DecryptedPayload,
  WebSocketResponse
} from './websocketMessageTypes.ts';
import { encryptionKeyManager } from '@api/companion/EncryptionKeyManager.ts';
import { nonceManager } from '@/plugin-ui/api/NonceManager.ts';
import { useCompanionStore } from '@/plugin-ui/stores/useCompanionStore.ts';

export enum WebSocketState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  CLOSING = 'CLOSING',
  CLOSED = 'CLOSED'
}

type MessageHandler = (data: any) => void;

interface WebSocketClientConfig {
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectDecayFactor?: number;
  maxReconnectAttempts?: number;
  commandTimeout?: number;
}

const DEFAULT_CONFIG: WebSocketClientConfig = {
  reconnectDelay: 1000, // 1 second
  maxReconnectDelay: 30000, // 30 seconds
  reconnectDecayFactor: 1.5,
  maxReconnectAttempts: 10,
  commandTimeout: 10000 // 10 seconds
};

type ResolveFunction<T = any> = (value: T) => void;
type RejectFunction = (reason: any) => void;

/**
 * WebSocket client for companion app
 * Manages connection, encryption, message routing, and request/response correlation
 */
export class CompanionWebSocketClient {
  private ws: WebSocket | null = null;
  private messageHandlers: Map<WebSocketResponseType, Set<MessageHandler>> = new Map();
  private config: WebSocketClientConfig;
  
  // Request/response correlation
  private pendingRequests: Map<string, { 
    resolve: ResolveFunction<any>, 
    reject: RejectFunction,
    timeout: number
  }> = new Map();
  private nextRequestId: number = 1;
  
  // Reconnection state
  private reconnectTimeout: number | null = null;

  constructor(config: WebSocketClientConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate a received nonce
   * Returns false if nonce has already been seen, true otherwise
   */
  private validateNonce(nonce: Uint8Array): boolean {
    if (nonceManager.hasNonce(nonce)) {
      return false;
    }
    nonceManager.addNonce(nonce);
    return true;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `ws_${Date.now()}_${this.nextRequestId++}`;
  }

  /**
   * Get current connection state from store
   */
  getState(): WebSocketState {
    return useCompanionStore.getState().webSocketState;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    const state = useCompanionStore.getState().webSocketState;
    return state === WebSocketState.CONNECTED && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to a companion app WebSocket
   * Automatically sends init command after connection
   */
  async connect(port: number): Promise<void> {
    const currentState = useCompanionStore.getState().webSocketState;
    if (currentState === WebSocketState.CONNECTING || currentState === WebSocketState.CONNECTED) {
      console.warn('WebSocket already connecting or connected');
      return;
    }

    try {
      this.setState(WebSocketState.CONNECTING);

      await encryptionKeyManager.ensureValidKey();

      const url = `ws://localhost:${port}/companion`;
      console.log(`Connecting to companion WebSocket: ${url}`);
      
      this.ws = new WebSocket(url);

      await new Promise<void>((resolve, reject) => {
        const openHandler = () => {
          console.log('WebSocket connection opened');
          cleanup();
          resolve();
        };

        const errorHandler = (event: Event) => {
          console.error('WebSocket connection error:', event);
          cleanup();
          reject(new Error('WebSocket connection error'));
        };

        const cleanup = () => {
          this.ws?.removeEventListener('open', openHandler);
          this.ws?.removeEventListener('error', errorHandler);
        };

        this.ws!.addEventListener('open', openHandler);
        this.ws!.addEventListener('error', errorHandler);
      });

      // Set up message and close handlers
      this.ws!.onmessage = async (event) => {
        await this.handleMessage(event.data);
      };

      this.ws!.onerror = (event) => {
        console.error('WebSocket error:', event);
      };

      this.ws!.onclose = (event) => {
        console.log(`WebSocket closed: code=${event.code}, reason=${event.reason}`);
        this.handleDisconnect();
      };

      // Send init command and wait for response
      console.log('Sending init command...');
      await this.sendCommand('init');
      console.log('Init command acknowledged');
      
      // Mark as fully connected after successful init
      this.setState(WebSocketState.CONNECTED);

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setState(WebSocketState.DISCONNECTED);
      
      // Clean up WebSocket on failure
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      
      throw err;
    }
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Reject all pending requests
    for (const [, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('WebSocket connection closed'));
    }
    this.pendingRequests.clear();

    if (this.ws) {
      this.setState(WebSocketState.CLOSING);
      this.ws.close(1000, 'Client closing connection');
      this.ws = null;
    }

    this.setState(WebSocketState.CLOSED);
  }

  /**
   * Send a command to the companion app and wait for response
   * Returns a promise that resolves with the response data
   */
  async sendCommand(command: WebSocketCommand, data?: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const encryptionKey = encryptionKeyManager.getKey();
    if (!encryptionKey) {
      throw new Error('No valid encryption key available');
    }

    const requestId = this.generateRequestId();

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Command timeout: ${command} (${this.config.commandTimeout}ms)`));
      }, this.config.commandTimeout) as unknown as number;

      // Store pending request
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout
      });

      // Create request payload with optional data
      const requestPayload = JSON.stringify({
        id: requestId,
        command: command,
        ...(data && { data })
      });

      // Generate nonce and encrypt
      const nonce = nonceManager.generateNonce();
      
      createCompanionMessage(requestPayload, encryptionKey, nonce)
        .then(encryptedMessage => {
          // Send the encrypted message
          this.ws!.send(encryptedMessage);
          console.log(`Sent command: ${command} (id: ${requestId})${data ? ' with data' : ''}`);
        })
        .catch(error => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          reject(error);
        });
    });
  }

  /**
   * Rotate encryption key with the companion app
   * 1. Generates NEW key via backend
   * 2. Sends init command with new key to companion app
   * 3. Waits for confirmation
   */
  async rotateKey(): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Cannot rotate key: WebSocket not connected');
    }

    console.log('Starting key rotation...');
    
    try {
      // Step 1: Generate NEW key from backend
      await encryptionKeyManager.generateKey();
      console.log('New encryption key generated from backend');
      
      // Step 2: Send init command with a new key (encryption happens automatically)
      await this.sendCommand('init');
      console.log('Init command sent with new key');
      
      console.log('Key rotation completed successfully');
      
    } catch (error) {
      console.error('Key rotation failed:', error);
      throw new Error(`Key rotation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Subscribe to messages of a specific type
   * Returns unsubscribe function
   */
  on(messageType: WebSocketResponseType, handler: MessageHandler): () => void {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, new Set());
    }
    
    this.messageHandlers.get(messageType)!.add(handler);
    
    // Return unsubscribe function
    return () => {
      this.messageHandlers.get(messageType)?.delete(handler);
    };
  }

  /**
   * Handle incoming WebSocket message
   */
  private async handleMessage(data: string): Promise<void> {
    const encryptionKey = encryptionKeyManager.getKey();
    if (!encryptionKey) {
      console.error('Cannot process message: no encryption key available');
      return;
    }

    try {
      // Decrypt the message
      const decrypted = await decryptMessage(encryptionKey, data);
      
      // Validate nonce (prevents replay attacks)
      if (!this.validateNonce(decrypted.nonce)) {
        throw new Error('Invalid or replayed nonce');
      }
      
      // Validate timestamp
      if (!validateTimestamp(decrypted.timestamp_ms)) {
        throw new Error('Message timestamp outside acceptable range');
      }
      
      // Parse the decrypted data
      const payload: DecryptedPayload = JSON.parse(decrypted.data);
      
      // Check if this is a response (has 'type' field)
      if ('type' in payload) {
        const response = payload as WebSocketResponse;
        
        // Check if this is a response to a pending request
        const pendingRequest = this.pendingRequests.get(response.id);
        
        if (pendingRequest) {
          // Clear timeout
          clearTimeout(pendingRequest.timeout);
          this.pendingRequests.delete(response.id);
          
          // Handle error responses
          if (response.type === 'error') {
            pendingRequest.reject(new Error(response.data?.message || 'Request failed'));
          } else {
            // Resolve with the response data
            pendingRequest.resolve(response.data);
          }
        }
        
        // Also route to message handlers (for streaming responses like audio-chunk)
        this.routeMessage(response.type, response.data);
      } else {
        console.warn('Received unexpected message format:', payload);
      }
      
    } catch (error) {
      console.error('Failed to process WebSocket message:', error);
    }
  }

  /**
   * Route message to registered handlers
   */
  private routeMessage(type: WebSocketResponseType, data: any): void {
    const handlers = this.messageHandlers.get(type);
    
    if (handlers && handlers.size > 0) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in message handler for type ${type}:`, error);
        }
      });
    }
  }

  /**
   * Update connection state in store
   */
  private setState(newState: WebSocketState): void {
    const store = useCompanionStore.getState();
    const currentState = store.webSocketState;
    
    if (currentState === newState) return;
    
    console.log(`WebSocket state: ${currentState} → ${newState}`);
    store.setWebSocketState(newState);
  }

  /**
   * Handle WebSocket disconnection
   */
  private handleDisconnect(): void {
    this.ws = null;
    
    // Reject all pending requests
    for (const [, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('WebSocket connection closed'));
    }
    this.pendingRequests.clear();
    
    const currentState = useCompanionStore.getState().webSocketState;
    if (currentState === WebSocketState.CLOSING || currentState === WebSocketState.CLOSED) {
      // Normal closure, don't reconnect
      this.setState(WebSocketState.CLOSED);
      return;
    }

    this.setState(WebSocketState.DISCONNECTED);
  }
}
