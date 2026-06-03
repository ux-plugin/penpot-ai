import { ReactNode } from 'react';
import {BrowserRouter} from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from "@/providers/queryClient.tsx";
import { Toaster } from 'sonner';
import {EventsProvider} from "@/providers/eventsProvider.tsx";

interface WrapInProvidersProps {
  children: ReactNode;
}

export const wrapInProviders = ({ children }: WrapInProvidersProps) => {
  return (
    <QueryClientProvider client={queryClient}>
        <EventsProvider>
            <BrowserRouter basename={import.meta.env.VITE_FRONTEND_BASE_PATH}>
                {children}
            </BrowserRouter>
        </EventsProvider>
        <Toaster position="bottom-right" richColors />
    </QueryClientProvider>
  );
};

export default wrapInProviders;