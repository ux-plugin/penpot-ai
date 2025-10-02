import { create } from "zustand";

// Import connection state type
type ConnectionState = 'disconnected' | 'key_ready' | 'connected';

interface CompanionState {
  // Connection management
  handshakeDone: boolean;
  connectionState: ConnectionState;
  
  // Connection states - Companion App
  isCompanionConnected: boolean;
  isCompanionConnecting: boolean;
  companionError: string | null;

  // Actions - CompanionApp communication management
  setHandshakeDone: (done: boolean) => void;
  setConnectionState: (state: ConnectionState) => void;

  // Actions - Connection management
  setCompanionConnected: (connected: boolean) => void;
  setCompanionConnecting: (connecting: boolean) => void;
  setCompanionError: (error: string | null) => void;
}


export const useCompanionStore = create<CompanionState>((set, get) => ({
  // Initial state - Connection management
  handshakeDone: false,
  connectionState: 'disconnected',
  
  // Initial state - Companion Connection
  isCompanionConnected: false,
  isCompanionConnecting: false,
  companionError: null,

  // Handshake management
  setHandshakeDone: (done: boolean) => {
    set({ handshakeDone: done });
  },

  // Connection state management
  setConnectionState: (state: ConnectionState) => {
    set({ connectionState: state });
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
