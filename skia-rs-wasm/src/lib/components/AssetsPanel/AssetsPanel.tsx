/**
 * Assets panel — the left-rail library of reusable, asset-class objects. Unlike
 * tokens (which resolve to primitive values), an asset is a document you insert
 * or apply: a shader material today; 3D models, components, and saved materials
 * later slot in as sibling sections here.
 *
 * Shaders: click a preset to apply it as a material effect to the selected
 * shape(s) — apply only; editing is a separate, explicit step (the `</>` on the
 * material row). Nothing selected shows a hint. (Drag-to-canvas is a follow-up.)
 */

import { useCallback } from 'react'
import { useSnapshot } from 'valtio'
import type { PenpotNode } from 'penpot-exporter/types'
import type { Material } from '../../renderer/api/material'
import { SHADER_PRESETS } from '../../renderer/shader-lang/presets'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../../renderer/properties/commit-node-properties'
import {
  beginHistoryTransaction,
  commitHistoryTransaction,
} from '../../history/history-store'
import { ShaderThumbnail, useShaderThumbnails } from '../RightSidePanel/shader-thumbnails'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

function ShadersSection({ selectedIds }: { selectedIds: readonly string[] }) {
  const version = useShaderThumbnails(SHADER_PRESETS)
  const targets = selectedIds.filter((id) => id !== ROOT_UUID)
  const canApply = targets.length > 0

  const apply = useCallback(
    async (material: Material) => {
      const pid = getActiveOrSinglePageId()
      if (!pid || targets.length === 0) return
      // Just apply — as ONE undo step. Editing is a separate, explicit step (the
      // `</>` on the material row / dbl-click), not something applying forces.
      beginHistoryTransaction('assets-apply-shader')
      try {
        for (const id of targets) {
          const before = getCommittedNodeOnActivePage(id)
          if (before) {
            await commitNodePartialUpdate(id, before, { material } as Partial<PenpotNode>, pid)
          }
        }
      } finally {
        commitHistoryTransaction('assets-apply-shader')
      }
    },
    [targets],
  )

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between px-1">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Shaders</h3>
        <span className="text-[10px] text-muted-foreground/70">
          {canApply ? `Apply to ${targets.length} selected` : 'Select a shape to apply'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {SHADER_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!canApply}
            onClick={() => void apply(p.material)}
            title={canApply ? `Apply "${p.name}"` : 'Select a shape first'}
            className="group flex flex-col overflow-hidden rounded-md border border-border bg-card text-left transition enabled:hover:border-ring enabled:hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="relative aspect-[5/3] w-full overflow-hidden bg-muted">
              <ShaderThumbnail id={p.id} version={version} />
            </div>
            <div className="truncate px-1.5 py-1 text-[11px] font-medium">{p.name}</div>
          </button>
        ))}
      </div>
    </section>
  )
}

/** The scrollable body of the Assets tab. More asset kinds become sibling sections. */
export function AssetsSections() {
  const snap = useSnapshot(docProxy)
  // `selectedIds` is a proxy Set — materialize it so downstream code can filter.
  const selectedIds: string[] = snap.selectedIds
    ? Array.from(snap.selectedIds as Iterable<string>)
    : []

  return (
    <div className="space-y-4">
      <ShadersSection selectedIds={selectedIds} />
      {/* Future: 3D models, components, saved materials — each its own section. */}
    </div>
  )
}
