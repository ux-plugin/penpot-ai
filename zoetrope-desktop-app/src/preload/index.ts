import { contextBridge } from 'electron'

// Minimal, sandbox-safe surface exposed to the renderer as window.desktop.
// Grows into the real IPC bridge (file open/save, native menus, auto-update) later.
const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('desktop', api)
  } catch (error) {
    console.error('[preload] failed to expose desktop api', error)
  }
} else {
  // Fallback for the (non-default) non-isolated case.
  window.desktop = api
}

export type DesktopApi = typeof api
