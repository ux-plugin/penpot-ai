import { create } from 'zustand';
import { uiStoreMessaging } from '@/messaging/UIMessageDispatcher';

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
  
  // Messaging integration
  set_state: (payload: any) => void;
  set_update: (payload: any) => Promise<void>;
  get_update: () => Promise<any>;
}

// Create the zustand store
export const useAuthenticationStore = create<AuthState>((set) => ({
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
  },

  setAccessToken: (token) => {
    set({ accessToken: token });
    if (token) {
      set({ isAuthenticated: true });
    }
  },

  setRefreshToken: (token) => {
    set({ refreshToken: token });
  },

  setAuthenticated: (isAuthenticated) => {
    set({ isAuthenticated });
    // If not authenticated anymore, clear tokens
    if (!isAuthenticated) {
      set({ accessToken: null, refreshToken: null, userId: null });
    }
  },

  setAuthProvider: (provider) => {
    set({ authProvider: provider });
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
  },

  // Persistence actions using StoreMessaging
  loadFromStorage: async () => {
    try {
      set({ isLoading: true });
      const result = await uiStoreMessaging.updateState('authentication', { action: 'load' });
      
      if (result.action === 'load' && result.success && result.state) {
        set({
          userId: result.state.userId || null,
          accessToken: result.state.accessToken || null,
          refreshToken: result.state.refreshToken || null,
          isAuthenticated: result.state.isAuthenticated || false,
          authProvider: result.state.authProvider || null,
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
      await uiStoreMessaging.updateState('authentication', { action: 'save' });
    } catch (error) {
      console.error('Error saving authentication state to storage:', error);
    }
  },

  clearStorage: async () => {
    try {
      await uiStoreMessaging.updateState('authentication', { action: 'clear' });
      set({
        userId: null,
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
        authProvider: null,
      });
    } catch (error) {
      console.error('Error clearing authentication storage:', error);
    }
  },

  // Messaging integration
  set_state: async (payload: any) => {
    // Update local state with payload
    set(payload);
    
    try {
      // Trigger update to code.ts and wait for confirmation
      const result = await uiStoreMessaging.updateState('authentication', payload);
      console.log('State synchronized with code.ts:', result);
    } catch (error) {
      console.error('Failed to sync state with code.ts:', error);
      // Optionally revert local state or show error to user
    }
  },

  // Set state locally and send update message to code.ts
  set_update: async (payload: any) => {
    console.log('[UI AUTH STORE] Received set_update request:', payload);
    
    // Update local state with payload
    set(payload);
    console.log('[UI AUTH STORE] Local state updated');

    try {
      // Send state update message to code.ts
      const result = await uiStoreMessaging.updateState('authentication', payload);
      console.log('[UI AUTH STORE] State synchronized with code.ts:', result);
    } catch (error) {
      console.error('[UI AUTH STORE] Failed to sync state with code.ts:', error);
      // Optionally revert local state change if code.ts sync fails
    }
  },

  // Get current state from code.ts
  get_update: async () => {
    try {
      // Request current state from code.ts
      const result = await uiStoreMessaging.getState('authentication');
      console.log('Retrieved state from code.ts:', result);
      return result.state;
    } catch (error) {
      console.error('Failed to get state from code.ts:', error);
      throw error;
    }
  },
}));

// Initialize the store by loading from storage when the module is imported
useAuthenticationStore.getState().loadFromStorage();