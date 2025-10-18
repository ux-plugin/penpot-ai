/**
 * Completions API exports
 * Provides WebSocket functionality for streaming audio to backend completions endpoint
 */

// Export WebSocket manager and hook
export { CompletionsWebSocketManager } from './CompletionsWebSocketManager';
export { useCompletionsWebSocket } from './useCompletionsWebSocket';

// Export types
export type { AudioChunkMessage, WebSocketCallbacks } from './CompletionsWebSocketManager';
export type { UseCompletionsWebSocketOptions, UseCompletionsWebSocketReturn } from './useCompletionsWebSocket';
