import { LayoutDashboard, LayoutGrid, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { LayoutMode } from './layout-mode'

export interface LayoutModeToggleProps {
  mode: LayoutMode | null
  onChange: (mode: LayoutMode | null) => void
  disabled?: boolean
}

const MODES: ReadonlyArray<{
  mode: LayoutMode
  Icon: typeof LayoutDashboard
  label: string
}> = [
  { mode: 'flex', Icon: LayoutDashboard, label: 'Flex layout' },
  { mode: 'grid', Icon: LayoutGrid, label: 'Grid layout' },
]

export function LayoutModeToggle({ mode, onChange, disabled }: LayoutModeToggleProps) {
  return (
    <div className="flex gap-1">
      {MODES.map(({ mode: m, Icon, label }) => {
        const active = mode === m
        return (
          <Button
            key={m}
            type="button"
            variant={active ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-pressed={active}
            aria-label={active ? `Disable ${label.toLowerCase()}` : label}
            title={active ? `Disable ${label.toLowerCase()}` : label}
            disabled={disabled}
            onClick={() => onChange(active ? null : m)}
          >
            <Icon className="size-3.5" aria-hidden />
          </Button>
        )
      })}
      {mode != null && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Remove layout"
          title="Remove layout"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          <Minus className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  )
}
