/**
 * SharedWebSocketClient - Unified WebSocket client for backend communication
 * 
 * Handles connection to /ws endpoint with JWT authentication
 * Supports event subscription pattern for different message types
 */

import { resolveBackendUrl } from '@auth/api/utils';
import { useAuthenticationStore } from '@auth/stores/useAuthenticationStore';

export type WebSocketEventType = 'user:port_update' | string;

export interface WebSocketMessage {
  event: WebSocketEventType;
  data?: any;
}

export interface WebSocketClientOptions {
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectDecayFactor?: number;
  maxReconnectAttempts?: number;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
}

type MessageHandler = (data: any) => void;

const DEFAULT_OPTIONS: WebSocketClientOptions = {
  reconnectDelay: 1000, // 1 second
  maxReconnectDelay: 30000, // 30 seconds
  reconnectDecayFactor: 1.5,
  maxReconnectAttempts: 10,
};

/**
 * Shared WebSocket client for backend communication
 */
export class SharedWebSocketClient {
  private ws: WebSocket | null = null;
  private options: WebSocketClientOptions;
  private messageHandlers: Map<WebSocketEventType, Set<MessageHandler>> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimeout: number | null = null;
  private shouldReconnect = false;
  private isManualClose = false;

  constructor(options: WebSocketClientOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Build WebSocket URL from backend environment variable
   */
  private buildWebSocketUrl(): string {
    const backendUrl = resolveBackendUrl();
    // Convert http(s):// to ws(s)://
    const wsUrl = backendUrl.replace(/^http/, 'ws');
    return `${wsUrl}/ws`;
  }

  /**
   * Get JWT token from auth store
   */
  private getJwtToken(): string | null {
    return useAuthenticationStore.getState().accessToken;
  }

  /**
   * Connect to the WebSocket endpoint with JWT authentication
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.buildWebSocketUrl();
        const jwtToken = this.getJwtToken();

        if (!jwtToken) {
          reject(new Error('No JWT token available'));
          return;
        }

        console.log('🔌 Connecting to shared WebSocket:', wsUrl);

        // Create WebSocket with JWT token in the URL as a query parameter
        // Note: WebSocket doesn't support custom headers in browser, so we use query param
        const urlWithAuth = `${wsUrl}?token=${encodeURIComponent(jwtToken)}`;
        this.ws = new WebSocket(urlWithAuth);
        this.isManualClose = false;
        this.shouldReconnect = true;

        // Set up event handlers
        this.ws.onopen = () => {
          console.log('✅ WebSocket connected successfully');
          this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
          this.options.onOpen?.();
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = (event) => {
          console.log('🔌 WebSocket closed:', event.code, event.reason);
          this.options.onClose?.();

          // Only attempt reconnect if not manually closed and haven't exceeded max attempts
          if (
            !this.isManualClose &&
            this.shouldReconnect &&
            this.reconnectAttempts < this.options.maxReconnectAttempts!
          ) {
            this.attemptReconnect();
          }
        };

        this.ws.onerror = (event) => {
          console.error('❌ WebSocket error:', event);
          this.options.onError?.(event);
          reject(new Error('WebSocket connection failed'));
        };
      } catch (error) {
        console.error('❌ Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  private attemptReconnect(): void {
    this.reconnectAttempts++;
    const delay =
      Math.min(
        this.options.reconnectDelay! * Math.pow(this.options.reconnectDecayFactor!, this.reconnectAttempts - 1),
        this.options.maxReconnectDelay!
      );

    console.log(`🔄 Attempting reconnect ${this.reconnectAttempts}/${this.options.maxReconnectAttempts} in ${delay}ms...`);

    this.reconnectTimeout = window.setTimeout(() => {
      this.connect().catch((error) => {
        console.error('❌ Reconnection failed:', error);
      });
    }, delay);
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: string): void {
    try {
      const message: WebSocketMessage = JSON.parse(data);
      console.log('📨 Received message:', message);

      if (message.event) {
        this.routeMessage(message.event, message.data);
      }
    } catch (error) {
      console.error('❌ Failed to parse WebSocket message:', error);
    }
  }

  /**
   * Route message to registered handlers
   */
  private routeMessage(eventType: WebSocketEventType, data: any): void {
    const handlers = this.messageHandlers.get(eventType);

    if (handlers && handlers.size > 0) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in message handler for event ${eventType}:`, error);
        }
      });
    }
  }

  /**
   * Subscribe to messages of a specific event type
   * Returns unsubscribe function
   */
  on(eventType: WebSocketEventType, handler: MessageHandler): () => void {
    if (!this.messageHandlers.has(eventType)) {
      this.messageHandlers.set(eventType, new Set());
    }

    this.messageHandlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.messageHandlers.get(eventType)?.delete(handler);
    };
  }

  /**
   * Send a message to the WebSocket
   */
  send(message: WebSocketMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ WebSocket is not open, cannot send message');
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
      console.log('📤 Sent message:', message);
    } catch (error) {
      console.error('❌ Failed to send message:', error);
      this.options.onError?.(error as Event);
    }
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    if (!this.ws) {
      console.warn('⚠️ WebSocket already closed or not initialized');
      return;
    }

    console.log('🔌 Closing WebSocket connection...');
    this.isManualClose = true;
    this.shouldReconnect = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Close with normal closure code
    this.ws.close(1000, 'Normal closure');
    this.ws = null;
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get current connection state
   */
  getReadyState(): number | null {
    return this.ws?.readyState ?? null;
  }
}
