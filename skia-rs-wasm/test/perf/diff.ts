import type { AggregatedCell } from './aggregate'
import {
  CACHE_HIT_RATIO_DROP_FAIL_PP,
  CACHE_HIT_RATIO_DROP_WARN_PP,
  Severity,
  TIMING_NOISE_FLOOR_MS,
  TIMING_RATIO_FAIL,
  TIMING_RATIO_WARN,
} from './thresholds'

export interface PerfRunFile {
  generated_at: string
  frames_per_run: number
  repeats: number
  cells: AggregatedCell[]
}

export interface CellKey {
  scene_id: number
  scenario: string
}

export interface TagDiff {
  tag: string
  baseline_count: number
  current_count: number
  baseline_p50_ms: number
  current_p50_ms: number
  ratio: number // current / baseline
  severity: Severity
  reason: string
}

export interface CellDiff {
  scene_id: number
  scene_name: string
  scenario: string
  baseline_wall_p50: number
  current_wall_p50: number
  baseline_hit_ratio: number
  current_hit_ratio: number
  cache_severity: Severity
  cache_reason: string
  tag_diffs: TagDiff[]
  cell_severity: Severity
}

export interface DiffReport {
  baseline_path: string
  current_path: string
  baseline_generated_at: string
  current_generated_at: string
  cells: CellDiff[]
  summary: { fail: number; warn: number; ok: number }
}

const cellKey = (c: { scene_id: number; scenario: string }): string =>
  `${c.scene_id}|${c.scenario}`

function hitRatio(c: AggregatedCell): number {
  const total = c.cache.tile_hits + c.cache.tile_misses
  return total === 0 ? 1 : c.cache.tile_hits / total
}

function bumpSeverity(current: Severity, next: Severity): Severity {
  const order: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 }
  return order[next] > order[current] ? next : current
}

function diffTag(
  base: AggregatedCell['stats'][number] | undefined,
  curr: AggregatedCell['stats'][number] | undefined,
  tag: string,
): TagDiff | null {
  const b = base?.p50_ms ?? 0
  const c = curr?.p50_ms ?? 0
  const bCount = base?.count ?? 0
  const cCount = curr?.count ?? 0

  // Counts must match. Skip tags below the noise floor for timing
  // comparison but still flag count drift.
  if (bCount !== cCount) {
    return {
      tag,
      baseline_count: bCount,
      current_count: cCount,
      baseline_p50_ms: b,
      current_p50_ms: c,
      ratio: b > 0 ? c / b : Number.POSITIVE_INFINITY,
      severity: 'fail',
      reason: `count drift ${bCount} → ${cCount}`,
    }
  }
  if (b < TIMING_NOISE_FLOOR_MS && c < TIMING_NOISE_FLOOR_MS) {
    return null
  }
  const ratio = b > 0 ? c / b : Number.POSITIVE_INFINITY
  let severity: Severity = 'ok'
  let reason = ''
  if (ratio >= TIMING_RATIO_FAIL) {
    severity = 'fail'
    reason = `${(ratio * 100 - 100).toFixed(1)}% slower (>=${((TIMING_RATIO_FAIL - 1) * 100).toFixed(0)}%)`
  } else if (ratio >= TIMING_RATIO_WARN) {
    severity = 'warn'
    reason = `${(ratio * 100 - 100).toFixed(1)}% slower (warn)`
  }
  return {
    tag,
    baseline_count: bCount,
    current_count: cCount,
    baseline_p50_ms: b,
    current_p50_ms: c,
    ratio,
    severity,
    reason,
  }
}

export function diff(baseline: PerfRunFile, current: PerfRunFile): DiffReport {
  const baselineCells = new Map(baseline.cells.map((c) => [cellKey(c), c] as const))
  const currentCells = new Map(current.cells.map((c) => [cellKey(c), c] as const))
  const allKeys = new Set<string>([...baselineCells.keys(), ...currentCells.keys()])

  const cells: CellDiff[] = []
  const summary = { fail: 0, warn: 0, ok: 0 }

  for (const key of allKeys) {
    const b = baselineCells.get(key)
    const c = currentCells.get(key)
    if (!b || !c) {
      // Missing on one side — record as a fail; the matrix is fixed.
      const present = b ?? c!
      cells.push({
        scene_id: present.scene_id,
        scene_name: present.scene_name,
        scenario: present.scenario,
        baseline_wall_p50: b?.wall_ms_p50 ?? 0,
        current_wall_p50: c?.wall_ms_p50 ?? 0,
        baseline_hit_ratio: b ? hitRatio(b) : 0,
        current_hit_ratio: c ? hitRatio(c) : 0,
        cache_severity: 'fail',
        cache_reason: !b ? 'baseline missing this cell' : 'current missing this cell',
        tag_diffs: [],
        cell_severity: 'fail',
      })
      summary.fail += 1
      continue
    }
    const bHit = hitRatio(b)
    const cHit = hitRatio(c)
    const drop = (bHit - cHit) * 100 // pp
    let cacheSeverity: Severity = 'ok'
    let cacheReason = ''
    if (drop >= CACHE_HIT_RATIO_DROP_FAIL_PP) {
      cacheSeverity = 'fail'
      cacheReason = `tile cache hit ratio dropped ${drop.toFixed(1)}pp`
    } else if (drop >= CACHE_HIT_RATIO_DROP_WARN_PP) {
      cacheSeverity = 'warn'
      cacheReason = `tile cache hit ratio dropped ${drop.toFixed(1)}pp (warn)`
    }

    const baseTags = new Map(b.stats.map((s) => [s.tag, s] as const))
    const currTags = new Map(c.stats.map((s) => [s.tag, s] as const))
    const tagKeys = new Set<string>([...baseTags.keys(), ...currTags.keys()])
    const tagDiffs: TagDiff[] = []
    for (const t of tagKeys) {
      const td = diffTag(baseTags.get(t), currTags.get(t), t)
      if (td && td.severity !== 'ok') tagDiffs.push(td)
    }
    tagDiffs.sort((a, b) => b.current_p50_ms - a.current_p50_ms)
    let cellSeverity: Severity = cacheSeverity
    for (const td of tagDiffs) cellSeverity = bumpSeverity(cellSeverity, td.severity)

    cells.push({
      scene_id: b.scene_id,
      scene_name: b.scene_name,
      scenario: b.scenario,
      baseline_wall_p50: b.wall_ms_p50,
      current_wall_p50: c.wall_ms_p50,
      baseline_hit_ratio: bHit,
      current_hit_ratio: cHit,
      cache_severity: cacheSeverity,
      cache_reason: cacheReason,
      tag_diffs: tagDiffs,
      cell_severity: cellSeverity,
    })
    summary[cellSeverity] += 1
  }

  cells.sort((a, b) => {
    if (a.cell_severity !== b.cell_severity) {
      return a.cell_severity === 'fail' ? -1 : a.cell_severity === 'warn' ? -1 : 1
    }
    return a.scene_id - b.scene_id || a.scenario.localeCompare(b.scenario)
  })

  return {
    baseline_path: '',
    current_path: '',
    baseline_generated_at: baseline.generated_at,
    current_generated_at: current.generated_at,
    cells,
    summary,
  }
}

export function renderMarkdown(report: DiffReport): string {
  const sevIcon = (s: Severity): string => (s === 'fail' ? ':x:' : s === 'warn' ? ':warning:' : ':white_check_mark:')
  const lines: string[] = []
  lines.push(`# Perf diff`)
  lines.push('')
  lines.push(`- baseline: \`${report.baseline_path}\` (${report.baseline_generated_at})`)
  lines.push(`- current : \`${report.current_path}\` (${report.current_generated_at})`)
  lines.push(
    `- summary: **${report.summary.fail} fail · ${report.summary.warn} warn · ${report.summary.ok} ok**`,
  )
  lines.push('')

  for (const cell of report.cells) {
    if (cell.cell_severity === 'ok' && cell.tag_diffs.length === 0) continue
    lines.push(
      `## ${sevIcon(cell.cell_severity)} ${cell.scene_name} · ${cell.scenario}`,
    )
    lines.push('')
    lines.push(`- wall p50: ${cell.baseline_wall_p50.toFixed(1)}ms → ${cell.current_wall_p50.toFixed(1)}ms`)
    lines.push(
      `- tile cache hit ratio: ${(cell.baseline_hit_ratio * 100).toFixed(1)}% → ${(cell.current_hit_ratio * 100).toFixed(1)}%${cell.cache_reason ? ` ${sevIcon(cell.cache_severity)} ${cell.cache_reason}` : ''}`,
    )
    if (cell.tag_diffs.length > 0) {
      lines.push('')
      lines.push('| sev | tag | baseline p50 ms | current p50 ms | Δ | reason |')
      lines.push('|---|---|---:|---:|---:|---|')
      for (const td of cell.tag_diffs) {
        lines.push(
          `| ${sevIcon(td.severity)} | \`${td.tag}\` | ${td.baseline_p50_ms.toFixed(2)} | ${td.current_p50_ms.toFixed(2)} | ${(td.ratio * 100 - 100).toFixed(1)}% | ${td.reason} |`,
        )
      }
    }
    lines.push('')
  }
  if (report.summary.fail === 0 && report.summary.warn === 0) {
    lines.push('No timing or count regressions above thresholds.')
  }
  return lines.join('\n')
}
