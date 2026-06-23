/**
 * Editor-local change variants that target `docProxy.meta` (the document-level
 * shared library state — paint styles, text styles) rather than a specific page.
 *
 * The vendored exporter `Change` union (`add-obj | mod-obj | del-obj | ...`) is
 * strictly page-scoped: every variant carries a `pageId` and every reducer in
 * `process-changes.ts` mutates an `IndexedPage.objects`. There is no way to
 * express "edit document-level metadata" in that union without polluting it.
 *
 * Instead, this module defines a parallel `DocMetaChange` union that the commit
 * pipeline ferries alongside the page `Change[]`. Both are applied in the same
 * commit (so a sync — "user edited a color style, fan out to N pages" — lands
 * as one history frame), but the doc-meta arm mutates `docProxy.meta` directly
 * and the renderer-sync subscriber ignores it (no shape geometry to push).
 */

import type { FillStyle, TypographyStyle, Uuid } from 'penpot-exporter/types'
import type { DocumentMeta } from '../renderer/store/doc-proxy'

export interface AddPaintStyleChange {
  type: 'add-paint-style'
  id: Uuid
  style: FillStyle
}
export interface ModPaintStyleChange {
  type: 'mod-paint-style'
  id: Uuid
  style: FillStyle
}
export interface DelPaintStyleChange {
  type: 'del-paint-style'
  id: Uuid
}
export interface AddTextStyleChange {
  type: 'add-text-style'
  id: Uuid
  style: TypographyStyle
}
export interface ModTextStyleChange {
  type: 'mod-text-style'
  id: Uuid
  style: TypographyStyle
}
export interface DelTextStyleChange {
  type: 'del-text-style'
  id: Uuid
}

export type DocMetaChange =
  | AddPaintStyleChange
  | ModPaintStyleChange
  | DelPaintStyleChange
  | AddTextStyleChange
  | ModTextStyleChange
  | DelTextStyleChange

/** Pure reducer. Returns the new meta; never mutates input. */
export function processDocMetaChange(
  meta: DocumentMeta,
  change: DocMetaChange,
): DocumentMeta {
  switch (change.type) {
    case 'add-paint-style':
    case 'mod-paint-style': {
      const paintStyles = { ...meta.paintStyles, [change.id]: change.style }
      return { ...meta, paintStyles }
    }
    case 'del-paint-style': {
      const { [change.id]: _removed, ...paintStyles } = meta.paintStyles
      return { ...meta, paintStyles }
    }
    case 'add-text-style':
    case 'mod-text-style': {
      const textStyles = { ...meta.textStyles, [change.id]: change.style }
      return { ...meta, textStyles }
    }
    case 'del-text-style': {
      const { [change.id]: _removed, ...textStyles } = meta.textStyles
      return { ...meta, textStyles }
    }
    default: {
      const _exhaustive: never = change
      void _exhaustive
      return meta
    }
  }
}

export function processDocMetaChanges(
  meta: DocumentMeta,
  changes: readonly DocMetaChange[],
): DocumentMeta {
  let next = meta
  for (const c of changes) next = processDocMetaChange(next, c)
  return next
}
