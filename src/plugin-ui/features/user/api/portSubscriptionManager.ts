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

import { getSharedWebSocket } from '@shared/api/SharedWebSocketClient';
import { usePortUpdatesStore } from '../stores/usePortUpdatesStore';

interface AppState {
  port: number | null;
  nonce?: number;
}

let unsubscribeCallbacks: (() => void)[] = [];
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
  
  console.log('🔌 Initializing port subscription manager...');
  const wsClient = getSharedWebSocket();
  
  // Subscribe to connection open events - auto-subscribe to port updates
  const unsubscribeOpen = wsClient.onOpen(() => {
    console.log('📡 Port subscription: WebSocket opened, subscribing to port updates...');
    
    // Send a subscription message
    // AsyncAPI 3.0.0 format: { type: "user:subscribe_ports", payload: {} }
    wsClient.send('user:subscribe_ports', {});
    console.log('✅ Subscribed to port updates');
  });
  
  // Subscribe to port update messages
  const unsubscribePortUpdate = wsClient.on('user:port_update', (message: any) => {
    const appState = message.payload as AppState;
    const newPort = appState.port;
    
    const currentPort = usePortUpdatesStore.getState().currentPort;
    if (newPort !== currentPort) {
      console.log('📡 Port updated:', newPort);
      usePortUpdatesStore.getState().setCurrentPort(newPort);
    }
  });
  
  // Subscribe to connection close events
  const unsubscribeClose = wsClient.onClose(() => {
    console.log('🔌 Port subscription: WebSocket closed');
    // Note: We don't clear the port value on close, it remains until a new value arrives
  });
  
  // Store cleanup callbacks
  unsubscribeCallbacks = [
    unsubscribeOpen,
    unsubscribeClose,
    unsubscribePortUpdate
  ];
  
  isInitialized = true;
  console.log('✅ Port subscription manager initialized');
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
  
  console.log('🧹 Cleaning up port subscription manager...');
  
  const wsClient = getSharedWebSocket();
  
  // Send unsubscribe message if connected
  if (wsClient.isConnected()) {
    wsClient.send('user:unsubscribe_ports', {});
    console.log('📡 Unsubscribed from port updates');
  }
  
  // Clean up all subscriptions
  unsubscribeCallbacks.forEach(unsub => unsub());
  unsubscribeCallbacks = [];
  
  // Reset store
  usePortUpdatesStore.getState().reset();
  
  isInitialized = false;
  console.log('✅ Port subscription manager cleaned up');
}

/**
 * Check if port subscription is initialized
 */
export function isPortSubscriptionInitialized(): boolean {
  return isInitialized;
}