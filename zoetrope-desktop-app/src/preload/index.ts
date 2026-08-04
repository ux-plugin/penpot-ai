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
import {
  AGENT_CHANNELS,
  type AgentRunRequest,
  type AgentRunResponse,
  type DetectedAgent,
} from '../shared/agent'
import { PTY_CHANNELS, type PtyCreateRequest } from '../shared/pty'
import { ACP_CHANNELS, type AcpPromptRequest, type AcpPromptResponse, type AcpUpdateEnvelope } from '../shared/acp'

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
  agent: {
    detect: () => ipcRenderer.invoke(AGENT_CHANNELS.detect) as Promise<DetectedAgent[]>,
    run: (req: AgentRunRequest) => ipcRenderer.invoke(AGENT_CHANNELS.run, req) as Promise<AgentRunResponse>,
    pickFolder: () => ipcRenderer.invoke(AGENT_CHANNELS.pickFolder) as Promise<string | null>,
  },
  pty: {
    create: (req: PtyCreateRequest) => ipcRenderer.invoke(PTY_CHANNELS.create, req) as Promise<number>,
    write: (id: number, data: string) => ipcRenderer.send(PTY_CHANNELS.write, id, data),
    resize: (id: number, cols: number, rows: number) => ipcRenderer.send(PTY_CHANNELS.resize, id, cols, rows),
    kill: (id: number) => ipcRenderer.send(PTY_CHANNELS.kill, id),
    onData: (id: number, cb: (data: string) => void) => {
      const ch = `${PTY_CHANNELS.data}:${id}`
      const listener = (_e: unknown, data: string) => cb(data)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    },
    onExit: (id: number, cb: (exitCode: number) => void) => {
      const ch = `${PTY_CHANNELS.exit}:${id}`
      const listener = (_e: unknown, code: number) => cb(code)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    },
  },
  acp: {
    prompt: (req: AcpPromptRequest) => ipcRenderer.invoke(ACP_CHANNELS.prompt, req) as Promise<AcpPromptResponse>,
    cancel: (chatId: string) => ipcRenderer.send(ACP_CHANNELS.cancel, chatId),
    close: (chatId: string) => ipcRenderer.send(ACP_CHANNELS.close, chatId),
    onUpdate: (cb: (envelope: AcpUpdateEnvelope) => void) => {
      const listener = (_e: unknown, env: AcpUpdateEnvelope) => cb(env)
      ipcRenderer.on(ACP_CHANNELS.update, listener)
      return () => ipcRenderer.removeListener(ACP_CHANNELS.update, listener)
    },
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
