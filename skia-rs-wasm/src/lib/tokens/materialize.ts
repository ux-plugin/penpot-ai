/**
 * Shared token → concrete-prop writer. Both apply (P2.4) and propagation (P2.5)
 * fold a list of `{attr, resolvedValue}` into one `Partial<PenpotNode>`, so the
 * two paths can never drift on *how* a value lands on a shape.
 *
 * Each writer is typeof-guarded: a value whose kind doesn't fit the attr (e.g.
 * a color string targeting `r1`) is skipped. Returns the partial plus the set
 * of attrs actually written, so callers can stamp `appliedTokens` accordingly.
 *
 * v1 attrs: fill, strokeColor, strokeWidth, r1..r4, opacity, typography. The
 * width/height/x/y + spacing/sizing layout attrs are deferred (no writer yet).
 */

import type { Fill, PenpotNode, Stroke, TextContent } from 'penpot-exporter/types'
import { patchContent, type SpanPatch } from '../components/RightSidePanel/Sections/text-typography'
import type { TokenProperties } from './types'

export interface AttrWrite {
  attr: TokenProperties
  value: number | string | Record<string, string> | null
}

export interface MaterializeResult {
  partial: Partial<PenpotNode>
  written: Set<TokenProperties>
}

/** sd-transforms appends `px` to dimension sub-values; the span model is unitless. */
function stripUnit(s: string): string {
  return s.replace(/(px|rem)$/i, '')
}

function typographyToSpanPatch(v: Record<string, string>): SpanPatch {
  const span: SpanPatch = {}
  if (v.fontFamily) span.fontFamily = v.fontFamily
  if (v.fontSize) span.fontSize = stripUnit(v.fontSize)
  if (v.fontWeight) span.fontWeight = v.fontWeight
  if (v.lineHeight) span.lineHeight = stripUnit(v.lineHeight)
  if (v.letterSpacing) span.letterSpacing = stripUnit(v.letterSpacing)
  if (v.textCase) span.textTransform = v.textCase
  if (v.textDecoration) span.textDecoration = v.textDecoration
  return span
}

export function materializeAttrWrites(before: PenpotNode, writes: AttrWrite[]): MaterializeResult {
  const partial: Partial<PenpotNode> = {}
  const written = new Set<TokenProperties>()
  const existingStrokes = (before as { strokes?: Stroke[] }).strokes
  let strokes: Stroke[] | undefined

  for (const { attr, value } of writes) {
    switch (attr) {
      case 'fill': {
        if (typeof value !== 'string') break
        const fills: Fill[] = [...((before as { fills?: Fill[] }).fills ?? [])]
        fills[0] = { ...(fills[0] ?? {}), fillColor: value, fillOpacity: fills[0]?.fillOpacity ?? 1 }
        partial.fills = fills
        written.add(attr)
        break
      }
      case 'strokeColor': {
        // Recolor an existing stroke only — don't fabricate a width-less stroke.
        if (typeof value !== 'string' || !existingStrokes?.length) break
        strokes ??= [...existingStrokes]
        strokes[0] = { ...strokes[0], strokeColor: value, strokeOpacity: strokes[0]?.strokeOpacity ?? 1 }
        written.add(attr)
        break
      }
      case 'strokeWidth': {
        if (typeof value !== 'number' || !existingStrokes?.length) break
        strokes ??= [...existingStrokes]
        strokes[0] = { ...strokes[0], strokeWidth: value }
        written.add(attr)
        break
      }
      case 'r1':
      case 'r2':
      case 'r3':
      case 'r4': {
        if (typeof value !== 'number') break
        ;(partial as Record<string, unknown>)[attr] = value
        written.add(attr)
        break
      }
      case 'opacity': {
        if (typeof value !== 'number') break
        partial.opacity = value
        written.add(attr)
        break
      }
      case 'typography': {
        if (typeof value !== 'object' || value === null) break
        partial.content = patchContent((before as { content?: TextContent }).content, {
          span: typographyToSpanPatch(value as Record<string, string>),
        })
        written.add(attr)
        break
      }
      default:
        // Deferred attr (width/height/x/y/gaps/padding/margins/sizing) — no writer yet.
        break
    }
  }

  if (strokes) partial.strokes = strokes
  return { partial, written }
}
