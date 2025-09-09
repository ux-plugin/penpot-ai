import { ReactNode, useEffect } from 'react';
import { reloadAuthStateListener } from '@/events/reloadListener.ts';

interface EventsProviderProps {
  children: ReactNode;
}

export const EventsProvider = ({ children }: EventsProviderProps) => {
  useEffect(() => {
    // Import and initialize all event listeners
    const initializeEventListeners = async () => {
      try {
        // Setup reload event listener
        await reloadAuthStateListener();
        console.log('All event listeners initialized successfully');
      } catch (error) {
        console.error('Failed to initialize event listeners:', error);
      }
    };

    initializeEventListeners();
  }, []);

  return <>{children}</>;
};