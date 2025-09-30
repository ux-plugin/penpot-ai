// Authentication state management class for code.ts
// Mirrors the UI store structure but adapted for the worker environment

import { codeStoreMessaging } from '@/messaging/CodeMessageDispatcher';

interface AuthStateData {
  userId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  authProvider: 'FIGMA' | 'GITHUB' | null;
  isLoading: boolean;
}

interface PersistableAuthState {
  userId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  authProvider: 'FIGMA' | 'GITHUB' | null;
}

// Storage key for persisting the store
const STORAGE_KEY = 'auth-store';

export class AuthStateManagementClass {
  private state: AuthStateData;

  constructor() {
    // Initialize with default state matching UI store
    this.state = {
      userId: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      authProvider: null,
      isLoading: false
    };
    
    console.log('[AUTH STATE] Authentication state management initialized');
  }

  /**
   * Set and update the UI store
   */
  set_state = async (payload: any): Promise<any> => {
    console.log('[AUTH STATE] Received state update:', payload);
    
    // Handle special storage operation commands
    if (payload && typeof payload === 'object' && payload.action) {
      switch (payload.action) {
        case 'save':
          await this.saveToStorage();
          return { action: 'save', success: true };
        case 'load':
          const loadedState = await this.loadFromStorage();
          return { action: 'load', success: true, state: loadedState };
        case 'clear':
          await this.clearStorage();
          return { action: 'clear', success: true };
        default:
          console.warn('[AUTH STATE] Unknown storage action:', payload.action);
          return { action: payload.action, success: false, error: 'Unknown action' };
      }
    }
    
    // Regular state update
    if (payload && typeof payload === 'object') {
      this.state = { ...this.state, ...payload };
      console.log('[AUTH STATE] State updated:', this.state);
      
      // Auto-save after state updates (except for loading operations)
      if (!payload.skipAutoSave) {
        await this.saveToStorage();
      }
    }

    return { success: true, state: this.state };
  };

  /**
   * Get current state - required for StoreMessaging integration
   * This method is called when the UI requests current state
   */
  get_state = (): AuthStateData => {
    console.log('[AUTH STATE] State requested, returning:', this.state);
    return { ...this.state };
  };

  /**
   * Set state and update the UI
   * This method updates the local state and sends a message to the UI to synchronize
   */
  set_update = async (payload: Partial<AuthStateData>): Promise<void> => {
    console.log('[AUTH STATE] Received set_update request:', payload);
    
    // Update local state
    this.state = { ...this.state, ...payload };
    console.log('[AUTH STATE] Local state updated:', this.state);

    try {
      // Send state update message to UI
      const result = await codeStoreMessaging.updateState('authentication', payload);
      console.log('[AUTH STATE] State synchronized with UI:', result);
    } catch (error) {
      console.error('[AUTH STATE] Failed to sync state with UI:', error);
      // Optionally revert local state change if UI sync fails
    }
  };

  /**
   * Save current state to storage
   */
  saveToStorage = async (): Promise<void> => {
    try {
      const stateToSave: PersistableAuthState = {
        userId: this.state.userId,
        accessToken: this.state.accessToken,
        refreshToken: this.state.refreshToken,
        isAuthenticated: this.state.isAuthenticated,
        authProvider: this.state.authProvider,
      };
      await figma.clientStorage.setAsync(STORAGE_KEY, stateToSave);
      console.log('[AUTH STATE] State saved to storage:', stateToSave);
    } catch (error) {
      console.error('[AUTH STATE] Error saving to storage:', error);
      throw error;
    }
  };

  /**
   * Load state from storage
   */
  loadFromStorage = async (): Promise<AuthStateData | null> => {
    try {
      const stored = await figma.clientStorage.getAsync(STORAGE_KEY) as PersistableAuthState | undefined;
      
      if (stored) {
        const loadedState: AuthStateData = {
          userId: stored.userId || null,
          accessToken: stored.accessToken || null,
          refreshToken: stored.refreshToken || null,
          isAuthenticated: stored.isAuthenticated || false,
          authProvider: stored.authProvider || null,
          isLoading: false, // Always reset loading state
        };
        
        // Update local state
        this.state = { ...this.state, ...loadedState };
        console.log('[AUTH STATE] State loaded from storage:', loadedState);
        return loadedState;
      }
      
      console.log('[AUTH STATE] No stored state found');
      return null;
    } catch (error) {
      console.error('[AUTH STATE] Error loading from storage:', error);
      throw error;
    }
  };

  /**
   * Clear state from storage
   */
  clearStorage = async (): Promise<void> => {
    try {
      await figma.clientStorage.deleteAsync(STORAGE_KEY);
      
      // Reset state to defaults
      this.state = {
        userId: null,
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
        authProvider: null,
        isLoading: false,
      };
      
      console.log('[AUTH STATE] Storage cleared and state reset');
    } catch (error) {
      console.error('[AUTH STATE] Error clearing storage:', error);
      throw error;
    }
  };
}