/**
 * useCompletionsWebSocket - Unified hook for managing audio recording and WebSocket streaming
 * 
 * This hook manages:
 * - Persistent WebSocket connection to backend completions endpoint
 * - Audio recording from companion app
 * - Session-based request/response cycles using fe_id
 * 
 * Connection Lifecycle:
 * - WebSocket connects once when first needed and stays open
 * - Each recording session gets a unique fe_id for correlation
 * - WebSocket closes only on component unmount or error
 * 
 * Recording Flow:
 * - Start recording → Creates new session with fe_id → Streams audio chunks
 * - Stop recording → Sends completion_request_end → Ready for next session
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { CompletionsWebSocketAdapter } from './CompletionsWebSocketAdapter';
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
  const wsAdapterRef = useRef<CompletionsWebSocketAdapter | null>(null);

  // Get JWT token from the auth store
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
      console.log('📡 WebSocket adapter exists:', !!wsAdapterRef.current);
      console.log('📡 WebSocket connected:', wsAdapterRef.current?.isConnected());
      console.log('📡 WebSocket readyState:', wsAdapterRef.current?.getReadyState());
      
      // Forward audio chunk to WebSocket
      if (wsAdapterRef.current?.isConnected()) {
        console.log('✅ Forwarding audio chunk to WebSocket...');
        wsAdapterRef.current.sendAudioChunk(base64Audio);
        console.log('✅ Audio chunk forwarded successfully');
      } else {
        console.warn('⚠️ WebSocket not connected, skipping audio chunk');
        console.warn('⚠️ WebSocket state:', wsAdapterRef.current?.getReadyState());
      }
    },
    onError: (error: Error) => {
      console.error('❌ Audio recording error:', error);
    },
  });

  /**
   * Initialize WebSocket connection (called once when component mounts)
   */
  const initializeWebSocket = useCallback(async () => {
    // Don't initialize if already connected or if missing prerequisites
    if (wsAdapterRef.current?.isConnected() || !accessToken) {
      return;
    }

    try {
      console.log('🔌 Initializing WebSocket connection...');
      setWebSocketError(null);
      
      const wsAdapter = new CompletionsWebSocketAdapter({
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

      await wsAdapter.connect();
      wsAdapterRef.current = wsAdapter;
      console.log('✅ WebSocket initialized successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to initialize WebSocket');
      console.error('❌ Failed to initialize WebSocket:', err);
      setWebSocketError(err);
      wsAdapterRef.current = null;
      throw err;
    }
  }, [accessToken, onWebSocketOpen, onWebSocketClose, onWebSocketError, onAcknowledgment]);

  /**
   * Start recording and create a new session (reuses existing WebSocket)
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

      console.log('🚀 Starting recording and streaming...');

      // Ensure WebSocket is connected (will create if needed)
      if (!wsAdapterRef.current?.isConnected()) {
        await initializeWebSocket();
      }

      // Start a new session (generates fe_id)
      if (wsAdapterRef.current) {
        wsAdapterRef.current.startSession();
      }

      // Start audio recording (will forward chunks to WebSocket)
      await startRecording();

      console.log('✅ Recording and streaming started successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to start recording and streaming');
      console.error('❌ Failed to start recording and streaming:', err);
      setWebSocketError(err);
      throw err;
    }
  }, [accessToken, isCompanionReady, startRecording, initializeWebSocket]);

  /**
   * Stop recording and end the current session (keeps WebSocket open for next session)
   */
  const stopRecordingAndStreaming = useCallback(() => {
    console.log('⏹️ Stopping recording...');

    // Stop audio recording first
    stopRecording();

    // Send completion_request_end to signal end of this session
    if (wsAdapterRef.current) {
      wsAdapterRef.current.endSession();
    }

    console.log('✅ Recording stopped, WebSocket remains open for next session');
  }, [stopRecording]);

  useEffect(() => {
    return () => {
      if (wsAdapterRef.current) {
        console.log('🧹 Cleaning up WebSocket on unmount');
        wsAdapterRef.current.close();
        wsAdapterRef.current = null;
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
