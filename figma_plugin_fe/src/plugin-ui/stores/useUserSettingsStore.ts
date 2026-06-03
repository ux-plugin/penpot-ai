import { create } from 'zustand';
import { UserConfig } from '@/plugin-ui/api/user/fetchUserConfig.ts'; // Import UserConfig type

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
}


export const useUserSettingsStore = create<UserSettingsState>((set) => ({
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
  },
  setName: (name?: string) => {
    set({ name: name || '' });
  },
  setEmail: (email?: string) => {
    set({ email: email || '' });
  },
  setAllowSavingCompletions: (allow: boolean) => {
    set({ allowSavingCompletions: allow });
  },
  // New action to set all user configuration properties
  setUserConfig: (config: UserConfig) => {
    set({
      name: config.name,
      email: config.username, // Assuming 'username' from UserConfig maps to 'email' in UserSettingsState
      allowSavingCompletions: config.allowSavingCompletions,
    });
  },
}));
