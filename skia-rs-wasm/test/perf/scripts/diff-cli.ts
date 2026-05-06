#!/usr/bin/env tsx
/**
 * pnpm perf:diff <baseline.json> <current.json> [--out diff.md]
 *
 * Loads two perf-run files (the JSON the runner writes to
 * `test/perf/.results/perf.json`) and prints a markdown diff.
 *
 * Exits non-zero when at least one cell is `fail`. Suitable for
 * wiring into a CI gate later, but operates standalone for now.
 */
import fs from 'node:fs'
import path from 'node:path'
import { diff, renderMarkdown, type PerfRunFile } from '../diff'

function readPerfRun(p: string): PerfRunFile {
  const abs = path.resolve(p)
  const txt = fs.readFileSync(abs, 'utf-8')
  return JSON.parse(txt) as PerfRunFile
}

function main(): number {
  const args = process.argv.slice(2)
  let outPath: string | null = null
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--out' || a === '-o') {
      outPath = args[++i] ?? null
    } else if (a === '-h' || a === '--help') {
      // eslint-disable-next-line no-console
      console.log('usage: perf:diff <baseline.json> <current.json> [--out diff.md]')
      return 0
    } else {
      positional.push(a)
    }
  }
  if (positional.length !== 2) {
    // eslint-disable-next-line no-console
    console.error('perf:diff: expected two positional args (baseline + current)')
    return 2
  }
  const [baselinePath, currentPath] = positional
  const baseline = readPerfRun(baselinePath)
  const current = readPerfRun(currentPath)
  const report = diff(baseline, current)
  report.baseline_path = baselinePath
  report.current_path = currentPath
  const md = renderMarkdown(report)
  if (outPath) {
    fs.writeFileSync(outPath, md)
  } else {
    // eslint-disable-next-line no-console
    process.stdout.write(md + '\n')
  }
  return report.summary.fail > 0 ? 1 : 0
}

process.exit(main())
