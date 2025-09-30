import { create } from "zustand";

interface CompanionState {
  encryptionKey: string | null
  keyExpiresAt: Date | null;

  // Connection management
  handshakeDone: boolean;
  
  // Connection states - Companion App
  isCompanionConnected: boolean;
  isCompanionConnecting: boolean;
  companionError: string | null;

  // Actions - Key management
  setKeys: (encryptionKey: string, expiresAt: Date) => void;
  clearKeys: () => void;

  // Actions - CompanionApp communication management
  setHandshakeDone: (done: boolean) => void;

  // Actions - Connection management
  setCompanionConnected: (connected: boolean) => void;
  setCompanionConnecting: (connecting: boolean) => void;
  setCompanionError: (error: string | null) => void;
}


export const useCompanionStore = create<CompanionState>((set, get) => ({
  // Initial state - Keys
  encryptionKey: null,
  keyExpiresAt: null,

  // Initial state - Connection management
  handshakeDone: false,
  
  // Initial state - Companion Connection
  isCompanionConnected: false,
  isCompanionConnecting: false,
  companionError: null,

  // Set encryption key
  setKeys: (encryptionKey: string, expiresAt: Date) => {
    set({ 
      encryptionKey,
      keyExpiresAt: expiresAt,
    });
  },

  // Clear keys
  clearKeys: () => {
    set({ 
      encryptionKey: null,
      keyExpiresAt: null,
    });
  },

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
