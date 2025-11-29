/**
 * useCompletionsWebSocket - Hook for accessing the shared WebSocket connection
 * 
 * This hook now consumes the CompletionsWebSocketProvider context, ensuring
 * that only one WebSocket connection exists regardless of how many components
 * use this hook.
 * 
 * Features:
 * - Access to shared WebSocket connection
 * - Automatic callback registration/cleanup
 * - Same API as before for backward compatibility
 */

import { useEffect, useRef } from 'react';
import { useCompletionsWebSocketContext } from './CompletionsWebSocketProvider.tsx';
import type { UseCompletionsWebSocketOptions as ProviderOptions } from './CompletionsWebSocketProvider.tsx';

// Re-export the interface from the provider for consistency
export type UseCompletionsWebSocketOptions = ProviderOptions;

export interface UseCompletionsWebSocketReturn {
  // Recording control
  startRecordingAndStreaming: () => Promise<void>;
  stopRecordingAndStreaming: () => void;
  
  // Status
  isRecording: boolean;
  isWebSocketConnected: boolean;
  
  // Errors
  recordingError: Error | null;
  webSocketError: Error | null;
  
  // Connection readiness
  isReady: boolean;
}

/**
 * Hook that provides access to the shared WebSocket connection
 * and registers component-specific callbacks
 */
export function useCompletionsWebSocket(
  options: UseCompletionsWebSocketOptions = {}
): UseCompletionsWebSocketReturn {
  const context = useCompletionsWebSocketContext();
  const subscriptionIdRef = useRef<string | null>(null);

  // Register callbacks and subscribe to events
  useEffect(() => {
    // Subscribe with provided callbacks
    subscriptionIdRef.current = context.subscribe(options);

    // Cleanup: unsubscribe when component unmounts or callbacks change
    return () => {
      if (subscriptionIdRef.current) {
        context.unsubscribe(subscriptionIdRef.current);
        subscriptionIdRef.current = null;
      }
    };
  }, [
    context,
    options.onWebSocketOpen,
    options.onWebSocketClose,
    options.onWebSocketError,
    options.onReasoningChunk,
    options.onAction,
    options.onText,
    options.onAudioChunk,
  ]);

  return {
    // Control methods from context
    startRecordingAndStreaming: context.startRecordingAndStreaming,
    stopRecordingAndStreaming: context.stopRecordingAndStreaming,

    // Status from context
    isRecording: context.isRecording,
    isWebSocketConnected: context.isWebSocketConnected,

    // Errors from context
    recordingError: context.recordingError,
    webSocketError: context.webSocketError,

    // Readiness check from context
    isReady: context.isReady,
  };
}
