/**
 * Searchable font picker that opens as a floating side panel next to the
 * properties rail — the same `FloatingPanelShell` the colour editor uses. Lists
 * the full Google Fonts catalogue (~1,900 families from
 * `renderer/api/google-fonts`), filtered by a search box. Results are capped so
 * a query is needed to reach the long tail (keeps the DOM light without a
 * virtualiser).
 */

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { FONT_FAMILIES } from '@/lib/renderer/api/google-fonts'
import { FloatingPanelShell } from './FloatingPanelShell'

/** Max rows rendered at once; refine the search to reach the rest. */
const RESULT_CAP = 200

const CATEGORY_LABEL: Record<string, string> = {
  'sans-serif': 'Sans',
  serif: 'Serif',
  display: 'Display',
  handwriting: 'Script',
  monospace: 'Mono',
}

export interface FontPickerPanelProps {
  open: boolean
  anchorY: number
  currentFontId: string
  onSelect: (fontId: string, family: string) => void
  onClose: () => void
}

export function FontPickerPanel({
  open,
  anchorY,
  currentFontId,
  onSelect,
  onClose,
}: FontPickerPanelProps) {
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return FONT_FAMILIES
    return FONT_FAMILIES.filter((f) => f.family.toLowerCase().includes(q))
  }, [query])

  const shown = results.slice(0, RESULT_CAP)

  return (
    <FloatingPanelShell
      targetKey={open ? 'font' : null}
      anchorY={anchorY}
      title="Font"
      width={300}
      minHeight={340}
      onClose={onClose}
    >
      <div className="flex flex-col gap-2">
        <Input
          type="search"
          autoFocus
          placeholder="Search fonts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search fonts"
        />

        <div className="-mx-1 max-h-[55vh] overflow-y-auto">
          {shown.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No fonts match “{query.trim()}”.
            </p>
          ) : (
            <ul>
              {shown.map((f) => (
                <li key={f.fontId}>
                  <button
                    type="button"
                    onClick={() => onSelect(f.fontId, f.family)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
                      f.fontId === currentFontId && 'bg-accent font-medium',
                    )}
                  >
                    <span className="min-w-0 truncate">{f.family}</span>
                    <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">
                      {CATEGORY_LABEL[f.category] ?? ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {results.length > shown.length && (
          <p className="px-2 text-center text-[10px] text-muted-foreground">
            Showing {shown.length} of {results.length} — refine your search.
          </p>
        )}
      </div>
    </FloatingPanelShell>
  )
}
