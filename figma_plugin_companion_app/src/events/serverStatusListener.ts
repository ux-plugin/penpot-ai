import { listen } from '@tauri-apps/api/event';

export type ServerStatus = 'starting' | 'success' | 'error' | 'stopped';

export interface ServerStatusPayload {
  status: ServerStatus;
  error?: string;
}

export const serverStatusListener = async (
  onStatusChange: (payload: ServerStatusPayload) => void
) => {
  return listen<ServerStatusPayload>('server-status-changed', (event) => {
    console.log('Server Status Event Received:', event.payload);
    onStatusChange(event.payload);
  });
};
