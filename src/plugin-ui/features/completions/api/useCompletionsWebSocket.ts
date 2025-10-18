/**
 * useCompletionsWebSocket - Unified hook for managing audio recording and WebSocket streaming
 * 
 * This hook synchronizes the lifecycle of:
 * - Audio recording from companion app
 * - WebSocket connection to backend completions endpoint
 * 
 * When recording starts → WebSocket connects
 * When recording stops → WebSocket closes
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { CompletionsWebSocketManager } from './CompletionsWebSocketManager';
import { useAudioRecording } from '@companion/api/companionAppHooks';
import { useAuthenticationStore } from '@auth/stores/useAuthenticationStore';

export interface UseCompletionsWebSocketOptions {
  onWebSocketOpen?: () => void;
  onWebSocketClose?: () => void;
  onWebSocketError?: (error: Event) => void;
  onAcknowledgment?: (message: string) => void;
}

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
 * Hook that manages synchronized audio recording and WebSocket streaming
 */
export function useCompletionsWebSocket(
  options: UseCompletionsWebSocketOptions = {}
): UseCompletionsWebSocketReturn {
  const {
    onWebSocketOpen,
    onWebSocketClose,
    onWebSocketError,
    onAcknowledgment,
  } = options;

  // State
  const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
  const [webSocketError, setWebSocketError] = useState<Error | null>(null);

  // Refs to maintain references
  const wsManagerRef = useRef<CompletionsWebSocketManager | null>(null);

  // Get JWT token from auth store
  const accessToken = useAuthenticationStore((state) => state.accessToken);

  // Set up audio recording with WebSocket forwarding
  const {
    startRecording,
    stopRecording,
    isRecording,
    error: recordingError,
    isReady: isCompanionReady,
  } = useAudioRecording({
    onAudioChunk: (base64Audio: string) => {
      console.log('🎵 Audio chunk received in onAudioChunk callback, length:', base64Audio.length);
      console.log('📡 WebSocket manager exists:', !!wsManagerRef.current);
      console.log('📡 WebSocket connected:', wsManagerRef.current?.isConnected());
      console.log('📡 WebSocket readyState:', wsManagerRef.current?.getReadyState());
      
      // Forward audio chunk to WebSocket
      if (wsManagerRef.current?.isConnected()) {
        console.log('✅ Forwarding audio chunk to WebSocket...');
        wsManagerRef.current.sendAudioChunk(base64Audio);
        console.log('✅ Audio chunk forwarded successfully');
      } else {
        console.warn('⚠️ WebSocket not connected, skipping audio chunk');
        console.warn('⚠️ WebSocket state:', wsManagerRef.current?.getReadyState());
      }
    },
    onError: (error: Error) => {
      console.error('❌ Audio recording error:', error);
      // If recording fails, also close WebSocket
      if (wsManagerRef.current) {
        wsManagerRef.current.close();
        wsManagerRef.current = null;
        setIsWebSocketConnected(false);
      }
    },
  });

  /**
   * Start both audio recording and WebSocket connection
   */
  const startRecordingAndStreaming = useCallback(async () => {
    try {
      // Validate prerequisites
      if (!accessToken) {
        throw new Error('Not authenticated. Please log in first.');
      }

      if (!isCompanionReady) {
        throw new Error('Companion app not connected. Please connect first.');
      }

      console.log('🚀 Starting recording and WebSocket streaming...');

      // Step 1: Create and connect WebSocket
      setWebSocketError(null);
      const wsManager = new CompletionsWebSocketManager(accessToken, {
        onOpen: () => {
          console.log('✅ WebSocket opened');
          setIsWebSocketConnected(true);
          onWebSocketOpen?.();
        },
        onMessage: (data: string) => {
          console.log('📨 Received acknowledgment:', data);
          onAcknowledgment?.(data);
        },
        onClose: () => {
          console.log('🔌 WebSocket closed');
          setIsWebSocketConnected(false);
          onWebSocketClose?.();
        },
        onError: (event: Event) => {
          console.error('❌ WebSocket error:', event);
          const error = new Error('WebSocket connection error');
          setWebSocketError(error);
          onWebSocketError?.(event);
        },
      });

      await wsManager.connect();
      wsManagerRef.current = wsManager;

      // Step 2: Start audio recording (will forward chunks to WebSocket)
      await startRecording();

      console.log('✅ Recording and streaming started successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to start recording and streaming');
      console.error('❌ Failed to start recording and streaming:', err);
      setWebSocketError(err);

      // Clean up WebSocket if it was created
      if (wsManagerRef.current) {
        wsManagerRef.current.close();
        wsManagerRef.current = null;
        setIsWebSocketConnected(false);
      }

      throw err;
    }
  }, [accessToken, isCompanionReady, startRecording, onWebSocketOpen, onWebSocketClose, onWebSocketError, onAcknowledgment]);

  /**
   * Stop both audio recording and WebSocket connection
   */
  const stopRecordingAndStreaming = useCallback(() => {
    console.log('⏹️ Stopping recording and WebSocket streaming...');

    // Step 1: Stop audio recording
    stopRecording();

    // Step 2: Close WebSocket
    if (wsManagerRef.current) {
      wsManagerRef.current.close();
      wsManagerRef.current = null;
      setIsWebSocketConnected(false);
    }

    console.log('✅ Recording and streaming stopped');
  }, [stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsManagerRef.current) {
        console.log('🧹 Cleaning up WebSocket on unmount');
        wsManagerRef.current.close();
        wsManagerRef.current = null;
      }
    };
  }, []);

  return {
    // Control methods
    startRecordingAndStreaming,
    stopRecordingAndStreaming,

    // Status
    isRecording,
    isWebSocketConnected,

    // Errors
    recordingError,
    webSocketError,

    // Readiness check (companion connected + authenticated)
    isReady: isCompanionReady && !!accessToken,
  };
}
