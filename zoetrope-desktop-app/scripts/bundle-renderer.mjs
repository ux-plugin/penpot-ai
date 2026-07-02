// Copies skia-rs-wasm's static app build (dist-app) into the desktop renderer output
// (out/renderer) so the packaged app serves the real editor over app://, offline.
// Run after `electron-vite build`.
import { existsSync, rmSync, cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '../../skia-rs-wasm/dist-app')
const destDir = resolve(here, '../out/renderer')

if (!existsSync(appDir)) {
  console.error(
    `[bundle-renderer] skia-rs-wasm app build not found at:\n  ${appDir}\n\n` +
      `Build it first:\n` +
      `  pnpm --filter skia-rs-wasm build:app\n\n` +
      `That needs the WASM glue in skia-rs-wasm/public/wasm — produce it once with:\n` +
      `  pnpm --filter skia-rs-wasm build:wasm   (Docker render-wasm build)`,
  )
  process.exit(1)
}

rmSync(destDir, { recursive: true, force: true })
cpSync(appDir, destDir, { recursive: true })
console.log(`[bundle-renderer] copied ${appDir} -> ${destDir}`)
