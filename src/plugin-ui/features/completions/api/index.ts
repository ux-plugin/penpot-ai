/**
 * Completions API exports
 * Provides WebSocket functionality for streaming audio to backend completions endpoint
 */

// Export WebSocket adapter and hook
export { CompletionsWebSocketAdapter } from './CompletionsWebSocketAdapter';
export { useCompletionsWebSocket } from './useCompletionsWebSocket';

// Export types
export type { 
  CompletionRequestMessage, 
  CompletionRequestEndMessage, 
  CompletionsWebSocketCallbacks 
} from './CompletionsWebSocketAdapter';
export type { UseCompletionsWebSocketOptions, UseCompletionsWebSocketReturn } from './useCompletionsWebSocket';
