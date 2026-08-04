/**
 * Terminal-agent configuration panel for the Settings → AI tab (desktop only).
 *
 * Lets the user wire the command used to launch each terminal-based AI CLI that the
 * Build-mode chat can drive in Agent mode. Each row is a display name + a command with
 * a `{prompt}` placeholder; the app runs it headless in the chosen working folder and
 * shows the output as chat. Nothing here is a secret — the CLI owns its own auth.
 */

import { Terminal, Plus, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAgentSettingsStore, PROMPT_TOKEN } from '../../renderer/store/agent-settings-store'

const INPUT_CLASS =
  'h-8 w-full rounded-md border border-border bg-white px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

export function AiAgentsPanel() {
  const agents = useAgentSettingsStore((s) => s.agents)
  const updateAgent = useAgentSettingsStore((s) => s.updateAgent)
  const addAgent = useAgentSettingsStore((s) => s.addAgent)
  const removeAgent = useAgentSettingsStore((s) => s.removeAgent)
  const resetAgents = useAgentSettingsStore((s) => s.resetAgents)

  return (
    <div className="mt-4 rounded-lg border border-border/70 bg-muted/40 p-3.5">
      <div className="mb-1 flex items-center gap-2">
        <Terminal className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Terminal agents</span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Commands run headless in your chosen folder; the reply shows in the Build chat. Put{' '}
        <code className="rounded bg-background px-1 py-0.5 font-mono text-[0.7rem]">{PROMPT_TOKEN}</code> where your
        message goes.
      </p>

      <div className="space-y-3">
        {agents.map((a) => {
          const missingToken = a.command.trim() !== '' && !a.command.includes(PROMPT_TOKEN)
          return (
            <div key={a.id} className="rounded-md border border-border/60 bg-background/60 p-2.5">
              <div className="flex items-center gap-2">
                <input
                  aria-label="Agent name"
                  spellCheck={false}
                  placeholder="Name"
                  className={`${INPUT_CLASS} w-40`}
                  value={a.name}
                  onChange={(e) => updateAgent(a.id, { name: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
                  onClick={() => removeAgent(a.id)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <input
                aria-label="Command"
                spellCheck={false}
                placeholder="claude -p {prompt}"
                className={`${INPUT_CLASS} mt-2 font-mono`}
                value={a.command}
                onChange={(e) => updateAgent(a.id, { command: e.target.value })}
              />
              {missingToken && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[0.7rem] text-amber-600">
                  <AlertTriangle className="size-3" />
                  Add {PROMPT_TOKEN} so your message is passed to the command.
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => addAgent()}>
          <Plus className="size-3.5" />
          Add agent
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={resetAgents}>
          Reset to defaults
        </Button>
      </div>
    </div>
  )
}
