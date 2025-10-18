import { create } from "zustand";
import { ConnectionState } from "@companion/api/ConnectionManager.ts";

interface CompanionState {
  // Single source of truth for connection state
  connectionState: ConnectionState;
  
  // Additional state that cannot be derived from connectionState
  isCompanionConnecting: boolean;
  companionError: string | null;

  // Actions
  setConnectionState: (state: ConnectionState) => void;
  setCompanionConnecting: (connecting: boolean) => void;
  setCompanionError: (error: string | null) => void;
}


export const useCompanionStore = create<CompanionState>((set) => ({
  // Initial state
  connectionState: ConnectionState.DISCONNECTED,
  isCompanionConnecting: false,
  companionError: null,

  // Actions
  setConnectionState: (state: ConnectionState) => {
    set({ connectionState: state });
  },

  setCompanionConnecting: (connecting: boolean) => {
    set({ isCompanionConnecting: connecting });
  },

  setCompanionError: (error: string | null) => {
    set({ companionError: error });
  },
}));
