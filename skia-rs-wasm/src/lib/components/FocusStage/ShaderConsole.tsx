/**
 * ShaderConsole — the shader stage's bottom strip: the compiler's full problem
 * list. The editor's inline underlines + one-line status show WHERE and the
 * first error; this shows them ALL, persistently, each row clickable to jump the
 * caret there. Reads everything from `shaderConsoleBridge` (the stage publishes;
 * the strip lives in a different focus-stage slot).
 */

import { CircleAlert, CircleCheck, CircleX } from 'lucide-react'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'
import { shaderConsoleBridge } from '../../renderer/signals/shader-console-bridge'

export function ShaderConsole() {
  const bridge = useSignalCoalesced(shaderConsoleBridge)
  const diagnostics = bridge?.diagnostics ?? []
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.length - errors

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold tracking-tight">Problems</h2>
        {bridge?.status === 'compiling' ? (
          <span className="text-[11px] text-muted-foreground">Compiling…</span>
        ) : diagnostics.length === 0 ? (
          <span className="flex items-center gap-1 text-[11px] text-emerald-600">
            <CircleCheck className="size-3.5" /> No problems
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {errors > 0 && `${errors} error${errors === 1 ? '' : 's'}`}
            {errors > 0 && warnings > 0 && ' · '}
            {warnings > 0 && `${warnings} warning${warnings === 1 ? '' : 's'}`}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {diagnostics.map((d, i) => {
          const isError = d.severity === 'error'
          return (
            <button
              key={i}
              type="button"
              onClick={() => bridge?.reveal(d.line, d.column)}
              className="flex w-full items-baseline gap-2 px-4 py-1 text-left font-mono text-[11px] hover:bg-muted/60"
              title={`Jump to line ${d.line}`}
            >
              {isError ? (
                <CircleX className="size-3.5 shrink-0 translate-y-0.5 text-red-600" />
              ) : (
                <CircleAlert className="size-3.5 shrink-0 translate-y-0.5 text-amber-500" />
              )}
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {d.line}:{d.column ?? 1}
              </span>
              <span className="min-w-0 break-words text-foreground">{d.message}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
