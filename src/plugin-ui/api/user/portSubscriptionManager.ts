/**
 * Port Subscription Manager
 * 
 * Manages automatic subscription to port updates when WebSocket connects.
 * This ensures that port updates are automatically resubscribed after reconnection.
 * 
 * Key features:
 * - Auto-subscribes on WebSocket open
 * - Updates usePortUpdatesStore when port changes
 * - Handles cleanup on uninitialization
 */

import { usePortUpdatesStore } from '@/plugin-ui/stores/usePortUpdatesStore.ts';
import { connectRSocket, subscribeToUserPortsStream, disconnectRSocket, onRSocketOpen, onRSocketClose } from '@api/rsocket.ts';

let unsubscribeCallbacks: (() => void)[] = [];
let cancelPortsStream: (() => void) | null = null;
let isInitialized = false;

/**
 * Initialize port update subscriptions
 * This should be called once when the app starts (after authentication)
 */
export function initializePortSubscription(): void {
  if (isInitialized) {
    console.warn('Port subscription already initialized');
    return;
  }
  
  console.log('🔌 Initializing port subscription manager (RSocket)...');

  // Subscribe to RSocket lifecycle for logging
  const unsubscribeOpen = onRSocketOpen(() => {
    console.log('📡 Port subscription: RSocket connected');
  });
  const unsubscribeClose = onRSocketClose(() => {
    console.log('🔌 Port subscription: RSocket closed');
  });

  unsubscribeCallbacks = [unsubscribeOpen, unsubscribeClose];

  // Connect and subscribe to the user ports stream
  connectRSocket()
    .then(() => subscribeToUserPortsStream())
    .then((cancel) => {
      cancelPortsStream = cancel;
      console.log('✅ Subscribed to user.ports.stream');
    })
    .catch((error) => {
      console.error('❌ Failed to initialize RSocket ports stream:', error);
    });

  isInitialized = true;
  console.log('✅ Port subscription manager initialized (RSocket)');
}

/**
 * Clean up port subscriptions
 * This should be called when logging out or when the feature is no longer needed
 */
export function cleanupPortSubscription(): void {
  if (!isInitialized) {
    console.warn('Port subscription not initialized, nothing to clean up');
    return;
  }
  
  console.log('🧹 Cleaning up port subscription manager (RSocket)...');

  // Cancel stream subscription
  try {
    cancelPortsStream?.();
  } catch {}
  cancelPortsStream = null;

  // Clean up lifecycle subscriptions
  unsubscribeCallbacks.forEach(unsub => unsub());
  unsubscribeCallbacks = [];

  // Reset store
  usePortUpdatesStore.getState().reset();

  // Close shared RSocket connection
  disconnectRSocket();

  isInitialized = false;
  console.log('✅ Port subscription manager cleaned up (RSocket)');
}