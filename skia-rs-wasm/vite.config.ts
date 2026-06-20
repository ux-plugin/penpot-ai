import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { spawn } from 'node:child_process'
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

/**
 * Dev-only bridge: POST /__ai-chat { prompt } -> spawns the local `claude` CLI
 * (one-shot print mode) and returns { ok, text }. Lets the Build-mode chat talk
 * to a real AI session using the CLI's own auth, with no API key in the browser.
 * Serve-only; the CLI must be on PATH. NOTE: the dev server binds 0.0.0.0, so
 * this endpoint is LAN-reachable — fine for local dev, not for shared networks.
 */
function aiChatPlugin(): Plugin {
  return {
    name: 'ai-chat-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__ai-chat', (req, res, next) => {
        if (req.method !== 'POST') return next()
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const reply = (payload: object) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(payload))
          }
          let prompt = ''
          try {
            prompt = String((JSON.parse(body) as { prompt?: unknown }).prompt ?? '')
          } catch {
            res.statusCode = 400
            return reply({ ok: false, error: 'invalid JSON body' })
          }
          if (!prompt.trim()) {
            res.statusCode = 400
            return reply({ ok: false, error: 'missing prompt' })
          }

          const child = spawn('claude', ['-p', '--output-format', 'json'], { stdio: ['pipe', 'pipe', 'pipe'] })
          let out = ''
          let err = ''
          let done = false
          const finish = (payload: object) => {
            if (done) return
            done = true
            clearTimeout(timer)
            reply(payload)
          }
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            finish({ ok: false, error: 'claude timed out' })
          }, 120_000)
          child.on('error', (e: NodeJS.ErrnoException) =>
            finish({ ok: false, error: e.code === 'ENOENT' ? 'claude CLI not found on PATH' : String(e) }),
          )
          child.stdout.on('data', (d) => (out += d))
          child.stderr.on('data', (d) => (err += d))
          child.on('close', (code) => {
            if (code !== 0) return finish({ ok: false, error: err.trim() || `claude exited with code ${code}` })
            let text = out
            try {
              const env = JSON.parse(out) as { result?: unknown }
              if (typeof env.result === 'string') text = env.result
            } catch {
              // not the JSON envelope — fall back to raw stdout
            }
            finish({ ok: true, text })
          })
          child.stdin.write(prompt)
          child.stdin.end()
        })
      })
    },
  }
}

/**
 * Dev fs allow-list: the project dir plus every ancestor that holds a
 * `node_modules`. Running from a git worktree, deps resolve to the MAIN repo's
 * pnpm store (above the project root), which Vite otherwise blocks as "outside
 * the serving allow list" — breaking fonts and any dep served from there.
 */
function fsAllowList(): string[] {
  const roots = new Set<string>([__dirname])
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(join(dir, 'node_modules'))) roots.add(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return [...roots]
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
    aiChatPlugin(),
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
    fs: { allow: fsAllowList() },
    sourcemapIgnoreList: false,
  },
  esbuild: {
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
}))