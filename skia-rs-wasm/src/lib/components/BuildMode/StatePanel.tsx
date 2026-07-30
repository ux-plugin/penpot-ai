/**
 * Build stage → state panel. A collapsible strip under the preview that makes an
 * interaction's effect visible even when it lands off-screen.
 *
 * Two halves, both computed rather than guessed (the runtime is pure, so the
 * before/after of every click is fully diffable — see runtime.ts):
 *   - State:    every variable and derived value, live, with the ones that just
 *               moved flagged.
 *   - Data & events: every port — data showing the sample the preview is running
 *               on, events showing whether anything has actually been sent. An
 *               event is the one effect with nowhere to land here, so without
 *               this row it would look like a click that did nothing.
 *   - Activity: what fired and what it changed, newest first. Each line names
 *               the affected nodes that are NOT in the current scope, with one
 *               click to jump to them — the case where the preview appears to do
 *               nothing because the shape that reacted is elsewhere.
 *
 * Collapsed by default: the per-binding diff costs one expression evaluation per
 * binding per click, so it's only worth paying while you're watching.
 */

import { cn } from '@/lib/utils'
import type { PageInteractions } from '../../renderer/interactions/ir'
import type { LoggedActivity, StateChange } from '../../renderer/interactions/preview/runtime'

/** Compact one-line rendering of a runtime value. */
function fmt(v: unknown): string {
  if (v === undefined) return '—'
  if (v === null) return 'null'
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'object') return '{…}'
  return String(v)
}

function changeLabel(c: StateChange): string {
  // A call left the design; it has no previous value to show, and the arrow
  // pointing outward is the whole distinction from a cell that moved.
  if (c.kind === 'port-call') return `${c.id}(${fmt(c.after)}) ↗ sent out`
  return `${c.id} ${fmt(c.before)} → ${fmt(c.after)}`
}

const rowCls = 'flex items-baseline gap-2 font-mono text-[11px] leading-6'

export function StatePanel({
  ir,
  env,
  log,
  open,
  onToggle,
  inView,
  nameOf,
  onSelect,
}: {
  ir: PageInteractions
  /** Current evaluation environment — variables plus computed derived values. */
  env: Record<string, unknown>
  log: LoggedActivity[]
  open: boolean
  onToggle: () => void
  /** Whether a node is inside the subtree the stage is currently showing. */
  inView: (nodeId: string) => boolean
  nameOf: (nodeId: string) => string
  onSelect: (nodeId: string) => void
}) {
  const latest = log[0]
  const justChanged = new Set((latest?.changes ?? []).map((c) => c.id))
  const hasState = ir.variables.length > 0 || ir.derived.length > 0
  const inPorts = ir.ports.filter((p) => p.dir === 'in')
  const outPorts = ir.ports.filter((p) => p.dir === 'out')
  // How many times each out-port has been called, across the whole session —
  // the running total, where the activity feed shows the individual calls.
  const callCount = new Map<string, number>()
  for (const entry of log) {
    for (const c of entry.changes) {
      if (c.kind === 'port-call') callCount.set(c.id, (callCount.get(c.id) ?? 0) + entry.count)
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-white/60">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className={cn('transition-transform', open && 'rotate-90')}>›</span>
        <span className="font-medium">State</span>
        {!open && latest && (
          <span className="truncate text-[11px]">
            last: {latest.trigger} on {nameOf(latest.node)}
            {latest.changes.length ? ` · ${changeLabel(latest.changes[0])}` : ' · no change'}
          </span>
        )}
      </button>

      {open && (
        <div className="max-h-56 overflow-auto px-3 pb-3">
          {/* Only a true blank slate gets the prompt. A design that declares
              ports but keeps no state of its own is complete, not empty — the
              data & events group below is the whole story. */}
          {!hasState ? (
            ir.ports.length === 0 && (
              <p className="py-1 text-[11px] text-muted-foreground">
                No state yet — add a variable in the Interactions tab.
              </p>
            )
          ) : (
            <div className="mb-2">
              {ir.variables.map((v) => (
                <div key={v.id} className={rowCls}>
                  <span className="text-muted-foreground">{v.id}</span>
                  <span className="text-foreground">{fmt(env[v.id])}</span>
                  {justChanged.has(v.id) && (
                    <span className="rounded bg-amber-100 px-1.5 text-[10px] text-amber-900">changed</span>
                  )}
                </div>
              ))}
              {ir.derived.map((d) => (
                <div key={d.id} className={rowCls}>
                  <span className="text-muted-foreground">{d.id}</span>
                  <span className="text-foreground">{fmt(env[d.id])}</span>
                  <span className="text-[10px] text-muted-foreground" title={d.expr}>
                    ƒ
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* What the design does NOT own. Separated from state on purpose: these
              values are running on the design's own samples, so a number here is
              a stand-in, not something the prototype decided. */}
          {ir.ports.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                Data &amp; events
              </div>
              {inPorts.map((p) => (
                <div key={p.id} className={rowCls}>
                  <span className="text-muted-foreground">{p.id}</span>
                  <span className="text-foreground">{fmt(env[p.id])}</span>
                  <span
                    className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground"
                    title={p.description ? `${p.description} — showing the sample` : 'showing the sample value'}
                  >
                    sample
                  </span>
                </div>
              ))}
              {outPorts.map((p) => (
                <div key={p.id} className={rowCls}>
                  <span className="text-muted-foreground">{p.id}</span>
                  <span className="text-foreground">
                    {callCount.has(p.id) ? `called ${callCount.get(p.id)}×` : 'not called yet'}
                  </span>
                  <span className="text-[10px] text-muted-foreground" title={p.description ?? 'an event this design reports'}>
                    ↗
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">Activity</div>
          {log.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Nothing fired yet — click something in the preview.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {log.map((entry, i) => {
                const offscreen = entry.affected.filter((a) => !inView(a.node))
                return (
                  <li key={i} className="border-l-2 border-border pl-2 text-[11px] leading-5">
                    <div>
                      <span className="text-foreground">{entry.trigger}</span>
                      <span className="text-muted-foreground"> on </span>
                      <span className="text-foreground">{nameOf(entry.node)}</span>
                      {entry.count > 1 && <span className="text-muted-foreground"> ×{entry.count}</span>}
                    </div>
                    {entry.changes.length === 0 ? (
                      <div className="font-mono text-[10px] text-muted-foreground">no state change</div>
                    ) : (
                      // Indexed key: one interaction can call the same out-port
                      // twice, so the id alone is not unique within an entry.
                      entry.changes.map((c, j) => (
                        <div key={`${c.kind}:${c.id}:${j}`} className="font-mono text-[10px] text-muted-foreground">
                          {changeLabel(c)}
                        </div>
                      ))
                    )}
                    {offscreen.length > 0 && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {offscreen.length} change{offscreen.length === 1 ? '' : 's'} outside this view —{' '}
                        {offscreen.map((a, j) => (
                          <span key={a.node}>
                            {j > 0 && ', '}
                            <button
                              type="button"
                              className="text-foreground underline underline-offset-2 hover:no-underline"
                              onClick={() => onSelect(a.node)}
                            >
                              {nameOf(a.node)}
                            </button>
                            <span> ({a.props.join(', ')})</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
