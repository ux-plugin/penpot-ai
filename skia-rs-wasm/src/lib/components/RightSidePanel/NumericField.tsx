/**
 * Shared numeric input with a single interaction policy:
 *   - Typing edits a draft string; nothing commits per keystroke.
 *   - Enter commits and keeps focus (text reselected); blur commits if changed;
 *     Escape reverts.
 *   - ArrowUp/Down and wheel-while-focused step the value live (Shift=10×,
 *     Alt=0.1×).
 *
 * History coalescing is FOCUS-SCOPED: focusing opens an undo transaction and
 * blur commits it, so every edit made while the field is focused — the typed
 * value plus any arrow/wheel steps, at any pace — collapses into ONE undo frame.
 * Because the commit pipeline records the frame synchronously (before its first
 * await), blur can close the transaction synchronously with no race, and each
 * field is isolated: clicking W→H fires W's blur (which commits W's frame) before
 * H's focus opens a new one, so they never merge.
 *
 * Parsing, clamping and rounding live in `numeric-field-logic.ts`; this file is
 * the thin React shell. `onCommit` receives a clean, in-range, rounded number.
 */

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { beginHistoryTransaction, commitHistoryTransaction } from '@/lib/history/history-store'
import { clampRound, formatNumber, parseNumericInput, stepValue } from './numeric-field-logic'

let nextInteractionId = 0

export interface NumericFieldProps {
  /** Committed value, or 'mixed' for a multi-selection with differing values. */
  value: number | 'mixed'
  /** Called with the parsed, clamped, rounded number when the user commits. */
  onCommit: (n: number) => void
  min?: number
  max?: number
  step?: number
  precision?: number
  prefix?: string
  suffix?: string
  disabled?: boolean
  id?: string
  className?: string
  placeholder?: string
  title?: string
  'aria-label'?: string
}

export function NumericField({
  value,
  onCommit,
  min,
  max,
  step = 1,
  precision = 2,
  prefix,
  suffix,
  disabled,
  id,
  className,
  placeholder,
  title,
  'aria-label': ariaLabel,
}: NumericFieldProps) {
  const bounds = { min, max, precision }
  const inputRef = useRef<HTMLInputElement>(null)
  const focusedRef = useRef(false)
  // Tracks the last value we pushed so dedup survives async prop lag during a
  // step burst (the `value` prop updates a tick after onCommit).
  const lastCommittedRef = useRef<number | null>(null)
  const [draft, setDraft] = useState<string | null>(null)

  // Stable per-instance id for the focus-scoped undo transaction.
  const txIdRef = useRef<string>()
  if (txIdRef.current === undefined) {
    txIdRef.current = `numfield-${nextInteractionId++}`
  }

  // draft === null → show the committed prop; otherwise show the in-progress text.
  const display = draft ?? (value === 'mixed' ? '' : formatNumber(value, precision))

  // External value change while not actively editing → snap to it and reset dedup.
  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(null)
      lastCommittedRef.current = null
    }
  }, [value])

  // The undo transaction is opened on focus, so commits just route into it — no
  // per-commit marking. Dedup skips redundant writes (survives async prop lag).
  const commit = (next: number) => {
    const current =
      lastCommittedRef.current ?? (value === 'mixed' ? null : clampRound(value, bounds))
    if (next === current) return
    lastCommittedRef.current = next
    onCommit(next)
  }

  const commitDraft = () => {
    if (draft === null) return
    const parsed = parseNumericInput(draft)
    if (parsed === null) {
      setDraft(null) // unparseable → revert to committed display
      return
    }
    const next = clampRound(parsed, bounds)
    setDraft(formatNumber(next, precision)) // normalize display, no flash to old prop
    commit(next)
  }

  const applyStep = (direction: 1 | -1, mods: { shift?: boolean; alt?: boolean }) => {
    const base = parseNumericInput(draft ?? '') ?? (value === 'mixed' ? 0 : value)
    const next = clampRound(stepValue(base, step, direction, mods), bounds)
    setDraft(formatNumber(next, precision)) // live display while focused
    commit(next)
  }

  // Native non-passive wheel listener so preventDefault works; steps only while
  // focused, so scrolling the panel over an unfocused field scrolls normally.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {})
  wheelRef.current = (e: WheelEvent) => {
    if (disabled || document.activeElement !== inputRef.current) return
    e.preventDefault()
    applyStep(e.deltaY < 0 ? 1 : -1, { shift: e.shiftKey, alt: e.altKey })
  }
  useEffect(() => {
    const node = inputRef.current
    if (!node) return
    const onWheel = (e: WheelEvent) => wheelRef.current(e)
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  // Selection changes can unmount a focused field without firing blur; commit
  // the open transaction on unmount so the frame lands and it doesn't leak open.
  useEffect(() => {
    const txId = txIdRef.current!
    return () => {
      if (focusedRef.current) commitHistoryTransaction(txId)
    }
  }, [])

  const inputEl = (
    <Input
      ref={inputRef}
      id={id}
      type="text"
      inputMode="decimal"
      title={title}
      aria-label={ariaLabel}
      placeholder={value === 'mixed' ? (placeholder ?? 'Mixed') : placeholder}
      value={display}
      disabled={disabled}
      className={cn(prefix && 'pl-7', suffix && 'pr-8', className)}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        focusedRef.current = true
        // Open the undo transaction for this focus session; every edit until
        // blur lands in one frame.
        beginHistoryTransaction(txIdRef.current!)
        e.currentTarget.select()
      }}
      onBlur={() => {
        focusedRef.current = false
        commitDraft()
        // Close the transaction synchronously — the frame is already recorded
        // (commit pipeline records before its await), so there's no race and
        // the next field's focus can't merge into this one.
        commitHistoryTransaction(txIdRef.current!)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commitDraft()
          inputRef.current?.select()
        } else if (e.key === 'Escape') {
          setDraft(null)
          inputRef.current?.blur()
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          applyStep(1, { shift: e.shiftKey, alt: e.altKey })
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          applyStep(-1, { shift: e.shiftKey, alt: e.altKey })
        }
      }}
    />
  )

  if (!prefix && !suffix) return inputEl

  return (
    <div className="relative">
      {prefix && (
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[12px] font-medium text-muted-foreground">
          {prefix}
        </span>
      )}
      {inputEl}
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  )
}
