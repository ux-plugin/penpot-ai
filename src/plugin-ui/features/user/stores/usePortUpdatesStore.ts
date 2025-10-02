import { create } from 'zustand';
import { createPortUpdatesConnection, PortUpdatesData } from '../api/portUpdates.ts';

interface PortUpdatesStore {
  connection: PortUpdatesData | null;
  isConnecting: boolean;
  isConnected: boolean;
  error: string | null;
  currentPort: number | null;
  
  connect: () => Promise<void>;
  disconnect: () => void;
  reset: () => void;
}

export const usePortUpdatesStore = create<PortUpdatesStore>((set, get) => ({
  connection: null,
  isConnecting: false,
  isConnected: false,
  error: null,
  currentPort: null,
  
  connect: async () => {
    const { connection, isConnecting } = get();
    // Prevent multiple connections
    if (connection?.connection || isConnecting) {
      console.log('Port updates connection already exists or is connecting');
      return;
    }
    
    set({ isConnecting: true, error: null });
    
    try {
      const newConnection = createPortUpdatesConnection(
        // onPortUpdate callback
        (port) => {
          console.log('Port update received in store:', port);
          set({ currentPort: port });
        },
        // onConnectionStatusChange callback
        (connected) => {
          console.log('Port updates connection status changed:', connected);
          set({ isConnected: connected, isConnecting: false });
          if (!connected) {
            // Connection was lost, reset connection reference
            set({ connection: null });
          }
        },
        // onError callback
        (errorMessage) => {
          console.error('Port updates connection error:', errorMessage);
          set({ 
            error: errorMessage, 
            isConnecting: false,
            isConnected: false,
            connection: null
          });
        }
      );
      
      set({ 
        connection: newConnection, 
        isConnecting: false,
        isConnected: newConnection.isConnected,
        error: newConnection.error
      });

      await newConnection.connection?.connect();
      
      console.log('Port updates connection established successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect';
      console.error('Failed to create port updates connection:', errorMessage);
      set({ 
        error: errorMessage,
        isConnecting: false,
        isConnected: false,
        connection: null
      });
    }
  },
  
  disconnect: () => {
    const { connection } = get();
    if (connection?.connection) {
      console.log('Disconnecting port updates connection');
      connection.connection.close();
    }
    set({ 
      connection: null, 
      currentPort: null, 
      error: null, 
      isConnected: false,
      isConnecting: false
    });
  },
  
  reset: () => {
    const { connection } = get();
    if (connection?.connection) {
      connection.connection.close();
    }
    set({ 
      connection: null, 
      isConnecting: false, 
      isConnected: false,
      error: null, 
      currentPort: null 
    });
  }
}));