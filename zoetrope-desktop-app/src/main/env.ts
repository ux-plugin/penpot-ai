/**
 * Environment sanitizing for spawned AI agents.
 *
 * Claude Code injects session markers (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …) into
 * its own process env. If our app happens to be launched from inside a Claude Code
 * session — or any shell within one — those markers get inherited, and spawning a nested
 * `claude` fails with "Claude Code cannot be launched inside another Claude Code session".
 *
 * `agentEnv()` returns the process env with those markers removed, so child agents (ACP
 * adapter, PTY shell, headless CLI) always start as fresh, top-level sessions. Auth is
 * unaffected: credentials live in `~/.claude` (and `CLAUDE_CODE_OAUTH_TOKEN`, which we
 * keep), not in the session markers we strip. On a normal launch none are set, so this
 * is a no-op.
 */

const STRIP_EXACT = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'])

export function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIP_EXACT.has(key)) continue
    if (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN') continue
    env[key] = value
  }
  return env
}
