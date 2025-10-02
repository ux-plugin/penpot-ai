/**
 * React Query hooks for companion app communication
 * Updated to use ConnectionManager as the central orchestrator
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback, useRef, useEffect } from 'react';
import { connectionManager, companionAppClient, StreamChunk } from './index.ts';
import { useCompanionStore } from '@companion/stores/useCompanionStore.ts';

// Query key factory for consistent caching
export const companionQueryKeys = {
  all: ['companion'] as const,
  endpoint: (endpoint: string) => [...companionQueryKeys.all, endpoint] as const,
  endpointWithOptions: (endpoint: string, options?: RequestInit) => [...companionQueryKeys.endpoint(endpoint), options] as const,
};

// Hook options interfaces
export interface UseCompanionQueryOptions extends Omit<Parameters<typeof useQuery>[0], 'queryKey' | 'queryFn'> {
  endpoint: string;
  requestOptions?: RequestInit;
}

export interface UseCompanionMutationOptions<TData = any, TVariables = any> {
  endpoint: string;
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
  onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables) => void;
}

export interface UseCompanionStreamOptions {
  onChunk?: (chunk: StreamChunk) => void;
  onComplete?: (allChunks: StreamChunk[]) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  autoStart?: boolean;
}

// Helper function to check if connected via ConnectionManager
const isConnectionReady = (): boolean => {
  return connectionManager.isConnected();
};

// Helper function for retry logic
const shouldRetry = (failureCount: number, error: unknown): boolean => {
  // Don't retry more than 3 times
  if (failureCount >= 3) return false;

  // Retry on network errors and 5xx errors
  if (error instanceof Error) {
    return (
      error.message.includes('fetch') ||
      error.message.includes('network') ||
      error.message.includes('timeout') ||
      error.message.includes('500') ||
      error.message.includes('502') ||
      error.message.includes('503') ||
      error.message.includes('504')
    );
  }

  return false;
};

/**
 * React Query hook for companion app queries
 * Uses ConnectionManager for connection validation and error handling
 */
export function useCompanionQuery<TData = any>(options: UseCompanionQueryOptions) {
  return useQuery({
    queryKey: companionQueryKeys.endpointWithOptions(options.endpoint, options.requestOptions),
    queryFn: async (): Promise<TData> => {
      // Wrap API call through ConnectionManager for error handling
      return connectionManager.apiCall(async () => {
        const response = await companionAppClient.fetch(options.endpoint, options.requestOptions);
        return response.json() as TData;
      });
    },
    enabled: isConnectionReady() && (options.enabled !== false),
    retry: shouldRetry,
    staleTime: 30000, // Consider data fresh for 30 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    ...options,
  });
}

/**
 * React Query hook for companion app mutations
 * Uses ConnectionManager for connection validation and error handling
 */
export function useCompanionMutation<TData = any, TVariables = any>(
  options: UseCompanionMutationOptions<TData, TVariables>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: TVariables): Promise<TData> => {
      // Wrap API call through ConnectionManager for error handling
      return connectionManager.apiCall(async () => {
        const requestOptions: RequestInit = {
          method: 'POST',
          body: typeof variables === 'string' ? variables : JSON.stringify(variables),
        };

        const response = await companionAppClient.fetch(options.endpoint, requestOptions);
        return response.json() as TData;
      });
    },
    onSuccess: (data, variables) => {
      // Invalidate related queries
      queryClient.invalidateQueries({
        queryKey: companionQueryKeys.all,
      });
      options.onSuccess?.(data, variables);
    },
    onError: options.onError,
    onSettled: options.onSettled,
    retry: shouldRetry,
  });
}

/**
 * Hook for companion app streaming requests
 * Uses ConnectionManager for connection validation and error handling
 */
export function useCompanionStream(endpoint: string, options: UseCompanionStreamOptions = {}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
  const [error, setError] = useState<Error | null>(null);

  // Use refs to avoid stale closures in stream callbacks
  const chunksRef = useRef<StreamChunk[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const startStream = useCallback(async (streamOptions?: RequestInit) => {
    if (!isConnectionReady()) {
      const error = new Error('Not connected to companion app');
      setError(error);
      optionsRef.current.onError?.(error);
      return;
    }

    setIsStreaming(true);
    setError(null);
    setChunks([]);
    chunksRef.current = [];

    optionsRef.current.onStart?.();

    try {
      // Wrap stream call through ConnectionManager for error handling
      await connectionManager.streamCall(async () => {
        const stream = await companionAppClient.fetchStream(endpoint, streamOptions);
        const reader = stream.getReader();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            optionsRef.current.onComplete?.(chunksRef.current);
            break;
          }

          // Update state and refs
          chunksRef.current.push(value);
          setChunks([...chunksRef.current]);

          // Call chunk callback
          optionsRef.current.onChunk?.(value);
        }
      });
    } catch (streamError) {
      const error = streamError instanceof Error ? streamError : new Error('Stream failed');
      setError(error);
      optionsRef.current.onError?.(error);
    } finally {
      setIsStreaming(false);
    }
  }, [endpoint]);

  const stopStream = useCallback(() => {
    // Note: In a real implementation, you'd want to store the reader
    // and call reader.cancel() here to properly stop the stream
    setIsStreaming(false);
  }, []);

  const resetStream = useCallback(() => {
    setChunks([]);
    setError(null);
    chunksRef.current = [];
  }, []);

  // Auto-start if enabled
  useEffect(() => {
    if (options.autoStart && isConnectionReady()) {
      startStream();
    }
  }, [options.autoStart, startStream]);

  return {
    startStream,
    stopStream,
    resetStream,
    isStreaming,
    chunks,
    error,
    isReady: isConnectionReady(),
  };
}

/**
 * Hook for managing companion app connection
 * Uses ConnectionManager as the single entry point
 */
export function useCompanionConnection() {
  const companionState = useCompanionStore();

  const connect = useCallback(async () => {
    await connectionManager.connect();
  }, []);

  const disconnect = useCallback(() => {
    connectionManager.disconnect();
  }, []);

  return {
    connect,
    disconnect,
    isConnected: companionState.isCompanionConnected,
    isConnecting: companionState.isCompanionConnecting,
    error: companionState.companionError,
    connectionState: companionState.connectionState,
    canConnect: connectionManager.canConnect(),
  };
}

// Convenience hook for common status checks
export function useCompanionStatus() {
  const companionState = useCompanionStore();
  const connectionInfo = connectionManager.getConnectionInfo();

  return {
    ...connectionInfo,
    isConnecting: companionState.isCompanionConnecting,
    error: companionState.companionError,
  };
}
