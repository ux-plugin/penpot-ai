/**
 * A component's thumbnail: its main instance flattened to SVG boxes.
 *
 * See `renderer/component/component-preview` for why this isn't drawn by the real
 * renderer the way shader thumbnails are.
 */

import { useMemo } from 'react'
import { computed } from '@preact/signals-core'
import { Component } from 'lucide-react'
import { useSignal } from '../../doc'
import { buildComponentPreview } from '../../renderer/component/component-preview'
import type { LocalComponent } from '../../common/component'

/** Text renders as a bar; fade it so it reads as a line of text, not a slab. */
const TEXT_OPACITY = 0.55

export function ComponentThumbnail({
  component,
  className,
}: {
  component: LocalComponent
  className?: string
}) {
  // A computed, so the thumbnail tracks edits to the main.
  const mainId = component.mainInstanceId
  const preview = useSignal(useMemo(() => computed(() => buildComponentPreview(mainId)), [mainId]))

  // No main on this page (or nothing visible in it) — a generic mark beats an
  // empty box that reads as a broken thumbnail.
  if (!preview || preview.items.length === 0) {
    return (
      <span className={className}>
        <Component className="size-full text-muted-foreground" aria-hidden />
      </span>
    )
  }

  return (
    <svg
      className={className}
      viewBox={`0 0 ${preview.width} ${preview.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${component.name} preview`}
    >
      {preview.items.map((item, i) => (
        <rect
          key={i}
          x={item.x}
          y={item.y}
          width={item.width}
          height={item.height}
          rx={item.rx || undefined}
          fill={item.fill ?? 'none'}
          fillOpacity={item.isText ? TEXT_OPACITY : undefined}
          stroke={item.stroke}
          strokeWidth={item.stroke ? Math.max(preview.width, preview.height) / 100 : undefined}
        />
      ))}
    </svg>
  )
}
