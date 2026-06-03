import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173-5175 are taken on this machine by penpot-devenv-main.
    port: 5180,
    strictPort: true,
    proxy: {
      '/ingest': { target: 'http://localhost:8080', changeOrigin: true },
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
