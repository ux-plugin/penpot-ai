import { useCallback, useState } from 'react'
import type { Blur, Glass, PenpotNode, Shadow } from 'penpot-exporter/types'
import type { Texture } from '../../../renderer/properties/panel-utils'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  commitNodePartialUpdate,
  getCommittedNodeOnActivePage,
} from '../../../renderer/properties/commit-node-properties'
import {
  DEFAULT_SHADOW,
  MAX_EFFECTS,
  type EffectItem,
  type Noise,
  type RectLikeNode,
} from '../../../renderer/properties/panel-utils'
import type { Material } from '../../../renderer/api/material'
import { getActiveOrSinglePageId } from '../../../renderer/store/doc-proxy'
import { openFocusStage } from '../../../renderer/signals/focus-stage'
import { ShaderMaterialStage } from '../../FocusStage/ShaderMaterialStage'
import { ShaderUniformsRail } from '../../FocusStage/ShaderUniformsRail'
import { ShaderConsole } from '../../FocusStage/ShaderConsole'
import { EffectRow } from './EffectRow'
import { useColorEditor } from '../use-color-editor'

/** Per-open session counter, so each shader focus open is its own undo group. */
let SHADER_SESSION_SEQ = 0

/** Merge shape shadow[] + blur + glass + noise + texture into a unified EffectItem list. */
function mergeEffects(node: RectLikeNode): EffectItem[] {
  const items: EffectItem[] = []
  for (const s of (node as Record<string, unknown>).shadow as Shadow[] ?? []) {
    // Guard against holey/corrupted shadow arrays (e.g. an undefined pushed by
    // a stale splitEffects) so the whole panel doesn't crash on `s.style`.
    if (!s) continue
    items.push({ kind: s.style, shadow: s })
  }
  // A shape may carry a layer blur AND a background blur simultaneously
  // (at most one of each kind). `node.blur` is the canonical slot used by
  // upstream Penpot — its `.type` field decides which kind it is.
  // `node.backgroundBlur` is our convention for the second slot when both
  // are present.
  const blur = (node as Record<string, unknown>).blur as Blur | undefined
  if (blur) {
    const kind = blur.type === 'background-blur' ? 'background-blur' : 'layer-blur'
    items.push({ kind, blur })
  }
  const backgroundBlur = (node as Record<string, unknown>).backgroundBlur as Blur | undefined
  if (backgroundBlur) {
    items.push({ kind: 'background-blur', blur: backgroundBlur })
  }
  const glass = (node as Record<string, unknown>).glass as Glass | undefined
  if (glass) {
    items.push({ kind: 'glass', glass })
  }
  const noise = (node as Record<string, unknown>).noise as Noise | undefined
  if (noise) {
    items.push({ kind: 'noise', noise })
  }
  const texture = (node as Record<string, unknown>).texture as Texture | undefined
  if (texture) {
    items.push({ kind: 'texture', texture })
  }
  const material = (node as Record<string, unknown>).material as Material | undefined
  if (material) {
    items.push({ kind: 'material', material })
  }
  return items
}

/** Split EffectItem list back into shadow[], blurs, glass, noise, and texture for committing. */
function splitEffects(effects: EffectItem[]): {
  shadow: Shadow[]
  layerBlur: Blur | undefined
  backgroundBlur: Blur | undefined
  glass: Glass | undefined
  noise: Noise | undefined
  texture: Texture | undefined
  material: Material | undefined
} {
  const shadows: Shadow[] = []
  let layerBlur: Blur | undefined
  let backgroundBlur: Blur | undefined
  let glass: Glass | undefined
  let noise: Noise | undefined
  let texture: Texture | undefined
  let material: Material | undefined
  // At most one of each blur kind survives — if the user added two
  // layer-blur rows, the last one wins. Same for background-blur.
  for (const e of effects) {
    if (e.kind === 'layer-blur') {
      layerBlur = e.blur
    } else if (e.kind === 'background-blur') {
      backgroundBlur = e.blur
    } else if (e.kind === 'glass') {
      glass = e.glass
    } else if (e.kind === 'noise') {
      noise = e.noise
    } else if (e.kind === 'texture') {
      texture = e.texture
    } else if (e.kind === 'material') {
      material = e.material
    } else if (e.kind === 'drop-shadow' || e.kind === 'inner-shadow') {
      shadows.push(e.shadow)
    }
  }
  return { shadow: shadows, layerBlur, backgroundBlur, glass, noise, texture, material }
}

export interface EffectsSectionProps {
  nodeId: string
  readOnly: boolean
  initialNode: RectLikeNode
}

export function EffectsSection({ nodeId, readOnly, initialNode }: EffectsSectionProps) {
  const { activeTarget, closeEditor } = useColorEditor()
  const [effects, setEffects] = useState<EffectItem[]>(() => mergeEffects(initialNode))
  const [collapsed, setCollapsed] = useState(false)

  // Render-phase sync: when initialNode changes externally, reset local state.
  const [prevNode, setPrevNode] = useState(initialNode)
  if (prevNode !== initialNode) {
    setPrevNode(initialNode)
    setEffects(mergeEffects(initialNode))
  }

  const commitEffects = useCallback(
    async (next: EffectItem[]) => {
      if (readOnly) return
      const before = getCommittedNodeOnActivePage(nodeId)
      const pid = getActiveOrSinglePageId()
      if (!before || !pid) return
      const { shadow, layerBlur, backgroundBlur, glass, noise, texture, material } = splitEffects(next)
      const partial: Record<string, unknown> = { shadow }
      // Include blur fields when they have a value or when clearing a
      // previously set blur. Use null (not undefined) to clear —
      // commitNodePartialUpdate skips undefined. The layer slot lives on
      // `blur`, the background slot on `backgroundBlur`; see orchestration
      // for the WASM routing.
      const hadBlur = (before as Record<string, unknown>).blur != null
      if (layerBlur !== undefined || hadBlur) {
        partial.blur = layerBlur ?? null
      }
      const hadBackgroundBlur = (before as Record<string, unknown>).backgroundBlur != null
      if (backgroundBlur !== undefined || hadBackgroundBlur) {
        partial.backgroundBlur = backgroundBlur ?? null
      }
      const hadGlass = (before as Record<string, unknown>).glass != null
      if (glass !== undefined || hadGlass) {
        partial.glass = glass ?? null
      }
      const hadNoise = (before as Record<string, unknown>).noise != null
      if (noise !== undefined || hadNoise) {
        partial.noise = noise ?? null
      }
      // Include texture when it has a value or when clearing a previously set texture.
      const hadTexture = (before as Record<string, unknown>).texture != null
      if (texture !== undefined || hadTexture) {
        partial.texture = texture ?? null
      }
      const hadMaterial = (before as Record<string, unknown>).material != null
      if (material !== undefined || hadMaterial) {
        partial.material = material ?? null
      }
      await commitNodePartialUpdate(nodeId, before, partial as Partial<PenpotNode>, pid)
    },
    [readOnly, nodeId],
  )

  const onEffectChange = useCallback(
    (effect: EffectItem, index: number) => {
      const next = [...effects]
      if (index < 0 || index >= next.length) return
      next[index] = effect
      setEffects(next)
      void commitEffects(next)
    },
    [effects, commitEffects],
  )

  // Material effects open the shader focus stage (a center-region takeover)
  // instead of the inline floating editor: SkSL authoring wants the room, and
  // the stage commits `{ material }` straight onto this node.
  const onOpenFocus = useCallback(
    (index: number) => {
      const item = effects[index]
      if (item?.kind !== 'material') return
      // The session owns its undo `groupId`: the stage's commits carry it (so
      // canvas group-undo collapses the session), and `undoScope` re-uses it so
      // the focus reader's revert-by-append frames are swept by that same
      // group-undo. Unique per open — each focus session is its own group.
      const groupId = `shader-material:${(SHADER_SESSION_SEQ += 1)}`
      openFocusStage({
        id: 'shader-material',
        title: 'Custom shader',
        center: (
          <ShaderMaterialStage nodeId={nodeId} initialMaterial={item.material} groupId={groupId} />
        ),
        right: <ShaderUniformsRail />,
        bottom: <ShaderConsole />,
        undoScope: { nodeIds: [nodeId], attrs: ['material'], groupId },
      })
    },
    [effects, nodeId],
  )

  const addEffect = useCallback(() => {
    if (effects.length >= MAX_EFFECTS) return
    const next: EffectItem[] = [...effects, { kind: 'drop-shadow', shadow: { ...DEFAULT_SHADOW } }]
    setEffects(next)
    void commitEffects(next)
  }, [effects, commitEffects])

  const removeEffect = useCallback(
    (index: number) => {
      // Close effect editor if removing the effect being edited
      if (activeTarget && activeTarget.index === index && activeTarget.kind !== 'fill' && activeTarget.kind !== 'stroke') closeEditor()
      const next = effects.filter((_, i) => i !== index)
      setEffects(next)
      void commitEffects(next)
    },
    [effects, commitEffects, activeTarget, closeEditor],
  )

  const hasEffects = effects.length > 0
  const canAdd = !readOnly && effects.length < MAX_EFFECTS

  return (
    <>
      <Separator />
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 py-0.5">
          <button
            type="button"
            className="flex min-h-8 flex-1 items-center gap-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            )}
            Effects
          </button>
          {!readOnly && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={addEffect}
              disabled={!canAdd}
              aria-label="Add effect"
              title={canAdd ? 'Add effect' : `Maximum ${MAX_EFFECTS} effects`}
            >
              +
            </Button>
          )}
        </div>

        {!collapsed && hasEffects && (
          <div className="space-y-2 pl-0.5">
            {effects.map((effect, i) => (
              <EffectRow
                key={i}
                effect={effect}
                index={i}
                readOnly={readOnly}
                onChange={onEffectChange}
                onRemove={removeEffect}
                onOpenFocus={onOpenFocus}
              />
            ))}
          </div>
        )}

        {!collapsed && !hasEffects && !readOnly && (
          <p className="text-xs text-muted-foreground">No effects. Use + to add.</p>
        )}
      </div>
    </>
  )
}
