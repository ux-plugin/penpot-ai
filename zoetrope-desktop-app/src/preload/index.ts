import { contextBridge, ipcRenderer } from 'electron'
import {
  CHAT_CHANNELS,
  KEYSTORE_CHANNELS,
  type ChatCompleteRequest,
  type ChatCompleteResponse,
  type KeyStoreStatus,
  type SetKeyRequest,
  type ZoetropeApi,
} from '../shared/byok'

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

// BYOK bridge, exposed as window.zoetrope. Its mere presence is what flips
// SessionCaps.canBYOK on in the renderer (skia-rs-wasm platform.ts probes
// window.zoetrope.keyStore). The plaintext key only ever travels renderer→main on
// set(); it never comes back — the renderer sees only non-secret status.
const zoetrope: ZoetropeApi = {
  keyStore: {
    getStatus: () => ipcRenderer.invoke(KEYSTORE_CHANNELS.getStatus) as Promise<KeyStoreStatus>,
    set: (req: SetKeyRequest) => ipcRenderer.invoke(KEYSTORE_CHANNELS.set, req) as Promise<KeyStoreStatus>,
    clear: () => ipcRenderer.invoke(KEYSTORE_CHANNELS.clear) as Promise<KeyStoreStatus>,
  },
  chat: {
    complete: (req: ChatCompleteRequest) =>
      ipcRenderer.invoke(CHAT_CHANNELS.complete, req) as Promise<ChatCompleteResponse>,
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('desktop', api)
    contextBridge.exposeInMainWorld('zoetrope', zoetrope)
  } catch (error) {
    console.error('[preload] failed to expose bridges', error)
  }
} else {
  // Fallback for the (non-default) non-isolated case.
  window.desktop = api
  ;(window as unknown as { zoetrope: ZoetropeApi }).zoetrope = zoetrope
}

export type DesktopApi = typeof api
