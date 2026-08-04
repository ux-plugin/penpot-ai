import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from '@zed-industries/agent-client-protocol'
import type { DetectedAdapter, AdapterTestResult } from '../shared/acp'
import { agentEnv } from './env'

/**
 * ACP adapter registry + detection.
 *
 * An "adapter" is a program that speaks the Agent Client Protocol. Some ship with the app
 * (Claude Code, in node_modules); others are external CLIs the user has installed. This
 * module knows how to LAUNCH each one, whether it's PRESENT (Tier 1 — cheap `which`/resolve),
 * and whether it genuinely SPEAKS ACP (Tier 2 — a real `initialize` handshake). The renderer
 * only ever sees `{ id, label, available, installHint }` — never how we launch it.
 */

// electron-vite bundles main into one CJS file, so __filename is available at runtime.
const nodeRequire = createRequire(__filename)

/** How an adapter is launched — internal detail, never crosses to the renderer. */
type AdapterSource =
  | { kind: 'bundled'; pkg: string } // an npm package we ship; run its dist with Node
  | { kind: 'path'; bin: string; args: string[] } // an external binary on PATH

interface Adapter {
  id: string
  label: string
  source: AdapterSource
  installHint?: string
}

// Known adapters. External launch commands are best-effort — the Tier-2 handshake is what
// actually confirms them, so a slightly-wrong flag surfaces as a failed Test, not a lie.
const ADAPTERS: Adapter[] = [
  { id: 'claude', label: 'Claude Code', source: { kind: 'bundled', pkg: '@zed-industries/claude-code-acp' } },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    source: { kind: 'path', bin: 'gemini', args: ['--experimental-acp'] },
    installHint: 'npm i -g @google/gemini-cli',
  },
]

function findAdapter(id: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id)
}

// --- launching --------------------------------------------------------------

let cachedNode: string | null | undefined
/** A real Node binary, so a bundled adapter's SDK grandchild stays headless (no dock icon). */
function realNode(): string | null {
  if (cachedNode !== undefined) return cachedNode
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(finder, ['node'], { encoding: 'utf8', env: agentEnv() })
    cachedNode = out.split(/\r?\n/)[0]?.trim() || null
  } catch {
    cachedNode = null
  }
  return cachedNode
}

function bundledEntry(pkg: string): string {
  return join(dirname(nodeRequire.resolve(`${pkg}/package.json`)), 'dist/index.js')
}

/** A spawnable command for an adapter, or null if unknown. `env` merges over the base env. */
export function adapterLaunch(id: string): { command: string; args: string[]; env?: NodeJS.ProcessEnv } | null {
  const a = findAdapter(id)
  if (!a) return null
  if (a.source.kind === 'bundled') {
    const entry = bundledEntry(a.source.pkg)
    const node = realNode()
    return node
      ? { command: node, args: [entry] }
      : { command: process.execPath, args: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { command: a.source.bin, args: a.source.args }
}

// --- Tier 1: presence -------------------------------------------------------

function onPath(bin: string): boolean {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(finder, [bin], { stdio: 'ignore', env: agentEnv() })
    return true
  } catch {
    return false
  }
}

function isAvailable(a: Adapter): boolean {
  if (a.source.kind === 'bundled') {
    try {
      nodeRequire.resolve(`${a.source.pkg}/package.json`)
      return true
    } catch {
      return false
    }
  }
  return onPath(a.source.bin)
}

/** Tier 1 — which adapters are present. Instant; safe to call on every Settings open. */
export function detectAdapters(): DetectedAdapter[] {
  return ADAPTERS.map((a) => ({
    id: a.id,
    label: a.label,
    available: isAvailable(a),
    installHint: a.installHint,
  }))
}

// --- Tier 2: capability handshake ------------------------------------------

function errText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/**
 * Tier 2 — actually speak ACP: spawn the adapter and run `initialize` with a timeout. Proves
 * it talks the protocol (not just that a binary exists). Lazy — call on a Test click or on
 * select, never for the whole list at once.
 */
export async function testAdapter(id: string): Promise<AdapterTestResult> {
  const launch = adapterLaunch(id)
  if (!launch) return { ok: false, error: 'Unknown adapter.' }

  let child
  try {
    child = spawn(launch.command, launch.args, {
      env: { ...agentEnv(), ...launch.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
  if (!child.stdin || !child.stdout) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    return { ok: false, error: 'Failed to open adapter stdio.' }
  }

  const client: Client = {
    async sessionUpdate() {},
    async requestPermission() {
      return { outcome: { outcome: 'cancelled' as const } }
    },
    async readTextFile() {
      return { content: '' }
    },
    async writeTextFile() {
      return {}
    },
  }
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  )
  const conn = new ClientSideConnection(() => client, stream)

  const started = Date.now()
  try {
    await withTimeout(
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      }),
      8000,
    )
    return { ok: true, ms: Date.now() - started }
  } catch (e) {
    return { ok: false, error: errText(e) }
  } finally {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}
