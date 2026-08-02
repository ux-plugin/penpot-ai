/**
 * PageStrip — a document drawn as a strip of its pages, one cell per page, with
 * that page's boards laid out on it.
 *
 * These are structural stand-ins, not thumbnails: the cell count, the page names
 * and the number of boards per page are all real (they come from the stored
 * summary), but the boards are placed by an arrangement table rather than by
 * their actual geometry. Real renders are a later slice; until then this shows
 * the true shape of a document without paying to open one.
 */

import type { PageSummary } from '../../persistence'

/** Where boards sit on a page cell, keyed by how many there are.
 *  `[left, top, width, height]` in percent. */
const ARRANGEMENTS: Record<number, Array<[number, number, number, number]>> = {
  1: [[19, 14, 62, 72]],
  2: [
    [6, 18, 42, 64],
    [52, 18, 42, 64],
  ],
  3: [
    [6, 10, 42, 40],
    [52, 10, 42, 40],
    [6, 54, 42, 36],
  ],
  4: [
    [6, 10, 42, 38],
    [52, 10, 42, 38],
    [6, 52, 42, 38],
    [52, 52, 42, 38],
  ],
  5: [
    [5, 10, 28, 38],
    [36, 10, 28, 38],
    [67, 10, 28, 38],
    [5, 52, 28, 38],
    [36, 52, 28, 38],
  ],
  6: [
    [5, 10, 28, 38],
    [36, 10, 28, 38],
    [67, 10, 28, 38],
    [5, 52, 28, 38],
    [36, 52, 28, 38],
    [67, 52, 28, 38],
  ],
}

interface PageCellProps {
  page: PageSummary
  tint: string
  width: number
  height: number
}

function PageCell({ page, tint, width, height }: PageCellProps) {
  const boards = ARRANGEMENTS[Math.min(Math.max(page.boardCount, 1), 6)] ?? ARRANGEMENTS[1]!
  return (
    <div
      className="relative flex-none overflow-hidden rounded-[2px] border border-border"
      style={{ width, height, background: `color-mix(in oklab, var(--muted) 88%, ${tint})` }}
      title={`${page.name} — ${page.boardCount} ${page.boardCount === 1 ? 'board' : 'boards'}`}
    >
      {page.boardCount === 0 ? null : (
        boards.map(([left, top, w, h], i) => (
          <span
            key={i}
            className="absolute rounded-[1px] border border-border bg-background"
            style={{ left: `${left}%`, top: `${top}%`, width: `${w}%`, height: `${h}%` }}
          />
        ))
      )}
    </div>
  )
}

interface PageStripProps {
  pages: PageSummary[]
  tint: string
  /** Page captions are worth the room in the hero, not in a 62px-tall list row. */
  captions?: boolean
  cellWidth?: number
  cellHeight?: number
}

export function PageStrip({
  pages,
  tint,
  captions = false,
  cellWidth = 58,
  cellHeight = 40,
}: PageStripProps) {
  if (!pages.length) {
    return <div className="text-xs text-muted-foreground">No pages</div>
  }
  return (
    <div className="flex items-start gap-1.5 overflow-hidden">
      {pages.map((page) => (
        <div key={page.id} className="flex flex-none flex-col gap-1">
          <PageCell page={page} tint={tint} width={cellWidth} height={cellHeight} />
          {captions && (
            <span
              className="block truncate font-mono text-[10px] text-muted-foreground"
              style={{ maxWidth: cellWidth }}
            >
              {page.name}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
