import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { rollup } from 'rollup'
import dts from 'rollup-plugin-dts'

// ESM doesn't have __dirname, so we create it
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function dtsBundlePlugin(): Plugin {
  return {
    name: 'dts-bundle',
    apply: 'build',
    async closeBundle() {
      const bundle = await rollup({
        input: resolve(__dirname, 'src/index.dts.ts'),
        plugins: [
          dts({
            tsconfig: resolve(__dirname, 'tsconfig.lib.json'),
          }),
        ],
      })
      await bundle.write({
        file: resolve(__dirname, 'dist/index.d.ts'),
        format: 'es',
      })
      await bundle.close()
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // The font backend/proxy origin comes from VITE_FONT_BACKEND_URL via Vite's
  // env files (.env.development / .env.production), read through import.meta.env.
  define:
    command === 'build'
      ? { 'process.env.NODE_ENV': '"production"' }
      : {},
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@skia-rs-wasm/common': resolve(__dirname, 'src/lib/common'),
    }
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'SkiaWasmRenderer',
      formats: ['es', 'cjs'],
      fileName: (format) => `renderer.${format === 'es' ? 'es' : 'cjs'}.js`,
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', 'zustand'],
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.wasm')) {
            return 'render_wasm.wasm'
          }
          return assetInfo.name || 'asset'
        },
      },
    },
    copyPublicDir: true,
    sourcemap: true,
  },
  plugins: [
    react(),
    tailwindcss(),
    dtsBundlePlugin(),
    {
      name: 'wasm-content-type-plugin',
      configureServer(server) {
        const publicDir = join(__dirname, 'public')

        server.middlewares.use((req, res, next) => {
          const url = req.url?.split('?')[0] || '';
          if (url.endsWith('.wasm')) {
            const wasmPath = join(publicDir, url);
            if (fs.existsSync(wasmPath)) {
              res.setHeader('Content-Type', 'application/wasm');
              fs.createReadStream(wasmPath).pipe(res);
              return;
            }
          }
          next();
        });
      },
    },
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    sourcemapIgnoreList: false,
  },
  esbuild: {
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
}))