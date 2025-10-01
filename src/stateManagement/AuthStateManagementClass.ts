// Authentication state management class for code.ts
// Mirrors the UI store structure but adapted for the worker environment

import { codeStoreMessaging } from '@/messaging/CodeMessageDispatcher';
import { IDesignPlatform } from '@/platform/IDesignPlatform';
import { PersistableAuthState } from '@/types/authTypes';

// Storage key for persisting the store
const STORAGE_KEY = 'auth-store';

export class AuthStateManagementClass {
  private data: PersistableAuthState;
  private commands: IDesignPlatform;

  constructor(commands: IDesignPlatform) {
    this.commands = commands;
    
    // Initialize with the default state matching UI store
    this.data = {
      userId: null,
      accessToken: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
      authProvider: null
    };
    
    this.loadFromStorage().then(state => {
      this.data = state || this.data;
      console.log('[AUTH STATE] Loaded state from storage:', this.data);
    })
    
    console.log('[AUTH STATE] Authentication state management initialized');
  }

  /**
   * Set the state and save it to local storage with enhanced type safety
   */
  setState = async (payload: Partial<PersistableAuthState>): Promise<void> => {
    console.log('[AUTH STATE] Received state update:', payload);
    
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid payload: must be a valid state object');
    }
    
    // Validate payload properties
    const validKeys = ['userId', 'accessToken', 'refreshToken', 'refreshTokenExpiresAt', 'authProvider'];
    const invalidKeys = Object.keys(payload).filter(key => !validKeys.includes(key));
    if (invalidKeys.length > 0) {
      console.warn('[AUTH STATE] Invalid keys in payload:', invalidKeys);
    }

    // Regular state update
    this.data = { ...this.data, ...payload };
    console.log('[AUTH STATE] State updated:', this.data);

    return this.saveToStorage();

  };

  /**
   * Get current state - required for StoreMessaging integration
   * This method is called when the UI requests current state
   */
  getState = (): PersistableAuthState => {
    console.log('[AUTH STATE] State requested, returning:', this.data);
    return { ...this.data };
  };

  /**
   * Set state and update the UI
   * This method updates the local state and sends a message to the UI to synchronize
   */
  setUpdate = async (payload: Partial<PersistableAuthState>): Promise<void> => {
    console.log('[AUTH STATE] Received setUpdate request:', payload);

    // Update local state
    this.data = { ...this.data, ...payload };
    console.log('[AUTH STATE] Local state updated:', this.data);

    try {
      // Send state update message to UI
      const result = await codeStoreMessaging.updateState('authentication', payload);
      console.log('[AUTH STATE] State synchronized with UI:', result);

      return this.saveToStorage();
    } catch (error) {
      console.error('[AUTH STATE] Failed to sync state with UI:', error);

    }
  };

  /**
   * Save current state to storage
   */
  saveToStorage = async (): Promise<void> => {
    try {
      const stateToSave: PersistableAuthState = {
        userId: this.data.userId,
        accessToken: this.data.accessToken,
        refreshToken: this.data.refreshToken,
        refreshTokenExpiresAt: this.data.refreshTokenExpiresAt,
        authProvider: this.data.authProvider,
      };
      await this.commands.storage.setAsync(STORAGE_KEY, stateToSave);
      console.log('[AUTH STATE] State saved to storage:', stateToSave);
    } catch (error) {
      console.error('[AUTH STATE] Error saving to storage:', error);
      throw error;
    }
  };

  /**
   * Load state from storage
   */
  loadFromStorage = async (): Promise<PersistableAuthState> => {
    try {
      const stored = await this.commands.storage.getAsync(STORAGE_KEY) as PersistableAuthState | undefined;
      
      if (stored) {
        const loadedState: PersistableAuthState = {
          userId: stored.userId || null,
          accessToken: stored.accessToken || null,
          refreshToken: stored.refreshToken || null,
          refreshTokenExpiresAt: stored.refreshTokenExpiresAt || null,
          authProvider: stored.authProvider || null,
        };
        
        // Update local state
        this.data = { ...this.data, ...loadedState };
        console.log('[AUTH STATE] State loaded from storage:', loadedState);
        return loadedState;
      }
      
      console.log('[AUTH STATE] No stored state found');
      return {
        userId: null,
        accessToken: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        authProvider: null
      };
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
      await this.commands.storage.deleteAsync(STORAGE_KEY);
      
      // Reset state to defaults
      this.data = {
        userId: null,
        accessToken: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        authProvider: null,
      };
      
      console.log('[AUTH STATE] Storage cleared and state reset');
    } catch (error) {
      console.error('[AUTH STATE] Error clearing storage:', error);
      throw error;
    }
  };
}
