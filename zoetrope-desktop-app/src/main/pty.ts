import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { spawn, type IPty } from 'node-pty'
import { PTY_CHANNELS, type PtyCreateRequest } from '../shared/pty'
import { agentEnv } from './env'

/**
 * Main-process interactive terminals (node-pty).
 *
 * Each session is a real shell spawned in a chosen cwd, inheriting the user's env so a
 * CLI it runs finds its own credentials. Output is streamed to the owning renderer on a
 * per-session channel; input, resize and kill come back over IPC. Sessions are tied to
 * their WebContents and reaped when it goes away, so a reload can't leak shells.
 */

const sessions = new Map<number, IPty>()
let nextId = 1

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

function create(event: IpcMainInvokeEvent, req: PtyCreateRequest): number {
  const wc: WebContents = event.sender
  // Run a specific command (e.g. an agent login flow) when asked, else an interactive shell.
  const file = req.command || req.shell || defaultShell()
  const args = req.command ? (req.args ?? []) : []
  const term = spawn(file, args, {
    name: 'xterm-color',
    cwd: req.cwd,
    cols: req.cols || 80,
    rows: req.rows || 24,
    env: agentEnv() as Record<string, string>,
  })
  const id = nextId++
  sessions.set(id, term)

  term.onData((data) => {
    if (!wc.isDestroyed()) wc.send(`${PTY_CHANNELS.data}:${id}`, data)
  })
  term.onExit(({ exitCode }) => {
    if (!wc.isDestroyed()) wc.send(`${PTY_CHANNELS.exit}:${id}`, exitCode)
    sessions.delete(id)
  })
  // Reap the shell if the renderer navigates away or the window closes.
  wc.once('destroyed', () => {
    if (sessions.has(id)) {
      try {
        term.kill()
      } catch {
        /* already gone */
      }
      sessions.delete(id)
    }
  })
  return id
}

function kill(id: number): void {
  const term = sessions.get(id)
  if (!term) return
  try {
    term.kill()
  } catch {
    /* already gone */
  }
  sessions.delete(id)
}

/** Register the PTY IPC handlers. Call once, after app `ready`. */
export function registerPtyIpc(): void {
  ipcMain.handle(PTY_CHANNELS.create, (event, req: PtyCreateRequest) => create(event, req))
  ipcMain.on(PTY_CHANNELS.write, (_event, id: number, data: string) => sessions.get(id)?.write(data))
  ipcMain.on(PTY_CHANNELS.resize, (_event, id: number, cols: number, rows: number) => {
    try {
      sessions.get(id)?.resize(cols, rows)
    } catch {
      /* resize on a dead pty — ignore */
    }
  })
  ipcMain.on(PTY_CHANNELS.kill, (_event, id: number) => kill(id))
}
