import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

// Define the simplified auth state interface
interface AuthState {
  // Authentication tokens
  accessToken: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: string | null;
  aesGcm: string | null;
  userId: string | null;

  // Loading states
  isLoading: boolean;

  // Computed properties
  isAuthenticated: boolean;

  // Actions
  setIsAuthenticated: (isAuthenticated: boolean) => void;
  setAccessToken: (token: string | null) => void;
  setRefreshToken: (token: string | null) => void;
  setRefreshTokenExpiresAt: (expiresAt: string | null) => void;
  setAesGcm: (aesGcm: string | null) => void;
  setUserId: (userId: string | null) => void;

  // Logout action
  logout: () => void;

  // Persistence actions
  loadFromStorage: () => Promise<void>;
  saveToStorage: () => Promise<void>;
  clearStorage: () => Promise<void>;
}

// Define the credential structure for keyring storage
interface AuthCredentials {
  access_token: string | null;
  refresh_token: string | null;
  refresh_token_expires_at: string | null;
  aes_gcm: string | null;
  user_id: string | null;
}

// Create the zustand store
export const useAuthenticationStore = create<AuthState>()((set, get) => ({
  // Initial state
  accessToken: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
  aesGcm: null,
  userId: null,
  isLoading: false,
  isAuthenticated: false,

  // Authentication actions
  setIsAuthenticated: (isAuthenticated) => {
    set({ isAuthenticated });
  },

  setAccessToken: (token) => {
    set({ accessToken: token });
    get().saveToStorage();
  },

  setRefreshToken: (token) => {
    set({ refreshToken: token });
    get().saveToStorage();
  },

  setRefreshTokenExpiresAt: (expiresAt: string | null) => {
    set({ refreshTokenExpiresAt: expiresAt });
    get().saveToStorage();
  },

  setAesGcm: (aesGcm) => {
    set({ aesGcm });
    get().saveToStorage();
  },

  setUserId: (userId) => {
    set({ userId });
    get().saveToStorage();
  },

  // Logout action
  logout: () => {
    set({
      accessToken: null, 
      refreshToken: null, 
      refreshTokenExpiresAt: null,
      aesGcm: null,
      userId: null,
      isAuthenticated: false
    });
    get().clearStorage();
  },

  // Persistence actions
  loadFromStorage: async () => {
    try {
      set({ isLoading: true });
      
      // First check authentication status from backend
      const isAuthenticated = await invoke<boolean>('is_authenticated');
      
      if (isAuthenticated) {
        // Only fetch credentials if authenticated
        try {
          const credentials = await invoke<AuthCredentials>('get_credentials');
          
          set({
            accessToken: credentials.access_token || null,
            refreshToken: credentials.refresh_token || null,
            refreshTokenExpiresAt: credentials.refresh_token_expires_at || null,
            aesGcm: credentials.aes_gcm || null,
            userId: credentials.user_id || null,
            isAuthenticated: true,
          });
        } catch (error) {
          // If getting credentials fails, user is not authenticated
          console.error('Error fetching credentials:', error);
          set({ isAuthenticated: false });
        }
      } else {
        // Not authenticated, clear local state
        set({
          accessToken: null,
          refreshToken: null,
          refreshTokenExpiresAt: null,
          aesGcm: null,
          userId: null,
          isAuthenticated: false,
        });
      }
    } catch (error) {
      console.error('Error checking authentication status:', error);
      // On error, assume not authenticated
      set({ isAuthenticated: false });
    } finally {
      set({ isLoading: false });
    }
  },

  saveToStorage: async () => {
    try {
      const state = get();
      const credentials: AuthCredentials = {
        access_token: state.accessToken,
        refresh_token: state.refreshToken,
        refresh_token_expires_at: state.refreshTokenExpiresAt,
        aes_gcm: state.aesGcm,
        user_id: state.userId,
      };

      await invoke('set_credentials', { credentials });
    } catch (error) {
      console.error('Error saving authentication state to keyring:', error);
    }
  },

  clearStorage: async () => {
    try {
      await invoke('delete_credentials');
      set({
        accessToken: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        aesGcm: null,
        userId: null,
      });
    } catch (error) {
      console.error('Error clearing authentication storage:', error);
    }
  },
}));

// Initialize the store by loading from storage when the module is imported
useAuthenticationStore.getState().loadFromStorage();