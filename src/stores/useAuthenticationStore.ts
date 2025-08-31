import { create } from 'zustand';
import { createStorageManager } from './ClientStorageManager';
import { JsonValue } from "@/types.ts";

// Define the store state interface
interface AuthState {
  // Authentication tokens
  userId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  authProvider: 'FIGMA' | 'GITHUB' | null; // Changed to allow null

  // Loading states
  isLoading: boolean;

  // Actions
  setUserId: (userId: string | null) => void;
  setAccessToken: (token: string | null) => void;
  setRefreshToken: (token: string | null) => void;
  setAuthenticated: (isAuthenticated: boolean) => void;
  setAuthProvider: (provider: 'FIGMA' | 'GITHUB' | null) => void; // Changed to allow null

  // Logout action
  logout: () => void;

  // Persistence actions
  loadFromStorage: () => Promise<void>;
  saveToStorage: () => Promise<void>;
  clearStorage: () => Promise<void>;
}

// Define the persistable state that is JSON compatible
interface PersistableAuthState {
  userId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  authProvider: 'FIGMA' | 'GITHUB' | null; // Changed to allow null
  [key: string]: JsonValue;
}

// Storage key for persisting the store
const STORAGE_KEY = 'auth-store';

const clientStorageManager = createStorageManager<PersistableAuthState>();

// Create the zustand store
export const useAuthenticationStore = create<AuthState>((set, get) => ({
  // Initial state
  userId: null,
  accessToken: null,
  refreshToken: null,
  isAuthenticated: false,
  isLoading: false,
  authProvider: null, // Default to null

  // Authentication actions
  setUserId: (userId) => {
    set({ userId });
    get().saveToStorage();
  },

  setAccessToken: (token) => {
    set({ accessToken: token });
    if (token) {
      set({ isAuthenticated: true });
    }
    get().saveToStorage();
  },

  setRefreshToken: (token) => {
    set({ refreshToken: token });
    get().saveToStorage();
  },

  setAuthenticated: (isAuthenticated) => {
    set({ isAuthenticated });
    // If not authenticated anymore, clear tokens
    if (!isAuthenticated) {
      set({ accessToken: null, refreshToken: null, userId: null });
    }
    get().saveToStorage();
  },

  setAuthProvider: (provider) => {
    set({ authProvider: provider });
    get().saveToStorage();
  },

  // Logout action
  logout: () => {
    set({
      userId: null,
      accessToken: null, 
      refreshToken: null, 
      isAuthenticated: false,
      authProvider: null // Clear authProvider on logout
    });
    get().saveToStorage();
  },

  // Persistence actions
  loadFromStorage: async () => {
    try {
      set({ isLoading: true });
      const stored = await clientStorageManager.getItem(STORAGE_KEY);
      
      if (stored) {
        set({
          userId: stored.userId || null,
          accessToken: stored.accessToken || null,
          refreshToken: stored.refreshToken || null,
          isAuthenticated: stored.isAuthenticated || false,
          authProvider: stored.authProvider || null, // Load authProvider from storage, default to null
        });
      }
    } catch (error) {
      console.error('Error loading authentication state from storage:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  saveToStorage: async () => {
    try {
      const state = get();
      const stateToSave: PersistableAuthState = {
        userId: state.userId,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
        authProvider: state.authProvider, // Save authProvider to storage
      };

      await clientStorageManager.setItem(STORAGE_KEY, stateToSave);
    } catch (error) {
      console.error('Error saving authentication state to storage:', error);
    }
  },

  clearStorage: async () => {
    try {
      await clientStorageManager.removeItem(STORAGE_KEY);
      set({
        userId: null,
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
        authProvider: null, // Reset authProvider to null on clear
      });
    } catch (error) {
      console.error('Error clearing authentication storage:', error);
    }
  },
}));

// Initialize the store by loading from storage when the module is imported
useAuthenticationStore.getState().loadFromStorage();