import { create } from 'zustand';
import { uiStoreMessaging } from '@/plugin-ui/UIMessageDispatcher.ts';
import { PersistableAuthState } from '@shared-types/authTypes.ts';

// Define the store state interface
interface AuthState {
  // Authentication tokens
  userId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
  isAuthenticated: boolean;
  authProvider: 'FIGMA' | 'GITHUB' | 'AUTH0' | null;

  // Loading states
  isLoading: boolean;

  // Actions - now with automatic sync
  setUserId: (userId: string | null) => Promise<void>;
  setAccessToken: (token: string | null) => Promise<void>;
  setRefreshToken: (token: string | null, tokenExpiresAt: number | null) => Promise<void>;
  setAuthenticated: (isAuthenticated: boolean) => Promise<void>;
  setAuthProvider: (provider: 'FIGMA' | 'GITHUB' | 'AUTH0' | null) => Promise<void>;

  // Logout action
  logout: () => Promise<void>;

  // Persistence actions
  loadFromStorage: () => Promise<void>;
  saveToStorage: () => Promise<void>;
  clearStorage: () => Promise<void>;
}

// Create the zustand store with automatic synchronization
export const useAuthenticationStore = create<AuthState>((set, get) => ({
  // Initial state
  userId: null,
  accessToken: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
  isAuthenticated: false,
  isLoading: false,
  authProvider: null,

  // Authentication actions with automatic sync
  setUserId: async (userId) => {
    set({ userId });
    await get().saveToStorage();
  },

  setAccessToken: async (token) => {
    set({ 
      accessToken: token,
      isAuthenticated: !!token
    });
    await get().saveToStorage();
  },

  setRefreshToken: async (token, tokenExpiresAt) => {
    set({ refreshToken: token, refreshTokenExpiresAt: tokenExpiresAt });
    await get().saveToStorage();
  },

  setAuthenticated: async (isAuthenticated) => {
    set({ isAuthenticated });
    // If not authenticated anymore, clear tokens
    if (!isAuthenticated) {
      set({ accessToken: null, refreshToken: null, userId: null });
    }
    await get().saveToStorage();
  },

  setAuthProvider: async (provider) => {
    set({ authProvider: provider });
    await get().saveToStorage();
  },

  // Logout action with sync
  logout: async () => {
    set({
      userId: null,
      accessToken: null, 
      refreshToken: null, 
      refreshTokenExpiresAt: null,
      isAuthenticated: false,
      authProvider: null
    });
    await get().saveToStorage();
  },

  // Fixed persistence actions using StoreMessaging
  loadFromStorage: async () => {
    try {
      set({ isLoading: true });
      console.log('[AUTH STORE] Loading authentication state from code...');
      
      const result = await uiStoreMessaging.getState<PersistableAuthState>('authentication');
      console.log('[AUTH STORE] Received state from code:', result);
      
      // ✅ Correct: access result.state, not result.payload
      const authState = result.state;
      
      set({
        userId: authState.userId || null,
        accessToken: authState.accessToken || null,
        refreshToken: authState.refreshToken || null,
        refreshTokenExpiresAt: authState.refreshTokenExpiresAt || null,
        isAuthenticated: !!(authState.refreshTokenExpiresAt && Date.now() < authState.refreshTokenExpiresAt),
        authProvider: authState.authProvider || null,
      });
      
      console.log('[AUTH STORE] State loaded successfully');
    } catch (error) {
      console.error('[AUTH STORE] Error loading authentication state from storage:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  saveToStorage: async () => {
    try {
      const state = get();
      console.log('[AUTH STORE] Saving authentication state to code:', {
        userId: state.userId,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        refreshTokenExpiresAt: state.refreshTokenExpiresAt,
        authProvider: state.authProvider,
      });
      
      const result = await uiStoreMessaging.updateState<PersistableAuthState>('authentication', {
        userId: state.userId,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        refreshTokenExpiresAt: state.refreshTokenExpiresAt,
        authProvider: state.authProvider,
      });
      
      console.log('[AUTH STORE] State saved successfully:', result);
    } catch (error) {
      console.error('[AUTH STORE] Error saving authentication state to storage:', error);
      throw error; // Re-throw to let caller handle
    }
  },

  clearStorage: async () => {
    try {
      console.log('[AUTH STORE] Clearing authentication state...');
      
      // ✅ Correct: send valid PersistableAuthState with null values
      const result = await uiStoreMessaging.updateState<PersistableAuthState>('authentication', {
        userId: null,
        accessToken: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        authProvider: null,
      });
      
      set({
        userId: null,
        accessToken: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        isAuthenticated: false,
        authProvider: null,
      });
      
      console.log('[AUTH STORE] Storage cleared successfully:', result);
    } catch (error) {
      console.error('[AUTH STORE] Error clearing authentication storage:', error);
      throw error;
    }
  },
}));

// Initialize the store by loading from storage when the module is imported
useAuthenticationStore.getState().loadFromStorage();
