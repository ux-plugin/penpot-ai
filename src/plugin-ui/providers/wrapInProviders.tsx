import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from "@/plugin-ui/providers/queryClient.tsx";
import { Toaster } from 'sonner';

interface WrapInProvidersProps {
  children: ReactNode;
}

export const wrapInProviders = ({ children }: WrapInProvidersProps) => {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter basename={import.meta.env.VITE_FRONTEND_BASE_PATH}>
        {children}
      </MemoryRouter>
      <Toaster position="bottom-right" richColors />
    </QueryClientProvider>
  );
};

export default wrapInProviders;