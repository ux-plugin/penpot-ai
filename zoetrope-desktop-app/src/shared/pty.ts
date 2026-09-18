/**
 * Shared contract for the interactive terminal (PTY) bridge.
 *
 * The Build-mode chat's Agent mode has two views: a chat-styled one-shot runner (see
 * `agent.ts`) and this real terminal. A `node-pty` process in the main process backs an
 * xterm.js terminal in the renderer, so the user can run a CLI (Claude Code, etc.)
 * interactively — including its own login flow. Bytes flow both ways over IPC.
 */

export interface PtyCreateRequest {
  cwd: string
  cols: number
  rows: number
  /** Shell to launch; defaults to the user's $SHELL in main. */
  shell?: string
  /** Run this command instead of an interactive shell (e.g. an agent login flow). */
  command?: string
  args?: string[]
}

export const PTY_CHANNELS = {
  create: 'zoetrope:pty:create',
  write: 'zoetrope:pty:write',
  resize: 'zoetrope:pty:resize',
  kill: 'zoetrope:pty:kill',
  /** main → renderer, suffixed with the session id: `${data}:${id}`. */
  data: 'zoetrope:pty:data',
  exit: 'zoetrope:pty:exit',
} as const

/** The `pty` API exposed on `window.zoetrope`. Ids are opaque per-session handles. */
export interface PtyBridge {
  /** Spawn a shell; resolves to a session id. */
  create(req: PtyCreateRequest): Promise<number>
  /** Send user keystrokes to the shell. */
  write(id: number, data: string): void
  resize(id: number, cols: number, rows: number): void
  /** Terminate the shell and release the session. */
  kill(id: number): void
  /** Subscribe to shell output; returns an unsubscribe fn. */
  onData(id: number, cb: (data: string) => void): () => void
  /** Subscribe to shell exit; returns an unsubscribe fn. */
  onExit(id: number, cb: (exitCode: number) => void): () => void
}
