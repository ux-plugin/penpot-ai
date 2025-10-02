import { create } from "zustand";

interface CompanionState {
  // Connection management
  handshakeDone: boolean;
  
  // Connection states - Companion App
  isCompanionConnected: boolean;
  isCompanionConnecting: boolean;
  companionError: string | null;

  // Actions - CompanionApp communication management
  setHandshakeDone: (done: boolean) => void;

  // Actions - Connection management
  setCompanionConnected: (connected: boolean) => void;
  setCompanionConnecting: (connecting: boolean) => void;
  setCompanionError: (error: string | null) => void;
}


export const useCompanionStore = create<CompanionState>((set, get) => ({
  // Initial state - Connection management
  handshakeDone: false,
  
  // Initial state - Companion Connection
  isCompanionConnected: false,
  isCompanionConnecting: false,
  companionError: null,

  // Handshake management
  setHandshakeDone: (done: boolean) => {
    set({ handshakeDone: done });
  },

  // Companion Connection management
  setCompanionConnected: (connected) => {
    set({ 
      isCompanionConnected: connected,
       isCompanionConnecting: false,
      companionError: connected ? null : get().companionError,
    });
  },

  setCompanionConnecting: (connecting) => {
    set({ isCompanionConnecting: connecting, companionError: connecting ? null : get().companionError });
  },

  setCompanionError: (error) => {
    set({ 
      companionError: error, 
      isCompanionConnecting: false, 
      isCompanionConnected: false,
    });
  },
}));
