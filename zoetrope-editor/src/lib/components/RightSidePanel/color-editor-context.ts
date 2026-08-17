import { createContext, type RefObject } from 'react'
import type { Fill } from 'penpot-exporter/types'
import type { EffectItem } from '../../renderer/properties/panel-utils'
import type { StrokeWithSettings } from '../../renderer/stroke-settings'

export type ColorEditorKind = 'fill' | 'stroke' | 'drop-shadow' | 'inner-shadow' | 'layer-blur' | 'background-blur' | 'glass' | 'noise'

export interface ColorEditorTarget {
  kind: ColorEditorKind
  index: number
}

export interface ColorEditorContextValue {
  activeTarget: ColorEditorTarget | null
  activeFill: Fill | null
  anchorY: number
  title: string
  openEditor: (
    kind: ColorEditorKind,
    index: number,
    fill: Fill,
    anchorY: number,
    title: string,
    onChange: (fill: Fill) => void,
  ) => void
  closeEditor: () => void
  onChangeRef: RefObject<((fill: Fill) => void) | null>

  // Effect editor (glass / shadow properties)
  activeEffect: EffectItem | null
  onEffectChangeRef: RefObject<((effect: EffectItem) => void) | null>
  openEffectEditor: (
    kind: ColorEditorKind,
    index: number,
    effect: EffectItem,
    anchorY: number,
    title: string,
    onChange: (effect: EffectItem) => void,
  ) => void

  // Stroke-settings editor (Basic tab: dashes / dash-cap / join / miter)
  activeStrokeSettings: StrokeWithSettings | null
  onStrokeSettingsChangeRef: RefObject<((stroke: StrokeWithSettings) => void) | null>
  openStrokeSettings: (
    kind: ColorEditorKind,
    index: number,
    stroke: StrokeWithSettings,
    anchorY: number,
    title: string,
    onChange: (stroke: StrokeWithSettings) => void,
  ) => void
}

export const ColorEditorContext = createContext<ColorEditorContextValue>({
  activeTarget: null,
  activeFill: null,
  anchorY: 12,
  title: '',
  openEditor: () => {},
  closeEditor: () => {},
  onChangeRef: { current: null },
  activeEffect: null,
  onEffectChangeRef: { current: null },
  openEffectEditor: () => {},
  activeStrokeSettings: null,
  onStrokeSettingsChangeRef: { current: null },
  openStrokeSettings: () => {},
})
