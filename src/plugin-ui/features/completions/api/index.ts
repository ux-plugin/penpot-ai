/**
 * Completions API exports
 * Provides WebSocket functionality for streaming audio to backend completions endpoint
 */

// Export WebSocket adapter and hook
export { CompletionsWebSocketAdapter } from './CompletionsWebSocketAdapter';
export { useCompletionsWebSocket } from './useCompletionsWebSocket';

// Export adapter types
export type { CompletionsWebSocketCallbacks } from './CompletionsWebSocketAdapter';
export type { UseCompletionsWebSocketOptions, UseCompletionsWebSocketReturn } from './useCompletionsWebSocket';

// Export all AsyncAPI 3.0.0 message types
export type {
  WebSocketMessage,
  WebSocketMessageType,
  // Auth messages
  AuthRefreshTokenPayload,
  AuthRefreshTokenMessage,
  // Completions messages
  CompletionsRequestPayload,
  CompletionsRequestMessage,
  CompletionsRequestEndPayload,
  CompletionsRequestEndMessage,
  CompletionsResponsePayload,
  CompletionsResponseMessage,
  CompletionsResponseEndPayload,
  CompletionsResponseEndMessage,
  // User messages
  UserSubscribePortsMessage,
  UserUnsubscribePortsMessage,
  // System messages
  AcknowledgmentPayload,
  AcknowledgmentMessage,
  ErrorMessage,
  // Union types
  ClientMessage,
  ServerMessage,
} from './messageTypes';
