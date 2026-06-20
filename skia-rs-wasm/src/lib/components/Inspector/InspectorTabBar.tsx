/**
 * The shared inspector tab bar: Parameters / Interactions / Code.
 * Reads/writes the `inspectorTab` signal so the choice is shared by the
 * Design-mode rail and the Build-mode column.
 */

import { cn } from '@/lib/utils'
import { inspectorTab, setInspectorTab, type InspectorTab } from '../../renderer/signals/inspector-tab'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'parameters', label: 'Parameters' },
  { id: 'interactions', label: 'Interactions' },
  { id: 'code', label: 'Code' },
]

export function InspectorTabBar() {
  const active = useSignalCoalesced(inspectorTab)
  return (
    <div
      role="tablist"
      aria-label="Inspector"
      className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => setInspectorTab(t.id)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            active === t.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
