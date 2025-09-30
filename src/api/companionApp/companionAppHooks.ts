/**
 * React Query hooks for companion app communication
 * Integrates with Zustand stores and uses pure CompanionAppClient
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback, useRef, useEffect } from 'react';
import { companionAppClient, CompanionClientDependencies, StreamChunk } from './companionAppClient';
import { useCompanionStore } from '@/stores/useCompanionStore';
import { useNonceStore } from '@/stores/useNonceStore';
import { usePortUpdatesStore } from '@/stores/usePortUpdatesStore';

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

// Helper function to create dependencies from store state
const createDependencies = async (
  companionState: ReturnType<typeof useCompanionStore.getState>,
  nonceState: ReturnType<typeof useNonceStore.getState>,
  portState: ReturnType<typeof usePortUpdatesStore.getState>
): Promise<CompanionClientDependencies> => {
  const nonce = await nonceState.generateNonce();
  nonceState.addNonce(nonce);

  return {
    encryptionKey: companionState.encryptionKey!,
    nonce,
    currentPort: portState.currentPort!,
    nonceValidator: (receivedNonce: string) => {
      // Check if we've already received this nonce
      if (nonceState.hasNonce(receivedNonce)) {
        return false;
      }
      // Track the nonce as received
      nonceState.addNonce(receivedNonce);
      return true;
    },
    onConnectionStateChange: (connected: boolean) => {
      companionState.setCompanionConnected(connected);
    },
    onError: (error: Error) => {
      companionState.setCompanionError(error.message);
    }
  };
};

// Helper function to check if connection prerequisites are met
const isConnectionReady = (
  companionState: ReturnType<typeof useCompanionStore.getState>,
  portState: ReturnType<typeof usePortUpdatesStore.getState>
): boolean => {
  return !!(
    companionState.encryptionKey &&
    portState.currentPort &&
    companionState.isCompanionConnected
  );
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
 */
export function useCompanionQuery<TData = any>(options: UseCompanionQueryOptions) {
  const companionState = useCompanionStore();
  const nonceState = useNonceStore();
  const portState = usePortUpdatesStore();

  return useQuery({
    queryKey: companionQueryKeys.endpointWithOptions(options.endpoint, options.requestOptions),
    queryFn: async (): Promise<TData> => {
      const deps = await createDependencies(companionState, nonceState, portState);
      const response = await companionAppClient.fetch(options.endpoint, deps, options.requestOptions);
      return response.json() as TData;
    },
    enabled: isConnectionReady(companionState, portState) && (options.enabled !== false),
    retry: shouldRetry,
    staleTime: 30000, // Consider data fresh for 30 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    ...options,
  });
}

/**
 * React Query hook for companion app mutations
 */
export function useCompanionMutation<TData = any, TVariables = any>(
  options: UseCompanionMutationOptions<TData, TVariables>
) {
  const companionState = useCompanionStore();
  const nonceState = useNonceStore();
  const portState = usePortUpdatesStore();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: TVariables): Promise<TData> => {
      const deps = await createDependencies(companionState, nonceState, portState);

      const requestOptions: RequestInit = {
        method: 'POST',
        body: typeof variables === 'string' ? variables : JSON.stringify(variables),
      };

      const response = await companionAppClient.fetch(options.endpoint, deps, requestOptions);
      return response.json() as TData;
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
 */
export function useCompanionStream(endpoint: string, options: UseCompanionStreamOptions = {}) {
  const companionState = useCompanionStore();
  const nonceState = useNonceStore();
  const portState = usePortUpdatesStore();

  const [isStreaming, setIsStreaming] = useState(false);
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
  const [error, setError] = useState<Error | null>(null);

  // Use refs to avoid stale closures in stream callbacks
  const chunksRef = useRef<StreamChunk[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const startStream = useCallback(async (streamOptions?: RequestInit) => {
    if (!isConnectionReady(companionState, portState)) {
      const error = new Error('Companion app not connected or missing encryption key');
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
      const deps = await createDependencies(companionState, nonceState, portState);
      const stream = await companionAppClient.fetchStream(endpoint, deps, streamOptions);
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
    } catch (streamError) {
      const error = streamError instanceof Error ? streamError : new Error('Stream failed');
      setError(error);
      optionsRef.current.onError?.(error);
    } finally {
      setIsStreaming(false);
    }
  }, [endpoint, companionState, nonceState, portState]);

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
    if (options.autoStart && isConnectionReady(companionState, portState)) {
      startStream();
    }
  }, [options.autoStart, startStream, companionState.isCompanionConnected, portState.currentPort]);

  return {
    startStream,
    stopStream,
    resetStream,
    isStreaming,
    chunks,
    error,
    isReady: isConnectionReady(companionState, portState),
  };
}

/**
 * Hook to ensure companion app connection with handshake
 */
export function useCompanionConnection() {
  const companionState = useCompanionStore();
  const nonceState = useNonceStore();
  const portState = usePortUpdatesStore();

  const performHandshake = useCallback(async () => {
    if (!companionState.encryptionKey || !portState.currentPort) {
      throw new Error('Missing encryption key or port for handshake');
    }

    companionState.setCompanionConnecting(true);
    companionState.setCompanionError(null);

    try {
      const deps = await createDependencies(companionState, nonceState, portState);
      await companionAppClient.performHandshake(deps);
      companionState.setHandshakeDone(true);
    } catch (error) {
      companionState.setCompanionError(error instanceof Error ? error.message : 'Handshake failed');
      throw error;
    } finally {
      companionState.setCompanionConnecting(false);
    }
  }, [companionState, nonceState, portState]);

  return {
    performHandshake,
    isConnected: companionState.isCompanionConnected,
    isConnecting: companionState.isCompanionConnecting,
    error: companionState.companionError,
    isReady: isConnectionReady(companionState, portState),
  };
}

// Convenience hook for common status checks
export function useCompanionStatus() {
  const companionState = useCompanionStore();
  const portState = usePortUpdatesStore();

  return {
    hasEncryptionKey: !!companionState.encryptionKey,
    hasPort: !!portState.currentPort,
    isConnected: companionState.isCompanionConnected,
    isConnecting: companionState.isCompanionConnecting,
    error: companionState.companionError,
    isReady: isConnectionReady(companionState, portState),
    keyExpiresAt: companionState.keyExpiresAt,
  };
}
