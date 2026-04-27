/**
 * rsocket.ts - RSocket client for Spring RSocket over WebSocket
 *
 * Connects to Spring RSocket backend with JWT authentication and subscribes
 * to the `user.ports.stream` route for real-time port updates.
 *
 * Notes:
 * - Backend mapping-path is /rsocket (WebSocket transport)
 * - Server default port is 8003, derived from resolveBackendUrl()
 * - JWT is required for routes not matching auth.** pattern
 * - Uses composite metadata with Bearer token for authentication
 */

import { useAuthenticationStore } from '@stores/useAuthenticationStore.ts';
import { resolveBackendUrl } from '@api/auth/utils.ts';
import { usePortUpdatesStore } from '@stores/usePortUpdatesStore.ts';

// RSocket core imports
import { RSocketConnector } from 'rsocket-core';
import type { RSocket, Cancellable, Requestable } from 'rsocket-core';
import { WebsocketClientTransport } from 'rsocket-websocket-client';

// Composite metadata encoding functions
import {
  encodeCompositeMetadata,
  encodeAndAddWellKnownMetadata,
  encodeBearerAuthMetadata,
  encodeRoute,
  WellKnownMimeType,
} from 'rsocket-composite-metadata';

// Minimal type for PortState from backend
export interface PortState {
  port: number | null;
  nonce?: number;
}

// Singleton connection holder
let rsocketConnection: RSocket | null = null;
let activeSubscription: (Cancellable & Requestable) | null = null;

// Connection lifecycle subscribers
const openCallbacks = new Set<() => void>();
const closeCallbacks = new Set<() => void>();

// Token refresh state
let isRefreshingToken = false;
let refreshPromise: Promise<string> | null = null;

function buildRSocketUrl(): string {
  const httpBase = resolveBackendUrl();
  if (!httpBase) {
    throw new Error('Backend not configured. Set VITE_BACKEND_URL in your .env file.');
  }
  const wsBase = httpBase.replace(/^http/, 'ws');
  return `${wsBase}/rsocket`;
}

function getJwt(): string | null {
  return useAuthenticationStore.getState().accessToken;
}

/**
 * Attempts to refresh the access token using the refresh token.
 * Returns the new access token or throws an error.
 */
async function refreshAccessToken(): Promise<string> {
  // If already refreshing, return the existing promise
  if (isRefreshingToken && refreshPromise) {
    return refreshPromise;
  }

  isRefreshingToken = true;
  refreshPromise = (async () => {
    try {
      const authStore = useAuthenticationStore.getState();
      const refreshToken = authStore.refreshToken;

      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      const baseUrl = resolveBackendUrl();
      if (!baseUrl) throw new Error('Backend not configured');
      const response = await fetch(`${baseUrl}/auth/auth0/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        throw new Error('Failed to refresh token');
      }

      const data = await response.json();
      await authStore.setAccessToken(data.accessToken);
      await authStore.setRefreshToken(
        data.refreshToken,
        data.refreshTokenExpiresAt ? new Date(data.refreshTokenExpiresAt).getTime() : null,
      );

      console.log('[RSocket] Token refreshed successfully');
      return data.accessToken;
    } catch (error) {
      console.error('[RSocket] Token refresh failed:', error);
      // Logout user on refresh failure
      await useAuthenticationStore.getState().logout();
      throw error;
    } finally {
      isRefreshingToken = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Checks if an error is an authentication error that requires token refresh
 */
function isAuthenticationError(error: any): boolean {
  // Check for common authentication error patterns
  const errorMessage = error?.message?.toLowerCase() || error?.toString?.()?.toLowerCase() || '';
  return (
    errorMessage.includes('unauthenticated') ||
    errorMessage.includes('unauthorized') ||
    errorMessage.includes('401') ||
    errorMessage.includes('authentication') ||
    errorMessage.includes('invalid token') ||
    errorMessage.includes('token expired')
  );
}

/**
 * Returns whether the RSocket is currently connected.
 */
export function isRSocketConnected(): boolean {
  return rsocketConnection != null;
}

/**
 * Subscribe to RSocket open events. Returns an unsubscribe function.
 */
export function onRSocketOpen(cb: () => void): () => void {
  openCallbacks.add(cb);
  return () => openCallbacks.delete(cb);
}

/**
 * Subscribe to RSocket close events. Returns an unsubscribe function.
 */
export function onRSocketClose(cb: () => void): () => void {
  closeCallbacks.add(cb);
  return () => closeCallbacks.delete(cb);
}

/**
 * Build composite metadata buffer with Bearer authentication
 */
function buildSetupMetadata(jwt: string): Buffer {
  const authMetadata = encodeBearerAuthMetadata(jwt);
  
  return encodeCompositeMetadata([
    [WellKnownMimeType.MESSAGE_RSOCKET_AUTHENTICATION, authMetadata],
  ]);
}

/**
 * Build per-request composite metadata with routing and auth
 */
function buildRequestMetadata(route: string, jwt: string): Buffer {
  const routingMetadata = encodeRoute(route);
  const authMetadata = encodeBearerAuthMetadata(jwt);
  
  let metadata = encodeCompositeMetadata([
    [WellKnownMimeType.MESSAGE_RSOCKET_ROUTING, routingMetadata],
  ]);
  
  // Add authentication metadata
  metadata = encodeAndAddWellKnownMetadata(
    metadata,
    WellKnownMimeType.MESSAGE_RSOCKET_AUTHENTICATION,
    authMetadata
  );
  
  return metadata;
}

/**
 * Connect (or reuse) an RSocket connection.
 * Throws if VITE_BACKEND_URL is not set.
 */
export async function connectRSocket(): Promise<RSocket> {
  if (rsocketConnection) {
    return rsocketConnection;
  }

  if (!resolveBackendUrl()) {
    throw new Error('Backend not configured. Set VITE_BACKEND_URL in your .env file.');
  }

  const jwt = getJwt();
  if (!jwt) {
    throw new Error('No JWT token available for RSocket');
  }

  const url = buildRSocketUrl();
  const setupMetadata = buildSetupMetadata(jwt);

  const connector = new RSocketConnector({
    setup: {
      keepAlive: 60000,
      lifetime: 180000,
      dataMimeType: 'application/json',
      metadataMimeType: 'message/x.rsocket.composite-metadata.v0',
      payload: {
        data: undefined,
        metadata: setupMetadata,
      },
    },
    transport: new WebsocketClientTransport({ url }),
  });

  try {
    rsocketConnection = await connector.connect();
    console.log('[RSocket] Connected successfully to', url);
    try {
      // Notify opens
      openCallbacks.forEach((cb) => {
        try { cb(); } catch (e) { console.warn('[RSocket] onOpen callback error', e); }
      });
      // Wire close notifications
      // @ts-ignore: onClose exists on implementation
      rsocketConnection.onClose?.(() => {
        console.log('[RSocket] Connection closed');
        rsocketConnection = null;
        closeCallbacks.forEach((cb) => {
          try { cb(); } catch (e) { console.warn('[RSocket] onClose callback error', e); }
        });
      });
    } catch (e) {
      console.warn('[RSocket] Failed to wire open/close callbacks', e);
    }
    return rsocketConnection;
  } catch (error) {
    console.error('[RSocket] Connection failed:', error);
    rsocketConnection = null;
    throw error;
  }
}

/**
 * Subscribe to user.ports.stream (request-stream) and push updates into the port store.
 * Returns a cancel function to stop the stream.
 */
export async function subscribeToUserPortsStream(): Promise<() => void> {
  let retryAttempted = false;

  const subscribe = async () => {
    const socket = await connectRSocket();
    const jwt = getJwt();

    if (!jwt) {
      throw new Error('No JWT token available for subscription');
    }

    // Build per-request metadata with routing
    const metadata = buildRequestMetadata('user.ports.stream', jwt);

    const payload = {
      data: null,
      metadata,
    };

    // Cancel any existing subscription
    if (activeSubscription) {
      try {
        activeSubscription.cancel();
      } catch (e) {
        console.warn('[RSocket] Error cancelling previous subscription', e);
      }
    }

    // Use low-level subscriber pattern for request-stream
    activeSubscription = socket.requestStream(
      payload,
      2147483647, // Initial request N (max value)
      {
        onNext: (payload, isComplete) => {
          try {
            const dataStr = payload.data?.toString('utf-8');
            if (!dataStr) {
              console.warn('[RSocket] Received empty data');
              return;
            }

            const parsed: PortState = JSON.parse(dataStr);
            usePortUpdatesStore.getState().setCurrentPort(parsed?.port ?? null);
            console.log('[RSocket] PortState event:', parsed);

            if (isComplete) {
              console.log('[RSocket] Stream marked complete in onNext');
            }
          } catch (e) {
            console.warn('[RSocket] Failed to parse PortState event', e, payload);
          }
        },
        onError: async (error) => {
          console.error('[RSocket] user.ports.stream error:', error);
          activeSubscription = null;

          // Check if this is an authentication error
          if (isAuthenticationError(error) && !retryAttempted) {
            console.log('[RSocket] Authentication error detected, attempting token refresh...');
            retryAttempted = true;

            try {
              // Attempt to refresh the token
              await refreshAccessToken();

              // Disconnect the old connection
              disconnectRSocket();

              // Retry the subscription with the new token
              console.log('[RSocket] Retrying subscription with refreshed token...');
              await subscribe();
            } catch (refreshError) {
              console.error('[RSocket] Token refresh failed, disconnecting:', refreshError);
              // Disconnect and logout user
              disconnectRSocket();
            }
          } else if (retryAttempted) {
            console.error('[RSocket] Retry already attempted or auth failed, disconnecting user');
            // Already tried refresh, disconnect user
            disconnectRSocket();
          }
        },
        onComplete: () => {
          console.log('[RSocket] user.ports.stream complete');
          activeSubscription = null;
        },
        onExtension: () => {
          // Extension frames - not used in this implementation
        },
      }
    );
  };

  // Initial subscription
  await subscribe();

  // Return cancel function
  return () => {
    try {
      if (activeSubscription) {
        activeSubscription.cancel();
        activeSubscription = null;
      }
    } catch (e) {
      console.warn('[RSocket] Error during cancellation', e);
    }
  };
}

/**
 * Disconnect and cleanup RSocket connection
 */
export function disconnectRSocket(): void {
  try {
    // Cancel active subscription first
    if (activeSubscription) {
      activeSubscription.cancel();
      activeSubscription = null;
    }
  } catch (e) {
    console.warn('[RSocket] Error cancelling subscription during disconnect', e);
  }

  try {
    // Close connection
    if (rsocketConnection) {
      rsocketConnection.close();
      rsocketConnection = null;
      // Notify closes explicitly (in case implementation doesn't)
      closeCallbacks.forEach((cb) => {
        try { cb(); } catch (e) { console.warn('[RSocket] onClose callback error', e); }
      });
    }
  } catch (e) {
    console.warn('[RSocket] Error closing connection', e);
  }
}

// =====================================================================================
// Generic helpers for RSocket routes (request/stream/channel) used by features
// =====================================================================================

function encodeData(data: any): Buffer | null {
  if (data == null) return null;
  try {
    return Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf-8');
  } catch (e) {
    console.warn('[RSocket] Failed to encode data payload', e);
    return null;
  }
}

/**
 * Open a request-channel with given route. Returns a lightweight sender wrapper.
 */
export async function openRequestChannel(
  route: string,
  initialData: any,
  handlers: {
    onNext?: (data: any, isComplete: boolean) => void;
    onError?: (error: Error) => void;
    onComplete?: () => void;
  } = {}
): Promise<{
  send: (data: any, isComplete?: boolean) => void;
  complete: () => void;
  cancel: () => void;
  request: (n: number) => void;
}> {
  let retryAttempted = false;
  let currentChannel: any = null;

  const openChannel = async () => {
    const socket = await connectRSocket();
    const jwt = getJwt();
    if (!jwt) throw new Error('No JWT token available for requestChannel');

    const metadata = buildRequestMetadata(route, jwt);
    const payload = { data: encodeData(initialData), metadata };

    const responder = {
      onNext: (payload: { data?: Buffer | null }, isComplete: boolean) => {
        try {
          const dataStr = payload.data?.toString('utf-8');
          const parsed = dataStr ? JSON.parse(dataStr) : null;
          handlers.onNext?.(parsed, isComplete);
        } catch (e) {
          console.warn('[RSocket] Channel onNext parse error', e);
        }
      },
      onError: async (error: Error) => {
        console.error('[RSocket] Channel error:', error);

        // Check if this is an authentication error
        if (isAuthenticationError(error) && !retryAttempted) {
          console.log('[RSocket] Authentication error in channel, attempting token refresh...');
          retryAttempted = true;

          try {
            // Attempt to refresh the token
            await refreshAccessToken();

            // Disconnect the old connection
            disconnectRSocket();

            // Retry opening the channel with the new token
            console.log('[RSocket] Retrying channel with refreshed token...');
            await openChannel();
          } catch (refreshError) {
            console.error('[RSocket] Token refresh failed for channel:', refreshError);
            // Disconnect and notify error handler
            disconnectRSocket();
            handlers.onError?.(error);
          }
        } else {
          // Not an auth error or retry already attempted
          if (retryAttempted) {
            disconnectRSocket();
          }
          handlers.onError?.(error);
        }
      },
      onComplete: () => handlers.onComplete?.(),
      onExtension: () => {},
      request: (_n: number) => {},
      cancel: () => {},
    } as unknown as Cancellable & Requestable & {
      onNext: (payload: any, isComplete: boolean) => void;
      onError: (error: Error) => void;
      onComplete: () => void;
      onExtension: () => void;
      request: (n: number) => void;
      cancel: () => void;
    };

    // Open the channel
    currentChannel = socket.requestChannel(payload, 2147483647, false, responder);
  };

  // Initial channel open
  await openChannel();

  return {
    send: (data: any, isComplete = false) => {
      try {
        if (currentChannel) {
          currentChannel.onNext({ data: encodeData(data), metadata: undefined as any }, isComplete);
        }
      } catch (e) {
        console.warn('[RSocket] Failed to send channel payload', e);
      }
    },
    complete: () => {
      try {
        if (currentChannel) {
          currentChannel.onComplete();
        }
      } catch {}
    },
    cancel: () => {
      try {
        if (currentChannel) {
          currentChannel.cancel();
        }
      } catch {}
    },
    request: (n: number) => {
      try {
        if (currentChannel) {
          currentChannel.request(n);
        }
      } catch {}
    },
  };
}
