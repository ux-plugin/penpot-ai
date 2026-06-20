/**
 * Build-mode right column — hosts the shared tabbed inspector.
 *
 * Same tabs as the Design rail (Parameters / Interactions / Code) via the shared
 * `inspectorTab` signal; only the host chrome differs (a docked column here vs
 * the floating rail in Design). Parameters is read-only in Build (see
 * ReadOnlyParameters); Interactions + Code are the identical shared components.
 */

import { InspectorTabBar } from '../Inspector/InspectorTabBar'
import { InteractionsTab } from '../Inspector/InteractionsTab'
import { CodeTab } from '../Inspector/CodeTab'
import { ReadOnlyParameters } from './ReadOnlyParameters'
import { inspectorTab } from '../../renderer/signals/inspector-tab'
import { useSignalCoalesced } from '../../renderer/signals/use-signal-coalesced'

export function BuildInspector() {
  const tab = useSignalCoalesced(inspectorTab)
  return (
    <div className="flex w-72 shrink-0 flex-col border-l border-border bg-white">
      <InspectorTabBar />
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'parameters' ? <ReadOnlyParameters /> : tab === 'interactions' ? <InteractionsTab /> : <CodeTab />}
      </div>
    </div>
  )
}
