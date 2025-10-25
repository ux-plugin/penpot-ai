/**
 * React hooks for companion app communication via WebSocket
 * Updated to use ConnectionManager and WebSocket-based communication
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { connectionManager } from "./index.ts";
import { selectIsConnected, useCompanionStore } from "@companion/stores/useCompanionStore.ts";

/**
 * Hook for managing companion app connection
 * Returns only connect and disconnect functions with proper error handling
 * Consumers should use useCompanionStore directly for state (webSocketState, isConnecting, isConnected)
 */
export function useCompanionConnection() {
  const connect = useCallback(async () => {
    try {
      await connectionManager.connect();
    } catch (error) {
      // Re-throw error for caller to handle
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to companion app';
      throw new Error(errorMessage);
    }
  }, []);

  const disconnect = useCallback(() => {
    try {
      connectionManager.disconnect();
    } catch (error) {
      // Log but don't throw - disconnect should be safe
      console.error('Error during disconnect:', error);
    }
  }, []);

  return {
    connect,
    disconnect,
  };
}

/**
 * Hook for managing audio recording with the companion app
 * Provides a clean interface for starting/stopping recording and handling audio chunks
 */
export function useAudioRecording(options: {
  onAudioChunk: (base64Audio: string) => void;
  onError?: (error: Error) => void;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const connectionRef = useRef<{ close: () => void } | null>(null);
  
  // Subscribe to connection state reactively from store
  const isCompanionConnected = useCompanionStore(selectIsConnected);

  const startRecording = useCallback(async () => {
    if (isRecording) {
      console.warn('Recording already in progress');
      return;
    }

    if (!connectionManager.isConnected()) {
      const error = new Error('Not connected to companion app');
      setError(error);
      options.onError?.(error);
      return;
    }

    try {
      setError(null);
      console.log("🎤 Starting audio recording...");

      connectionRef.current = await connectionManager.startRecording({
        onAudioChunk: (base64Audio: string) => {
          options.onAudioChunk(base64Audio);
        },
        onError: (err: Error) => {
          console.error("❌ Recording error:", err);
          setError(err);
          setIsRecording(false);
          connectionRef.current = null;
          options.onError?.(err);
        },
      });
      setIsRecording(true);
      console.log("✅ Recording started successfully");
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to start recording');
      console.error('❌ Failed to start recording:', error);
      setError(error);
      setIsRecording(false);
      options.onError?.(error);
    }
  }, [isRecording, options]);

  const stopRecording = useCallback(() => {
    if (!isRecording || !connectionRef.current) {
      console.warn('No recording in progress');
      return;
    }

    console.log('⏹️ Stopping recording...');
    connectionRef.current.close();
    setIsRecording(false);
    console.log('✅ Recording stopped');
  }, [isRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (connectionRef.current) {
        console.log('🧹 Cleaning up recording connection on unmount');
        connectionRef.current.close();
      }
    };
  }, []);

  return {
    startRecording,
    stopRecording,
    isRecording,
    error,
    isReady: isCompanionConnected, // Now reactive!
  };
}
