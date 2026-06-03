/**
 * usePortUpdatesStore - Domain-specific store for port data
 * 
 * This store ONLY manages the current port value received from the backend.
 * It does NOT manage WebSocket connection state - that's handled by useWebSocketStore.
 * 
 * Port subscriptions are managed by portSubscriptionManager which automatically
 * updates this store when port changes are received via WebSocket.
 */

import { create } from 'zustand';

interface PortUpdatesStore {
  currentPort: number | null;
  
  setCurrentPort: (port: number | null) => void;
  reset: () => void;
}

export const usePortUpdatesStore = create<PortUpdatesStore>((set) => ({
  currentPort: null,
  
  setCurrentPort: (port: number | null) => {
    set({ currentPort: port });
  },
  
  reset: () => {
    set({ currentPort: null });
  }
}));
