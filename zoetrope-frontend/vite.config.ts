import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 5173-5176 are taken on this machine (skia-rs-wasm, figma_plugin_fe,
    // demo-app, etc). Pin to a stable port for the admin-app launch config.
    port: 5181,
    strictPort: true,
    proxy: {
      // figma_plugin_api (Spring Boot) runs at :8080 — see
      // figma_plugin_api/docker-compose.yaml. Forward /api/* without
      // rewriting the path; the backend mounts /auth/auth0/* at the root,
      // so /api/auth/auth0/login on the frontend hits /auth/auth0/login.
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
})
