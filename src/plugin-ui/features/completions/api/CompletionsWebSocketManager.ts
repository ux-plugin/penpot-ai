/**
 * CompletionsWebSocketManager - Manages WebSocket connection to backend completions endpoint
 * 
 * Responsibilities:
 * - Establishes WebSocket connection with JWT authentication
 * - Sends audio chunks in the correct format
 * - Handles connection lifecycle (open, close, error)
 * - Provides status callbacks for connection state
 */

import { resolveBackendUrl } from '@auth/api/utils';

/**
 * Message format for completion_request command
 * Matches backend AsyncAPI specification
 */
export interface CompletionRequestMessage {
  event: 'completion_request';
  fe_id: string;
  drawn_path: string;
  audio_chunk: string;
  timestamp: number;
}

/**
 * Message format for completion_request_end command
 */
export interface CompletionRequestEndMessage {
  event: 'completion_request_end';
  fe_id: string;
}

export interface WebSocketCallbacks {
  onOpen?: () => void;
  onMessage?: (data: string) => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
}

export class CompletionsWebSocketManager {
  private ws: WebSocket | null = null;
  private jwtToken: string;
  private callbacks: WebSocketCallbacks;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectDelay = 1000; // Start with 1 second
  private isManualClose = false;
  private currentFeId: string | null = null;

  constructor(jwtToken: string, callbacks: WebSocketCallbacks = {}) {
    this.jwtToken = jwtToken;
    this.callbacks = callbacks;
  }

  /**
   * Generate a unique frontend ID for correlating request/response messages
   */
  private generateFeId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Start a new recording session with a fresh fe_id
   */
  startSession(): string {
    this.currentFeId = this.generateFeId();
    console.log('🎬 Started new session with fe_id:', this.currentFeId);
    return this.currentFeId;
  }

  /**
   * Build WebSocket URL from backend environment variable
   */
  private buildWebSocketUrl(): string {
    const backendUrl = resolveBackendUrl(); // Gets VITE_BACKEND_URL
    // Convert http(s):// to ws(s)://
    const wsUrl = backendUrl.replace(/^http/, 'ws');
    return `${wsUrl}/completions/create`;
  }

  /**
   * Connect to the WebSocket endpoint with JWT authentication
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.buildWebSocketUrl();
        console.log('🔌 Connecting to completions WebSocket:', wsUrl);
        
        // Create WebSocket with JWT token in the URL as a query parameter
        // Note: WebSocket doesn't support custom headers in browser, so we use query param
        const urlWithAuth = `${wsUrl}?token=${encodeURIComponent(this.jwtToken)}`;
        this.ws = new WebSocket(urlWithAuth);
        
        // Set up event handlers
        this.ws.onopen = () => {
          console.log('✅ WebSocket connected successfully');
          this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
          this.callbacks.onOpen?.();
          resolve();
        };

        this.ws.onmessage = (event) => {
          console.log('📨 Received message:', event.data);
          this.callbacks.onMessage?.(event.data);
        };

        this.ws.onclose = (event) => {
          console.log('🔌 WebSocket closed:', event.code, event.reason);
          this.callbacks.onClose?.();
          
          // Only attempt reconnect if not manually closed and haven't exceeded max attempts
          if (!this.isManualClose && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.attemptReconnect();
          }
        };

        this.ws.onerror = (event) => {
          console.error('❌ WebSocket error:', event);
          this.callbacks.onError?.(event);
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
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`🔄 Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);
    
    setTimeout(() => {
      this.connect().catch(error => {
        console.error('❌ Reconnection failed:', error);
      });
    }, delay);
  }

  /**
   * Send an audio chunk to the WebSocket
   */
  sendAudioChunk(base64Audio: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ WebSocket is not open, cannot send audio chunk');
      return;
    }

    if (!this.currentFeId) {
      console.error('❌ No active session. Call startSession() first.');
      return;
    }

    const message: CompletionRequestMessage = {
      event: 'completion_request',
      fe_id: this.currentFeId,
      drawn_path: '', // Empty for now, can be populated later if drawing is added
      audio_chunk: base64Audio,
      timestamp: Date.now()
    };

    try {
      this.ws.send(JSON.stringify(message));
      console.log('📤 Sent audio chunk:', { 
        event: message.event,
        fe_id: message.fe_id,
        timestamp: message.timestamp, 
        audioLength: base64Audio.length 
      });
    } catch (error) {
      console.error('❌ Failed to send audio chunk:', error);
      this.callbacks.onError?.(error as Event);
    }
  }

  /**
   * Send completion_request_end to signal end of recording
   */
  endSession(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ WebSocket is not open, cannot send end message');
      return;
    }

    if (!this.currentFeId) {
      console.warn('⚠️ No active session to end');
      return;
    }

    const message: CompletionRequestEndMessage = {
      event: 'completion_request_end',
      fe_id: this.currentFeId
    };

    try {
      this.ws.send(JSON.stringify(message));
      console.log('🏁 Sent completion_request_end:', { fe_id: message.fe_id });
      this.currentFeId = null; // Clear the session
    } catch (error) {
      console.error('❌ Failed to send end message:', error);
      this.callbacks.onError?.(error as Event);
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
    
    // End session if one is active
    if (this.currentFeId) {
      this.endSession();
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
