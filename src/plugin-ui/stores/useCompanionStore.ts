import { create } from "zustand";
import { WebSocketState } from "@/plugin-ui/api/companion/companionWebSocketClient.ts";

interface CompanionState {
  // Single source of truth for WebSocket state
  webSocketState: WebSocketState;
  
  // Recording state
  isRecording: boolean;
  recordingError: string | null;

  // Actions
  setWebSocketState: (state: WebSocketState) => void;
  setIsRecording: (recording: boolean) => void;
  setRecordingError: (error: string | null) => void;
}

export const useCompanionStore = create<CompanionState>((set) => ({
  // Initial state
  webSocketState: WebSocketState.DISCONNECTED,
  isRecording: false,
  recordingError: null,

  // Actions
  setWebSocketState: (state: WebSocketState) => {
    set({ webSocketState: state });
  },

  setIsRecording: (recording: boolean) => {
    set({ isRecording: recording });
  },

  setRecordingError: (error: string | null) => {
    set({ recordingError: error });
  },
}));

// Computed selectors
export const selectIsCompanionConnecting = (state: CompanionState): boolean => {
  return state.webSocketState === WebSocketState.CONNECTING || 
         state.webSocketState === WebSocketState.RECONNECTING;
};

export const selectIsConnected = (state: CompanionState): boolean => {
  return state.webSocketState === WebSocketState.CONNECTED;
};
