import { listen } from '@tauri-apps/api/event';
import {useAuthenticationStore} from "@/stores/useAuthenticationStore.ts";

export const reloadAuthStateListener = async () => {
    return listen<void>('reload', async () => {
        console.log('Reload Event Received');
        const authStore = useAuthenticationStore.getState();
        authStore.loadFromStorage();
    });
};