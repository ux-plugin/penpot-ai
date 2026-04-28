import type { GridTrack } from 'penpot-exporter/types'

export type GridTrackType = NonNullable<GridTrack['type']>

export interface TrackTypeOption {
  type: GridTrackType
  label: string
  hint: string
  hasValue: boolean
  defaultValue?: number
}

export const TRACK_TYPE_OPTIONS: ReadonlyArray<TrackTypeOption> = [
  { type: 'flex', label: 'fr', hint: 'Flex fraction', hasValue: true, defaultValue: 1 },
  { type: 'fixed', label: 'px', hint: 'Pixels', hasValue: true, defaultValue: 120 },
  { type: 'percent', label: '%', hint: 'Percent', hasValue: true, defaultValue: 25 },
  { type: 'auto', label: 'auto', hint: 'Fit content', hasValue: false },
]

export function trackTypeOption(type: GridTrackType): TrackTypeOption {
  return TRACK_TYPE_OPTIONS.find((o) => o.type === type) ?? TRACK_TYPE_OPTIONS[0]
}

export function defaultTrack(type: GridTrackType, prevValue?: number): GridTrack {
  const opt = trackTypeOption(type)
  if (!opt.hasValue) return { type }
  return { type, value: prevValue ?? opt.defaultValue ?? 1 }
}

export function trackChipLabel(type: GridTrackType): string {
  return trackTypeOption(type).label
}
