/**
 * Completions WebSocket adapter using the shared WebSocket infrastructure
 * 
 * Replaces CompletionsWebSocketManager to use the unified /ws endpoint
 */

import { getSharedWebSocket } from '@shared/api/SharedWebSocketClient';

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

export interface CompletionsWebSocketCallbacks {
  onOpen?: () => void;
  onMessage?: (data: any) => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
}

/**
 * Adapter for completions that uses the shared WebSocket instance
 */
export class CompletionsWebSocketAdapter {
  private callbacks: CompletionsWebSocketCallbacks;
  private currentFeId: string | null = null;
  private unsubscribeCallbacks: (() => void)[] = [];

  constructor(callbacks: CompletionsWebSocketCallbacks = {}) {
    this.callbacks = callbacks;
    this.setupWebSocket();
  }

  /**
   * Set up WebSocket event subscriptions
   */
  private setupWebSocket(): void {
    const wsClient = getSharedWebSocket();

    // Subscribe to connection events
    const unsubOpen = wsClient.onOpen(() => {
      console.log('✅ Completions: WebSocket connected');
      this.callbacks.onOpen?.();
    });

    const unsubClose = wsClient.onClose(() => {
      console.log('🔌 Completions: WebSocket closed');
      this.callbacks.onClose?.();
    });

    const unsubError = wsClient.onError((event) => {
      console.error('❌ Completions: WebSocket error:', event);
      this.callbacks.onError?.(event);
    });

    // Subscribe to completion response messages
    const unsubResponse = wsClient.on('completion_response', (data) => {
      console.log('📨 Completions: Received response:', data);
      this.callbacks.onMessage?.(JSON.stringify(data));
    });

    // Subscribe to completion acknowledgment messages
    const unsubAck = wsClient.on('completion_acknowledgment', (data) => {
      console.log('📨 Completions: Received acknowledgment:', data);
      this.callbacks.onMessage?.(JSON.stringify(data));
    });

    // Store unsubscribe functions
    this.unsubscribeCallbacks = [unsubOpen, unsubClose, unsubError, unsubResponse, unsubAck];
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
   * Connect to the WebSocket endpoint
   */
  async connect(): Promise<void> {
    const wsClient = getSharedWebSocket();
    return wsClient.connect();
  }

  /**
   * Send an audio chunk to the WebSocket
   */
  sendAudioChunk(base64Audio: string): void {
    const wsClient = getSharedWebSocket();

    if (!wsClient.isConnected()) {
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

    wsClient.send(message);
    console.log('📤 Sent audio chunk:', {
      event: message.event,
      fe_id: message.fe_id,
      timestamp: message.timestamp,
      audioLength: base64Audio.length
    });
  }

  /**
   * Send completion_request_end to signal end of recording
   */
  endSession(): void {
    const wsClient = getSharedWebSocket();

    if (!wsClient.isConnected()) {
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

    wsClient.send(message);
    console.log('🏁 Sent completion_request_end:', { fe_id: message.fe_id });
    this.currentFeId = null; // Clear the session
  }

  /**
   * Clean up subscriptions (doesn't close the shared WebSocket)
   */
  close(): void {
    console.log('🔌 Cleaning up completions subscriptions...');

    // End session if one is active
    if (this.currentFeId) {
      this.endSession();
    }

    // Unsubscribe from all events
    this.unsubscribeCallbacks.forEach(unsub => unsub());
    this.unsubscribeCallbacks = [];

    console.log('✅ Completions cleanup done (shared WebSocket remains open)');
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    const wsClient = getSharedWebSocket();
    return wsClient.isConnected();
  }

  /**
   * Get current connection state
   */
  getReadyState(): number | null {
    const wsClient = getSharedWebSocket();
    return wsClient.getReadyState();
  }
}
