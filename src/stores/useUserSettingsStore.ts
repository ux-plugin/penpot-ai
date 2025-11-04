import { create } from 'zustand';
import { Store } from '@tauri-apps/plugin-store';

// UserConfig type matching the Rust backend structure
interface UserConfig {
  id: string;
  name?: string;
  username?: string;
  allowSavingCompletions: boolean;
}

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
}

// Storage filename for persisting the store
const STORE_FILENAME = 'user-settings-store.json';

// Initialize Tauri store
let tauriStore: Store | null = null;
const getStore = async (): Promise<Store> => {
  if (!tauriStore) {
    tauriStore = await Store.load(STORE_FILENAME);
  }
  return tauriStore;
};

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
      const store = await getStore();
      const stored = await store.get<PersistableUserSettingsState>('user-settings-data');
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
      const store = await getStore();
      await store.set('user-settings-data', stateToSave);
    } catch (error) {
      console.error('Error saving user settings to storage:', error);
    }
  },

  clearStorage: async () => {
    try {
      const store = await getStore();
      await store.delete('user-settings-data');
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
