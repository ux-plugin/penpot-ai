/**
 * Completions API exports
 * Provides RSocket-based functionality for streaming audio to backend completions endpoint
 */

// Export provider and hooks
export { CompletionsWebSocketProvider, useCompletionsWebSocketContext } from './CompletionsWebSocketProvider.tsx';
export { useCompletionsWebSocket } from './useCompletionsWebSocket.ts';

// Export hook types
export type { UseCompletionsWebSocketOptions, UseCompletionsWebSocketReturn } from './useCompletionsWebSocket.ts';

// Export all RSocket payload types
export type {
  // Auth payloads
  AuthRefreshTokenPayload,
  AuthRefreshTokenResponsePayload,
  // Completions payloads
  CompletionsRequestPayload,
  CompletionAction,
  CompletionsResponsePayload,
  // User payloads
  UserSubscribePortsPayload,
  UserUnsubscribePortsPayload,
  UserSubscribePortsResponsePayload,
  UserUnsubscribePortsResponsePayload,
} from './messageTypes.ts';
