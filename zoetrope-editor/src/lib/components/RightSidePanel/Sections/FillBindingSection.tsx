/**
 * Fill ← state: wire a node's fill to a state value, alongside (not replacing) the
 * literal FillsSection. The literal fill stays the static design value; the wired
 * value drives the Build preview. Authors the single `(node, 'background'|'color')`
 * binding in the page interactions IR — the same IR the Interactions tab edits.
 */

import { useSnapshot } from 'valtio'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { RectLikeNode } from '@/lib/renderer/properties/panel-utils'
import { docProxy, getActiveOrSinglePageId } from '@/lib/renderer/store/doc-proxy'
import { emptyPageInteractions, type PageInteractions } from '@/lib/renderer/interactions/ir'
import { parse } from '@/lib/renderer/interactions/expression'
import { getBinding, setBindingExpr, removeBindingProp } from '@/lib/renderer/interactions/document/edit-interactions'
import { commitInteractions, currentInteractions } from '@/lib/renderer/interactions/document/commit-interactions'
import { isTextNode } from './text-typography'

function exprError(src?: string): string | null {
  if (!src || !src.trim()) return null
  try {
    parse(src)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid expression'
  }
}

export interface FillBindingSectionProps {
  nodeId: string
  initialNode: RectLikeNode
  readOnly: boolean
}

export function FillBindingSection({ nodeId, initialNode, readOnly }: FillBindingSectionProps) {
  const doc = useSnapshot(docProxy)
  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const ir: PageInteractions = (pid ? doc.pageMap.get(pid)?.interactions : undefined) ?? emptyPageInteractions()

  // A text node's fill is its `color`; everything else is `background`.
  const fillProp = isTextNode(initialNode as { type?: string }) ? 'color' : 'background'
  const binding = getBinding(ir, nodeId, fillProp)
  const on = Boolean(binding)
  const err = exprError(binding?.from)
  const options = [...ir.variables.map((v) => v.id), ...ir.derived.map((d) => d.id)]

  const liveIR = () => (pid ? currentInteractions(pid) : undefined) ?? emptyPageInteractions()
  const commit = (next: PageInteractions) => {
    if (pid) void commitInteractions(pid, next)
  }
  const toggle = () => {
    if (on) commit(removeBindingProp(liveIR(), nodeId, fillProp))
    else commit(setBindingExpr(liveIR(), nodeId, fillProp, options[0] ?? ''))
  }

  if (readOnly) return null

  return (
    <>
      <Separator />
      <div className="space-y-1">
        <label className="flex min-h-8 items-center gap-2 py-0.5 text-xs">
          <input
            type="checkbox"
            checked={on}
            disabled={!on && options.length === 0}
            onChange={toggle}
            aria-label="Wire fill to a state value"
          />
          <span className="font-medium tracking-wide text-muted-foreground uppercase">Fill from state</span>
        </label>

        {!on && options.length === 0 && (
          <p className="pl-0.5 text-[11px] text-muted-foreground/70">Add a value in the Interactions tab’s State section first.</p>
        )}

        {on && (
          <div className="space-y-1 pl-0.5">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fillProp} =</span>
              <input
                key={`${nodeId}-fillbind-${binding?.from ?? ''}`}
                className={cn(
                  'h-7 w-full min-w-0 rounded border border-border bg-background px-2 font-mono text-[11px] outline-none focus:border-ring',
                  err && 'border-destructive',
                )}
                defaultValue={binding?.from ?? ''}
                placeholder="state value, e.g. accent"
                onBlur={(e) => commit(setBindingExpr(liveIR(), nodeId, fillProp, e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                aria-label="Fill expression"
              />
            </div>

            {options.length > 0 && (
              <select
                className="h-7 rounded border border-border bg-background px-1 text-[11px] text-muted-foreground outline-none focus:border-ring"
                value=""
                onChange={(e) => {
                  if (e.target.value) commit(setBindingExpr(liveIR(), nodeId, fillProp, e.target.value))
                }}
                aria-label="Pick a state value"
              >
                <option value="">pick a state value…</option>
                {options.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}

            {err && <p className="text-[10px] text-destructive">{err}</p>}
            <p className="text-[10px] text-muted-foreground">The static fill is the design value; the wired value drives the preview.</p>
          </div>
        )}
      </div>
    </>
  )
}
