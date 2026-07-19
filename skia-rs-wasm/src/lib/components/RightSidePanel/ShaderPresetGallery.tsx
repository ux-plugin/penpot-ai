/**
 * Shader preset gallery — the "pick a starting point" modal shown when you open
 * a fresh (still-default) custom-shader material. Each cell is a real thumbnail:
 * the preset's own SkSL rendered by the SAME isolated preview surface the editor
 * uses, so what you see is what you'll get. One shared GL surface renders every
 * cell in turn and blits each frame into that cell's 2D canvas — N thumbnails,
 * ONE context (see [[project_shader_materials]] on the context budget).
 *
 * It opens BEFORE the focus stage (from the effects panel), so it never contends
 * with the stage's live preview for that single surface — they're sequential.
 */

import { useEffect, useRef } from 'react'
import type { Material } from '../../renderer/api/material'
import { SHADER_PRESETS } from '../../renderer/shader-lang/presets'
import { DEFAULT_MATERIAL } from '../../renderer/properties/panel-utils'
import { ShaderThumbnail, useShaderThumbnails } from './shader-thumbnails'

interface GalleryEntry {
  id: string
  name: string
  description: string
  thumbPhase: number
  material: Material
}

/** "Blank" = the annotated default template — a legible place to start typing. */
const BLANK: GalleryEntry = {
  id: 'blank',
  name: 'Blank',
  description: 'The default starter template',
  thumbPhase: 0.25,
  material: DEFAULT_MATERIAL,
}

const ENTRIES: GalleryEntry[] = [BLANK, ...SHADER_PRESETS]

export interface ShaderPresetGalleryProps {
  /** Called with the chosen preset's material. */
  onPick: (material: Material) => void
  /** Called on Esc / backdrop click / the close button. */
  onClose: () => void
}

export function ShaderPresetGallery({ onPick, onClose }: ShaderPresetGalleryProps) {
  // Close only when the press STARTED on the backdrop (mirrors SettingsDialog) —
  // a drag that ends on the backdrop shouldn't dismiss.
  const backdropDown = useRef(false)
  // Render (once) + paint the preset thumbnails from the shared cache.
  const thumbVersion = useShaderThumbnails(ENTRIES)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label="Shader presets"
      onPointerDown={(e) => {
        backdropDown.current = e.target === e.currentTarget
      }}
      onPointerUp={(e) => {
        if (backdropDown.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[85vh] w-[min(920px,92vw)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold">Choose a starting point</h2>
            <p className="text-xs text-muted-foreground">
              A fork-me template — you can edit the SkSL after picking.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Esc
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 overflow-auto p-5 sm:grid-cols-3">
          {ENTRIES.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onPick(e.material)}
              className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition hover:border-ring hover:shadow-md focus-visible:border-ring focus-visible:outline-none"
            >
              <div className="relative aspect-[5/3] w-full overflow-hidden bg-muted">
                <ShaderThumbnail id={e.id} version={thumbVersion} />
              </div>
              <div className="px-3 py-2">
                <div className="text-xs font-medium">{e.name}</div>
                <div className="text-[11px] leading-tight text-muted-foreground">{e.description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
