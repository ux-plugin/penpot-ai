/**
 * useWebSocketStore - Centralized WebSocket connection state management
 * 
 * This store manages the shared WebSocket connection lifecycle for all features.
 * It wraps the SharedWebSocketClient singleton and provides reactive state.
 * 
 * Features using the WebSocket (port updates, completions, etc.) should:
 * 1. Read connection state from this store
 * 2. Use their own subscription managers for feature-specific logic
 * 3. NOT manage the connection lifecycle themselves
 */

import { create } from 'zustand';
import { getSharedWebSocket } from '@shared/api/SharedWebSocketClient';

interface WebSocketStore {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  
  connect: () => Promise<void>;
  disconnect: () => void;
  reset: () => void;
}

export const useWebSocketStore = create<WebSocketStore>((set, get) => ({
  isConnected: false,
  isConnecting: false,
  error: null,
  
  connect: async () => {
    const { isConnecting, isConnected } = get();
    
    // Prevent multiple connection attempts
    if (isConnecting || isConnected) {
      console.log('WebSocket already connected or connecting');
      return;
    }
    
    set({ isConnecting: true, error: null });
    
    const wsClient = getSharedWebSocket();
    
    // Set up connection state callbacks
    const unsubscribeOpen = wsClient.onOpen(() => {
      console.log('✅ WebSocket store: Connection opened');
      set({ isConnected: true, isConnecting: false, error: null });
    });
    
    const unsubscribeClose = wsClient.onClose(() => {
      console.log('🔌 WebSocket store: Connection closed');
      set({ isConnected: false, isConnecting: false });
    });
    
    const unsubscribeError = wsClient.onError((event) => {
      console.error('❌ WebSocket store: Connection error:', event);
      set({ 
        error: 'WebSocket connection error',
        isConnecting: false,
        isConnected: false
      });
    });
    
    try {
      await wsClient.connect();
      console.log('✅ WebSocket store: Connected successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect';
      console.error('❌ WebSocket store: Connection failed:', errorMessage);
      set({ 
        error: errorMessage,
        isConnecting: false,
        isConnected: false
      });
      
      // Clean up callbacks on connection failure
      unsubscribeOpen();
      unsubscribeClose();
      unsubscribeError();
      
      throw error;
    }
  },
  
  disconnect: () => {
    console.log('🔌 WebSocket store: Disconnecting...');
    const wsClient = getSharedWebSocket();
    wsClient.close();
    
    set({ 
      isConnected: false,
      isConnecting: false,
      error: null
    });
  },
  
  reset: () => {
    console.log('🔄 WebSocket store: Resetting state...');
    const wsClient = getSharedWebSocket();
    wsClient.close();
    
    set({ 
      isConnected: false,
      isConnecting: false,
      error: null
    });
  }
}));