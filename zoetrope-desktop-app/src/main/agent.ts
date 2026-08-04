import { ipcMain, dialog } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  AGENT_CHANNELS,
  AGENT_PRESETS,
  PROMPT_TOKEN,
  type AgentRunRequest,
  type AgentRunResponse,
  type DetectedAgent,
} from '../shared/agent'
import { agentEnv } from './env'

/**
 * Main-process AI-agent runner.
 *
 * Runs a terminal-based AI CLI headless in a chosen cwd and returns its stdout. The
 * process inherits the user's environment (so the CLI finds its own credentials); we
 * pass no keys. The prompt is a single argv element — never interpolated into a shell
 * string — so an arbitrary message can't break argument boundaries.
 */

const execFileAsync = promisify(execFile)

// Cap runaway output so a misbehaving CLI can't balloon renderer memory.
const MAX_OUTPUT = 1_000_000

async function which(bin: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(finder, [bin])
    return stdout.split(/\r?\n/)[0]?.trim() || null
  } catch {
    return null
  }
}

async function detect(): Promise<DetectedAgent[]> {
  return Promise.all(
    AGENT_PRESETS.map(async (p) => ({
      id: p.id,
      name: p.name,
      argv: p.argv,
      path: await which(p.argv[0]),
    })),
  )
}

function run(req: AgentRunRequest): Promise<AgentRunResponse> {
  const argv = req?.argv ?? []
  const prompt = req?.prompt ?? ''
  const cwd = req?.cwd
  if (argv.length === 0) return Promise.reject(new Error('No agent command configured.'))
  if (!cwd) return Promise.reject(new Error('No working directory selected.'))

  const [bin, ...rest] = argv
  const args = rest.map((a) => (a === PROMPT_TOKEN ? prompt : a))

  return new Promise<AgentRunResponse>((resolve, reject) => {
    let child
    try {
      // No shell: args are passed literally, so the prompt is inert as an argument.
      child = spawn(bin, args, { cwd, env: agentEnv() })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }

    let out = ''
    let err = ''
    let truncated = false
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString()
      else truncated = true
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < MAX_OUTPUT) err += d.toString()
    })
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      const text = out.trim() + (truncated ? '\n…(output truncated)' : '')
      resolve({ text, exitCode: code ?? 0, stderr: err.trim() || undefined })
    })
  })
}

async function pickFolder(): Promise<string | null> {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return res.canceled ? null : (res.filePaths[0] ?? null)
}

/** Register the agent IPC handlers. Call once, after app `ready`. */
export function registerAgentIpc(): void {
  ipcMain.handle(AGENT_CHANNELS.detect, () => detect())
  ipcMain.handle(AGENT_CHANNELS.run, (_event, req: AgentRunRequest) => run(req))
  ipcMain.handle(AGENT_CHANNELS.pickFolder, () => pickFolder())
}
