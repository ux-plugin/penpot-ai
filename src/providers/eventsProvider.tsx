import { ReactNode, useEffect } from 'react';
import { setupLogoutListener } from '@/events/logout';

interface EventsProviderProps {
  children: ReactNode;
}

export const EventsProvider = ({ children }: EventsProviderProps) => {
  useEffect(() => {
    // Import and initialize all event listeners
    const initializeEventListeners = async () => {
      try {
        // Setup logout event listener
        await setupLogoutListener();
        console.log('All event listeners initialized successfully');
      } catch (error) {
        console.error('Failed to initialize event listeners:', error);
      }
    };

    initializeEventListeners();
  }, []);

  return <>{children}</>;
};