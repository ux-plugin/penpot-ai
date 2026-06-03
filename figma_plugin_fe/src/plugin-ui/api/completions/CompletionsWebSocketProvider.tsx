/**
 * CompletionsWebSocketProvider - Manages completions via RSocket
 * 
 * This provider manages completions streaming through RSocket request-channel,
 * ensuring a single channel per session regardless of how many components
 * use the useCompletionsWebSocket hook.
 * 
 * Features:
 * - Direct RSocket integration via rsocket.ts
 * - Single request-channel per session
 * - Multiple callback registration
 * - Automatic cleanup on unmount
 */

import { createContext, useContext, useState, useRef, useEffect, useCallback, ReactNode } from 'react';
import { 
  connectRSocket, 
  isRSocketConnected, 
  onRSocketOpen, 
  onRSocketClose, 
  openRequestChannel 
} from '@api/rsocket.ts';
import { useAudioRecording } from '@/plugin-ui/api/companion/companionAppHooks.ts';
import type {
  CompletionsRequestPayload,
  CompletionsResponsePayload,
} from './messageTypes.ts';

export interface UseCompletionsWebSocketOptions {
  onWebSocketOpen?: () => void;
  onWebSocketClose?: () => void;
  onWebSocketError?: (error: Error) => void;
  
  // Streaming content callbacks
  onReasoningChunk?: (reasoning: string) => void;
  onAction?: (action: any) => void;
  onText?: (text: string) => void;
  
  onAudioChunk?: (base64Audio: string) => void;
}

interface CompletionsWebSocketContextType {
  // Core methods
  startRecordingAndStreaming: () => Promise<void>;
  stopRecordingAndStreaming: () => void;
  
  // Status
  isRecording: boolean;
  isWebSocketConnected: boolean;
  
  // Errors
  recordingError: Error | null;
  webSocketError: Error | null;
  
  // Readiness
  isReady: boolean;
  
  // Subscription management
  subscribe: (callbacks: UseCompletionsWebSocketOptions) => string;
  unsubscribe: (id: string) => void;
}

const CompletionsWebSocketContext = createContext<CompletionsWebSocketContextType | null>(null);

export function CompletionsWebSocketProvider({ children }: { children: ReactNode }) {
  // State
  const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
  const [webSocketError, setWebSocketError] = useState<Error | null>(null);
  
  // Refs
  const subscriptionsRef = useRef<Map<string, UseCompletionsWebSocketOptions>>(new Map());
  const nextIdRef = useRef(0);
  const channelRef = useRef<{
    send: (data: any, isComplete?: boolean) => void;
    complete: () => void;
    cancel: () => void;
    request: (n: number) => void;
  } | null>(null);
  const unsubscribeCallbacksRef = useRef<(() => void)[]>([]);

  /**
   * Send audio chunk via RSocket channel
   */
  const sendAudioChunk = useCallback((base64Audio: string, drawnPath: string = '') => {
    if (!isRSocketConnected()) {
      console.warn('⚠️ RSocket is not open, cannot send audio chunk');
      return;
    }
    if (!channelRef.current) {
      console.warn('⚠️ No active RSocket channel');
      return;
    }

    const payload: CompletionsRequestPayload = {
      drawnPath: drawnPath,
      audioChunkBase64: base64Audio,
      timestamp: Date.now(),
    };
    
    channelRef.current.send(payload, false);

    console.log('📤 [RSocket] Sent audio chunk:', {
      audioLength: base64Audio.length,
      pathLength: drawnPath.length,
    });
  }, []);

  // Set up audio recording with RSocket forwarding
  const {
    startRecording,
    stopRecording,
    isRecording,
    error: recordingError,
    isReady: isCompanionReady,
  } = useAudioRecording({
    onAudioChunk: (base64Audio: string) => {
      console.log('🎵 Audio chunk received, length:', base64Audio.length);
      console.log('📡 RSocket connected:', isRSocketConnected());
      
      // Notify all subscribers
      subscriptionsRef.current.forEach((callbacks) => {
        callbacks.onAudioChunk?.(base64Audio);
      });
      
      // Forward audio chunk to RSocket
      if (isRSocketConnected()) {
        console.log('✅ Forwarding audio chunk to RSocket...');
        sendAudioChunk(base64Audio);
      } else {
        console.warn('⚠️ RSocket not connected, skipping audio chunk');
      }
    },
    onError: (error: Error) => {
      console.error('❌ Audio recording error:', error);
    },
  });

  /**
   * Notify all subscribers of WebSocket open event
   */
  const notifyWebSocketOpen = useCallback(() => {
    subscriptionsRef.current.forEach((callbacks) => {
      callbacks.onWebSocketOpen?.();
    });
  }, []);

  /**
   * Notify all subscribers of WebSocket close event
   */
  const notifyWebSocketClose = useCallback(() => {
    subscriptionsRef.current.forEach((callbacks) => {
      callbacks.onWebSocketClose?.();
    });
  }, []);

  /**
   * Notify all subscribers of WebSocket error
   */
  const notifyWebSocketError = useCallback((error: Error) => {
    subscriptionsRef.current.forEach((callbacks) => {
      callbacks.onWebSocketError?.(error);
    });
  }, []);

  /**
   * Notify all subscribers of reasoning chunk
   */
  const notifyReasoningChunk = useCallback((reasoning: string) => {
    subscriptionsRef.current.forEach((callbacks) => {
      callbacks.onReasoningChunk?.(reasoning);
    });
  }, []);

  /**
   * Notify all subscribers of action
   */
  const notifyAction = useCallback((action: any) => {
    subscriptionsRef.current.forEach((callbacks) => {
      callbacks.onAction?.(action);
    });
  }, []);

  /**
   * Notify all subscribers of text chunk
   */
  const notifyText = useCallback((text: string) => {
    subscriptionsRef.current.forEach((callbacks) => {
      callbacks.onText?.(text);
    });
  }, []);

  /**
   * Handle completions response payload (AI-generated actions)
   */
  const handleCompletionResponse = useCallback((payload: CompletionsResponsePayload) => {
    const { action, reasoning, text } = payload;

    // Handle reasoning chunk
    if (reasoning) {
      console.log(`🧠 Reasoning: ${reasoning}`);
      notifyReasoningChunk(reasoning);
    }

    // Handle text chunk
    if (text) {
      console.log(`💬 Text: ${text}`);
      notifyText(text);
    }

    // Handle action
    if (action) {
      console.log(`🎬 Action: ${action.action} on target: ${action.target}`);
      notifyAction(action);
    }
  }, [notifyReasoningChunk, notifyText, notifyAction]);

  /**
   * Start an RSocket request-channel for completions session
   */
  const startChannel = useCallback(async () => {
    if (channelRef.current) return; // Already have a channel
    
    await connectRSocket();

    channelRef.current = await openRequestChannel('completions.stream', null, {
      onNext: (payload: CompletionsResponsePayload) => {
        handleCompletionResponse(payload);
      },
      onError: (error) => {
        console.error('❌ Completions channel error:', error);
        setWebSocketError(error);
        notifyWebSocketError(error);
        channelRef.current = null;
      },
      onComplete: () => {
        console.log('🏁 Completions channel complete');
        channelRef.current = null;
      },
    });
  }, [handleCompletionResponse, notifyWebSocketError]);

  /**
   * Initialize RSocket connection and set up lifecycle callbacks
   */
  const initializeRSocket = useCallback(async () => {
    // Don't initialize if already connected
    if (isRSocketConnected()) {
      return;
    }

    try {
      console.log('🔌 Initializing RSocket connection for completions...');
      setWebSocketError(null);
      
      await connectRSocket();
      setIsWebSocketConnected(true);
      console.log('✅ RSocket initialized successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to initialize RSocket');
      console.error('❌ Failed to initialize RSocket:', err);
      setWebSocketError(err);
      throw err;
    }
  }, []);

  /**
   * Set up RSocket lifecycle callbacks on mount
   */
  useEffect(() => {
    const unsubOpen = onRSocketOpen(() => {
      console.log('✅ Completions (RSocket): connected');
      setIsWebSocketConnected(true);
      notifyWebSocketOpen();
    });
    
    const unsubClose = onRSocketClose(() => {
      console.log('🔌 Completions (RSocket): closed');
      setIsWebSocketConnected(false);
      notifyWebSocketClose();
    });

    unsubscribeCallbacksRef.current = [unsubOpen, unsubClose];

    return () => {
      unsubscribeCallbacksRef.current.forEach(unsub => unsub());
      unsubscribeCallbacksRef.current = [];
    };
  }, [notifyWebSocketOpen, notifyWebSocketClose]);

  /**
   * Start recording and create a new session
   */
  const startRecordingAndStreaming = useCallback(async () => {
    try {
      // Validate prerequisites
      if (!isCompanionReady) {
        throw new Error('Companion app not connected. Please connect first.');
      }

      console.log('🚀 Starting recording and streaming...');

      // Ensure RSocket is connected
      if (!isRSocketConnected()) {
        await initializeRSocket();
      }

      // Start the RSocket channel
      await startChannel();

      // Start audio recording
      await startRecording();

      console.log('✅ Recording and streaming started successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Failed to start recording and streaming');
      console.error('❌ Failed to start recording and streaming:', err);
      setWebSocketError(err);
      throw err;
    }
  }, [isCompanionReady, startRecording, initializeRSocket, startChannel]);

  /**
   * Stop recording and complete the RSocket channel
   */
  const stopRecordingAndStreaming = useCallback(() => {
    console.log('⏹️ Stopping recording...');

    // Stop audio recording first
    stopRecording();

    // Complete the RSocket channel (replaces the need for "End" message)
    if (isRSocketConnected() && channelRef.current) {
      try { 
        channelRef.current.complete();
        console.log('🏁 [RSocket] Channel completed');
      } catch (error) {
        console.warn('⚠️ Error completing channel:', error);
      }
      channelRef.current = null;
    }

    console.log('✅ Recording stopped, RSocket remains open');
  }, [stopRecording]);

  /**
   * Subscribe to WebSocket events
   */
  const subscribe = useCallback((callbacks: UseCompletionsWebSocketOptions): string => {
    const id = `sub_${nextIdRef.current++}`;
    subscriptionsRef.current.set(id, callbacks);
    console.log(`📝 Subscribed: ${id}, total subscribers: ${subscriptionsRef.current.size}`);
    return id;
  }, []);

  /**
   * Unsubscribe from WebSocket events
   */
  const unsubscribe = useCallback((id: string) => {
    subscriptionsRef.current.delete(id);
    console.log(`🗑️ Unsubscribed: ${id}, total subscribers: ${subscriptionsRef.current.size}`);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('🧹 Cleaning up completions provider on unmount');
      
      // Cancel channel if still present
      if (channelRef.current) {
        try { channelRef.current.cancel(); } catch {}
        channelRef.current = null;
      }
    };
  }, []);

  const value: CompletionsWebSocketContextType = {
    startRecordingAndStreaming,
    stopRecordingAndStreaming,
    isRecording,
    isWebSocketConnected,
    recordingError,
    webSocketError,
    isReady: isCompanionReady || isWebSocketConnected,
    subscribe,
    unsubscribe,
  };

  return (
    <CompletionsWebSocketContext.Provider value={value}>
      {children}
    </CompletionsWebSocketContext.Provider>
  );
}

/**
 * Hook to access the shared WebSocket connection
 */
export function useCompletionsWebSocketContext() {
  const context = useContext(CompletionsWebSocketContext);
  if (!context) {
    throw new Error('useCompletionsWebSocketContext must be used within CompletionsWebSocketProvider');
  }
  return context;
}
