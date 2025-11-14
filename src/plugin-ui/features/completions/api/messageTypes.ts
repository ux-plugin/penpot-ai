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
  error?: WebSocketError;         // Error message (only for type: "error")
}

export interface WebSocketError {
  code: number;
  message: string;
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

export type AuthRefreshTokenResponse = WebSocketMessage<string> & {
  type: 'auth:refresh_token_response';
}

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
  params: string;
  reasoning: string;
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

/**
 * User: Subscribe Ports Response (Server → Client)
 * Confirmation of port subscription
 */
export type UserSubscribePortsResponseMessage = WebSocketMessage<Record<string, never>> & {
  type: 'user:subscribe_ports_response';
  payload: {};
};

/**
 * User: Unsubscribe Ports Response (Server → Client)
 * Confirmation of port unsubscription
 */
export type UserUnsubscribePortsResponseMessage = WebSocketMessage<Record<string, never>> & {
  type: 'user:unsubscribe_ports_response';
  payload: {};
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
  | AuthRefreshTokenResponse
  | UserSubscribePortsResponseMessage
  | UserUnsubscribePortsResponseMessage;

/**
 * All valid WebSocket message type strings
 */
export type WebSocketMessageType =
  | 'auth:refresh_token'
  | 'auth:refresh_token_response'
  | 'completions:request'
  | 'completions:request_end'
  | 'completions:response'
  | 'completions:response_end'
  | 'user:subscribe_ports'
  | 'user:unsubscribe_ports'
  | 'user:subscribe_ports_response'
  | 'user:unsubscribe_ports_response';