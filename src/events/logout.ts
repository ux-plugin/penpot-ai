import { listen } from '@tauri-apps/api/event';
import {useAuthenticationStore} from "@/stores/useAuthenticationStore.ts";

listen<void>('logout', () => {
    const authStore = useAuthenticationStore.getState();
    authStore.logout();
});