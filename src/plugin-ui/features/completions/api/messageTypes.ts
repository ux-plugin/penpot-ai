/**
 * AsyncAPI 3.0.0 WebSocket Message Types
 * 
 * All messages follow the unified structure:
 * {
 *   type: string (namespaced),
 *   payload: object,
 *   requestId?: string,
 *   error?: string (for error messages)
 * }
 */

/**
 * Base WebSocket message wrapper (all messages follow this structure)
 */
export interface WebSocketMessage<T = any> {
  type: string;           // Namespaced type (e.g., "completions:request")
  payload: T;             // Message-specific payload
  requestId?: string;     // Optional correlation ID
  error?: string;         // Error message (only for type: "error")
}

// ============================================================================
// AUTH MESSAGES
// ============================================================================

/**
 * Auth: Refresh Token (Client → Server)
 */
export interface AuthRefreshTokenPayload {
  access_token: string;
}

export type AuthRefreshTokenMessage = WebSocketMessage<AuthRefreshTokenPayload> & {
  type: 'auth:refresh_token';
};

// ============================================================================
// COMPLETIONS MESSAGES
// ============================================================================

/**
 * Completions: Request (Client → Server)
 * Streams drawing and audio data
 */
export interface CompletionsRequestPayload {
  fe_id: string;
  drawn_path: string;
  audio_chunk: string;
  timestamp: number;
}

export type CompletionsRequestMessage = WebSocketMessage<CompletionsRequestPayload> & {
  type: 'completions:request';
};

/**
 * Completions: Request End (Client → Server)
 * Signals end of request stream
 */
export interface CompletionsRequestEndPayload {
  fe_id: string;
}

export type CompletionsRequestEndMessage = WebSocketMessage<CompletionsRequestEndPayload> & {
  type: 'completions:request_end';
};

/**
 * Completions: Response (Server → Client)
 * AI-generated component action
 */
export interface CompletionsResponsePayload {
  fe_id: string;
  action: 'create_node' | 'set_property' | 'set_text' | 'set_style' | 'add_constraint';
  target: string;
  params: string; // JSON-encoded action parameters
}

export type CompletionsResponseMessage = WebSocketMessage<CompletionsResponsePayload> & {
  type: 'completions:response';
};

/**
 * Completions: Response End (Server → Client)
 * Signals end of response stream
 */
export interface CompletionsResponseEndPayload {
  fe_id: string;
}

export type CompletionsResponseEndMessage = WebSocketMessage<CompletionsResponseEndPayload> & {
  type: 'completions:response_end';
};

// ============================================================================
// USER MESSAGES
// ============================================================================

/**
 * User: Subscribe Ports (Client → Server)
 * Subscribe to port configuration updates
 */
export type UserSubscribePortsMessage = WebSocketMessage<Record<string, never>> & {
  type: 'user:subscribe_ports';
  payload: {};
};

/**
 * User: Unsubscribe Ports (Client → Server)
 * Unsubscribe from port configuration updates
 */
export type UserUnsubscribePortsMessage = WebSocketMessage<Record<string, never>> & {
  type: 'user:unsubscribe_ports';
  payload: {};
};

// ============================================================================
// SYSTEM MESSAGES
// ============================================================================

/**
 * Acknowledgment (Server → Client)
 * Command acknowledgment with status
 */
export interface AcknowledgmentPayload {
  status: 'ok' | 'error';
  expires_at?: number;  // For auth:refresh_token acknowledgments (Unix seconds)
  fe_id?: string;       // For completions acknowledgments
}

export type AcknowledgmentMessage = WebSocketMessage<AcknowledgmentPayload> & {
  type: 'ack' | 'auth:refresh_token'; // Can echo original type or be generic 'ack'
};

/**
 * Error (Server → Client)
 * Error response from server
 */
export type ErrorMessage = WebSocketMessage<Record<string, never>> & {
  type: 'error';
  payload: {};
  error: string;
};

// ============================================================================
// UNION TYPES
// ============================================================================

/**
 * All possible message types that can be sent from client to server
 */
export type ClientMessage =
  | AuthRefreshTokenMessage
  | CompletionsRequestMessage
  | CompletionsRequestEndMessage
  | UserSubscribePortsMessage
  | UserUnsubscribePortsMessage;

/**
 * All possible message types that can be received from server
 */
export type ServerMessage =
  | CompletionsResponseMessage
  | CompletionsResponseEndMessage
  | AcknowledgmentMessage
  | ErrorMessage;

/**
 * All valid WebSocket message type strings
 */
export type WebSocketMessageType =
  | 'auth:refresh_token'
  | 'completions:request'
  | 'completions:request_end'
  | 'completions:response'
  | 'completions:response_end'
  | 'user:subscribe_ports'
  | 'user:unsubscribe_ports'
  | 'ack'
  | 'error';