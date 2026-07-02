import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Static APP build of the skia-rs-wasm editor (index.html -> src/main.tsx), for
 * embedding in the Electron desktop app (zoetrope-desktop-app) and serving offline
 * over its app:// protocol.
 *
 * This is intentionally separate from the default vite.config.ts, which builds the
 * LIBRARY (lib mode -> dist/renderer.*) and externalizes react. Here we want a normal
 * app bundle with everything included.
 *
 * Prerequisite: the WASM glue must exist in public/wasm (run `pnpm build:wasm` once).
 * The worker is bundled via Vite's `?worker` import; public/ (incl. wasm) is copied
 * into the output; the .wasm is fetched at runtime from `/wasm/render-wasm.wasm`.
 */
export default defineConfig({
  define: { 'process.env.NODE_ENV': '"production"' },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@skia-rs-wasm/common': resolve(__dirname, 'src/lib/common'),
    },
  },
  build: {
    outDir: 'dist-app',
    emptyOutDir: true,
    copyPublicDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
})
