import { app, BrowserWindow, protocol, net, session, shell } from 'electron'
import { join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerByokIpc } from './byok'
import { registerChatIpc } from './chat'

const isDev = !app.isPackaged

// Thin shell: in dev the window loads skia-rs-wasm's own Vite dev server, which serves
// the full app (WASM, worker, fonts) and the /__ai-chat bridge. Override the host/port
// with ZOETROPE_APP_URL if skia-rs-wasm runs elsewhere.
const APP_URL = process.env['ZOETROPE_APP_URL'] ?? 'http://localhost:5173'

// electron-vite emits the renderer to out/renderer; __dirname here is out/main.
const RENDERER_DIST = join(__dirname, '../renderer')

/**
 * Landmine #1 — serve the renderer over a real origin, not file://.
 *
 * The Emscripten glue resolves the .wasm via locateFile and instantiates it with
 * WebAssembly.instantiateStreaming(), which needs a Content-Type of application/wasm
 * and a fetch()-able origin. file:// gives neither. A privileged custom scheme does,
 * and it keeps the door open for COOP/COEP later if we ever turn on WASM threads.
 *
 * Must be called before app `ready`.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

// Landmine #4 — keep hardware GL. Never let Electron silently drop a Skia GL renderer
// onto SwiftShader (software) because of a GPU blocklist entry. The renderer's boot
// screen surfaces the active GPU so a software fallback is caught immediately.
app.commandLine.appendSwitch('ignore-gpu-blocklist')

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

// Allow wasm compilation ('wasm-unsafe-eval') and blob workers (skia-rs-wasm ships a worker).
const CSP = [
  "default-src 'self' app:",
  "script-src 'self' app: 'wasm-unsafe-eval'",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: data: blob:",
  "font-src 'self' app: data:",
  "connect-src 'self' app:",
  "worker-src 'self' app: blob:",
].join('; ')

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
    let rel = decodeURIComponent(pathname)
    if (rel === '/') rel = '/index.html'

    let filePath = join(RENDERER_DIST, rel)
    // Block path traversal outside the bundle.
    if (!filePath.startsWith(RENDERER_DIST)) {
      return new Response('Forbidden', { status: 403 })
    }

    let ext = extname(filePath)
    // SPA fallback: extension-less navigation requests resolve to index.html.
    if (!ext) {
      filePath = join(RENDERER_DIST, 'index.html')
      ext = '.html'
    }

    try {
      const res = await net.fetch(pathToFileURL(filePath).toString())
      const headers = new Headers(res.headers)
      const type = MIME[ext]
      if (type) headers.set('Content-Type', type)
      headers.set('Content-Security-Policy', CSP)
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

// Allow-list of web permissions the renderer may use. `persistent-storage` keeps the
// font cache (Cache Storage) from being evicted under disk pressure; everything else
// is denied. Extend the set as features need it (e.g. 'local-fonts' for OS fonts).
const ALLOWED_PERMISSIONS = new Set<string>(['persistent-storage'])

function configurePermissions(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0b0e',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webgl: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // External links open in the OS browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    // skia-rs-wasm's dev server is started concurrently and may not be up yet,
    // so retry the load until it answers (and again if HMR restarts it).
    const load = () => win.loadURL(APP_URL)
    win.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
      if (isMainFrame) setTimeout(load, 800)
    })
    load()
    // Open DevTools manually with Cmd/Ctrl+Alt+I when you need it.
  } else {
    // Prod: serve the bundled app over app://. NOTE: today this serves the desktop
    // splash (out/renderer). Pointing it at skia-rs-wasm's production build is the
    // next packaging slice (needs an app-build target + the /__ai-chat bridge ported
    // into this main process).
    win.loadURL('app://bundle/index.html')
  }

  return win
}

app.whenReady().then(async () => {
  registerAppProtocol()
  configurePermissions()
  // Register the BYOK keystore IPC (and warm its cache) before the window loads, so
  // the renderer's first getStatus() call always has a handler waiting.
  await registerByokIpc()
  registerChatIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
