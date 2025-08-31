import { create } from 'zustand';
import { createStorageManager } from './ClientStorageManager';
import { JsonValue } from "@/types.ts";
import { UserConfig } from '@/api/user/fetchUserConfig.ts'; // Import UserConfig type

interface SocialLogin {
  provider: ("GITHUB" | "FIGMA");
  id: string;
}
interface UserSettingsState {
  keyboardShortcut: string[];
  socialLogins: Set<SocialLogin>;
  name: string;
  email: string;
  allowSavingCompletions: boolean;
  setKeyboardShortcut: (shortcut: string[]) => void;
  setSocialLogins: (provider: ("GITHUB" | "FIGMA"), id: string) => void;
  deleteSocialLogin: (provider: ("GITHUB" | "FIGMA"), id: string) => void;
  setName: (name: string) => void;
  setEmail: (email: string) => void;
  setAllowSavingCompletions: (allow: boolean) => void;
  setUserConfig: (config: UserConfig) => void; // New action to set all user config at once
  loadFromStorage: () => Promise<void>;
  saveToStorage: () => Promise<void>;
  clearStorage: () => Promise<void>;
}

interface PersistableUserSettingsState {
  name: string;
  email: string;
  keyboardShortcut: string[];
  allowSavingCompletions: boolean;
  [key: string]: JsonValue;
}

const STORAGE_KEY = 'user-settings-store';

const clientStorageManager = createStorageManager<PersistableUserSettingsState>();

export const useUserSettingsStore = create<UserSettingsState>((set, get) => ({
  keyboardShortcut: ['Ctrl', 'Shift', 'R'],
  name: '',
  email: '',
  allowSavingCompletions: true,
  socialLogins: new Set<SocialLogin>(),
  setSocialLogins: (provider, id) =>
    set((state) => ({
      socialLogins: state.socialLogins.add({provider: provider, id: id}),
    })),
  deleteSocialLogin: (provider, id) =>
    set((state) => {
      const updatedSocialLogins = new Set(
        Array.from(state.socialLogins).filter(
          (socialLogin) =>
            !(socialLogin.provider === provider && socialLogin.id === id)
        )
      );
      return {
        socialLogins: updatedSocialLogins,
      };
    }),
  setKeyboardShortcut: (shortcut: string[]) => {
    set({ keyboardShortcut: shortcut });
    get().saveToStorage();
  },
  setName: (name?: string) => {
    set({ name: name || '' });
    get().saveToStorage();
  },
  setEmail: (email?: string) => {
    set({ email: email || '' });
    get().saveToStorage();
  },
  setAllowSavingCompletions: (allow: boolean) => {
    set({ allowSavingCompletions: allow });
    get().saveToStorage();
  },
  // New action to set all user configuration properties
  setUserConfig: (config: UserConfig) => {
    set({
      name: config.name,
      email: config.username, // Assuming 'username' from UserConfig maps to 'email' in UserSettingsState
      allowSavingCompletions: config.allowSavingCompletions,
    });
    get().saveToStorage();
  },

  loadFromStorage: async () => {
    try {
      const stored = await clientStorageManager.getItem(STORAGE_KEY);
      if (stored) {
        set({
          name: stored.name || '',
          email: stored.email || '',
          keyboardShortcut: stored.keyboardShortcut || ['Ctrl', 'Shift', 'R'],
          allowSavingCompletions: stored.allowSavingCompletions !== undefined ? stored.allowSavingCompletions : true,
        });
      }
    } catch (error) {
      console.error('Error loading user settings from storage:', error);
    }
  },

  saveToStorage: async () => {
    try {
      const state = get();
      const stateToSave: PersistableUserSettingsState = {
        name: state.name,
        email: state.email,
        keyboardShortcut: state.keyboardShortcut,
        allowSavingCompletions: state.allowSavingCompletions,
      };
      await clientStorageManager.setItem(STORAGE_KEY, stateToSave);
    } catch (error) {
      console.error('Error saving user settings to storage:', error);
    }
  },

  clearStorage: async () => {
    try {
      await clientStorageManager.removeItem(STORAGE_KEY);
      set({
        name: '',
        email: '',
        keyboardShortcut: ['Ctrl', 'Shift', 'R'],
        allowSavingCompletions: true,
      });
    } catch (error) {
      console.error('Error clearing user settings storage:', error);
    }
  },
}));

useUserSettingsStore.getState().loadFromStorage();
