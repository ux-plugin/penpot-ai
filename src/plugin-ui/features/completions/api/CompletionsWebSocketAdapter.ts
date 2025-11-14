/**
 * Completions WebSocket adapter using the shared WebSocket infrastructure
 * 
 * Uses the unified /ws endpoint with AsyncAPI 3.0.0 message format
 */

import { getSharedWebSocket } from '@shared/api/SharedWebSocketClient';
import type {
  CompletionsRequestPayload,
  CompletionsRequestEndPayload,
  CompletionsResponseMessage,
  CompletionsResponseEndMessage,
  AuthRefreshTokenPayload,
} from './messageTypes';

/**
 * Callbacks for handling completions WebSocket events
 */
export interface CompletionsWebSocketCallbacks {
  // Connection events
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
  onMessage?: (message: any) => void;
  
  // Action handlers (from completions:response)
  onCreateNode?: (target: string, params: any) => void;
  onSetProperty?: (target: string, params: any) => void;
  onSetText?: (target: string, params: any) => void;
  onSetStyle?: (target: string, params: any) => void;
  onAddConstraint?: (target: string, params: any) => void;
  
  // Session events
  onCompletionEnd?: (feId: string) => void;
  onCompletionResponse?: (response: CompletionsResponseMessage) => void;
  
  // Token management
  onTokenRefreshResponse?: () => void;
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

    const unsubError = wsClient.onError((error) => {
      console.error('❌ Completions: WebSocket error:', error);
      this.callbacks.onError?.(error);
    });

    // Subscribe to completions:response messages (AI actions)
    const unsubResponse = wsClient.on('completions:response', (message) => {
      console.log('📨 Completions: Received response:', message);
      this.handleCompletionResponse(message as CompletionsResponseMessage);
    });

    // Subscribe to completions:response_end messages
    const unsubResponseEnd = wsClient.on('completions:response_end', (message) => {
      console.log('🏁 Completions: Response stream ended:', message);
      this.handleCompletionEnd(message as CompletionsResponseEndMessage);
    });

    // Subscribe to auth:refresh_token_response messages
    const unsubAuthRefresh = wsClient.on('auth:refresh_token_response', (message) => {
      console.log('🔄 Completions: Token refresh response received:', message);
      this.callbacks.onTokenRefreshResponse?.();
    });

    // Store unsubscribe functions
    this.unsubscribeCallbacks = [
      unsubOpen,
      unsubClose,
      unsubError,
      unsubResponse,
      unsubResponseEnd,
      unsubAuthRefresh,
    ];
  }

  /**
   * Handle completions:response message (AI-generated actions)
   */
  private handleCompletionResponse(message: CompletionsResponseMessage): void {
    if (message.error) {
      console.error('❌ Completions: Error in response:', message.error);
      this.callbacks.onError?.(new Error('Completions response error'));
      return;
    }

    // Notify about the response (this includes successful acknowledgments)
    this.callbacks.onCompletionResponse?.(message);

    const { action, target, params, reasoning } = message.payload;
    console.log(`🧠 Reasoning: ${reasoning}`);

    if (params === '') {
      console.warn('⚠️ Completions: Empty params received');
      return;
    }
    try {
      const parsedParams = JSON.parse(params);
      
      console.log(`🎬 Action: ${action} on target: ${target}`, parsedParams);
      
      // Call appropriate callback based on action type
      switch (action) {
        case 'create_node':
          this.callbacks.onCreateNode?.(target, parsedParams);
          break;
        case 'set_property':
          this.callbacks.onSetProperty?.(target, parsedParams);
          break;
        case 'set_text':
          this.callbacks.onSetText?.(target, parsedParams);
          break;
        case 'set_style':
          this.callbacks.onSetStyle?.(target, parsedParams);
          break;
        case 'add_constraint':
          this.callbacks.onAddConstraint?.(target, parsedParams);
          break;
        default:
          console.warn('⚠️ Unknown action type:', action);
      }
    } catch (error) {
      console.error('❌ Failed to parse action params:', error);
      this.callbacks.onError?.(new Error(`Failed to parse action params: ${error}`));
    }
  }

  /**
   * Handle completions:response_end message (end of stream)
   */
  private handleCompletionEnd(message: CompletionsResponseEndMessage): void {
    const { fe_id } = message.payload;
    console.log('🎉 All completions finished for session:', fe_id);
    
    this.callbacks.onCompletionEnd?.(fe_id);
    
    // Clear session if it matches current
    if (this.currentFeId === fe_id) {
      this.currentFeId = null;
    }
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
   * Uses AsyncAPI 3.0.0 format: { type: "completions:request", payload: {...} }
   */
  sendAudioChunk(base64Audio: string, drawnPath: string = ''): void {
    const wsClient = getSharedWebSocket();

    if (!wsClient.isConnected()) {
      console.warn('⚠️ WebSocket is not open, cannot send audio chunk');
      return;
    }

    if (!this.currentFeId) {
      console.error('❌ No active session. Call startSession() first.');
      return;
    }

    const payload: CompletionsRequestPayload = {
      fe_id: this.currentFeId,
      drawn_path: drawnPath,
      audio_chunk: base64Audio,
      timestamp: Date.now()
    };

    wsClient.send('completions:request', payload);
    
    console.log('📤 Sent audio chunk:', {
      type: 'completions:request',
      fe_id: payload.fe_id,
      timestamp: payload.timestamp,
      audioLength: base64Audio.length,
      pathLength: drawnPath.length
    });
  }

  /**
   * Send completions:request_end to signal end of recording
   * Uses AsyncAPI 3.0.0 format
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

    const payload: CompletionsRequestEndPayload = {
      fe_id: this.currentFeId
    };

    wsClient.send('completions:request_end', payload);
    
    console.log('🏁 Sent completions:request_end:', { fe_id: payload.fe_id });
    this.currentFeId = null; // Clear the session
  }

  /**
   * Refresh JWT token without reconnecting
   * Uses AsyncAPI 3.0.0 format
   */
  refreshToken(newAccessToken: string): void {
    const wsClient = getSharedWebSocket();
    
    if (!wsClient.isConnected()) {
      console.warn('⚠️ WebSocket not connected, cannot refresh token');
      return;
    }
    
    const payload: AuthRefreshTokenPayload = {
      access_token: newAccessToken
    };
    
    wsClient.send('auth:refresh_token', payload);
    
    console.log('🔄 Sent token refresh request');
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

  /**
   * Get current session fe_id (if any)
   */
  getCurrentFeId(): string | null {
    return this.currentFeId;
  }
}
