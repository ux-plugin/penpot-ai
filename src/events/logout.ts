import { listen } from '@tauri-apps/api/event';
import { Window, getAllWindows } from "@tauri-apps/api/window"
import {useAuthenticationStore} from "@/stores/useAuthenticationStore.ts";

export const setupLogoutListener = async () => {
    return listen<void>('logout', async () => {
        console.log('Logout event received');
        const authStore = useAuthenticationStore.getState();
        authStore.logout();

        // Check if there are any windows open
        const windows = await getAllWindows();
        console.log('All windows:', windows);
        if (windows.length === 0) {
            const newWindow = new Window("main")
            await newWindow.once('tauri://created', () => {
                console.log('Window created successfully');
            });
        }
    });
};