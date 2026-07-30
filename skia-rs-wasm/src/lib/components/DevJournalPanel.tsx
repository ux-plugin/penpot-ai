/**
 * Dev-only inspector for the undo journal. Toggle with Shift+J.
 *
 * Exists because the journal's behaviour is not guessable from the outside:
 * whether a press does anything depends on the ACTIVE LENS (derived from the
 * open focus scope), on liveness (derived, not stored), and on chain-depth
 * parity. When Cmd+Z appears to do nothing, the useful question is "what would
 * the current lens pick?" — so this shows exactly that, alongside the entries
 * grouped by the scope that wrote them.
 *
 * Stripped from production: the whole component is behind `import.meta.env.DEV`
 * at its mount site in App.tsx.
 */

import { useEffect, useState } from 'react'
import { useJournalStore, CANVAS_SCOPE, type ScopeTag, type Txn } from '../history/journal/journal-store'
import { canvasLens, chainDepth, liveness, localCtx, pickRedo, pickUndo, scopeLens } from '../history/journal/lens'

/** Rows are grouped by the scope that wrote them, newest scope last. */
function groupByScope(txns: readonly Txn[]): Array<{ scope: ScopeTag; rows: Txn[] }> {
  const out: Array<{ scope: ScopeTag; rows: Txn[] }> = []
  for (const t of txns) {
    const last = out[out.length - 1]
    if (last && last.scope === t.scope) last.rows.push(t)
    else out.push({ scope: t.scope, rows: [t] })
  }
  return out
}

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }

export function DevJournalPanel() {
  const [open, setOpen] = useState(false)
  const txns = useJournalStore((s) => s.txns)
  const pending = useJournalStore((s) => s.pending)
  const scopes = useJournalStore((s) => s.scopes)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.shiftKey && (e.key === 'J' || e.key === 'j') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!open) return null

  // The lens the next Cmd+Z will actually use — the same resolution page-crud
  // does, so what this shows is what will happen, not an approximation.
  // From the subscribed `scopes` rather than a getState() read, so the panel
  // re-renders the moment a stage opens or closes.
  const frame = scopes[scopes.length - 1]
  const tag = frame?.tag
  const lens = frame === undefined ? canvasLens : scopeLens(frame.tag, frame.fromSeq)
  const ctx = localCtx()
  const undoTarget = pickUndo(txns, lens, ctx)
  const redoTarget = pickRedo(txns, lens, ctx)
  const live = liveness(txns)
  const groups = groupByScope(txns)

  return (
    <div
      style={{
        ...mono,
        position: 'absolute',
        top: 8,
        right: 8,
        width: 340,
        maxHeight: '70vh',
        overflow: 'auto',
        background: 'rgba(255,255,255,0.97)',
        border: '1px solid #d4d4d8',
        borderRadius: 8,
        padding: 10,
        zIndex: 9999,
        pointerEvents: 'auto',
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>journal · {txns.length} entries</strong>
        <button type="button" onClick={() => setOpen(false)} style={{ ...mono, cursor: 'pointer' }}>
          ✕
        </button>
      </div>

      <div style={{ marginBottom: 8, lineHeight: 1.6 }}>
        <div>
          lens: <b>{lens.id}</b> {tag === undefined ? '(canvas)' : '(focus scope)'}
        </div>
        <div>
          undo → {undoTarget ? `#${undoTarget.seq}` : <span style={{ color: '#a1a1aa' }}>nothing</span>}
          {'   '}
          redo → {redoTarget ? `#${redoTarget.seq}` : <span style={{ color: '#a1a1aa' }}>nothing</span>}
        </div>
        {scopes.length > 0 && (
          <div style={{ color: '#71717a' }}>
            open scopes: {scopes.map((s) => `${s.tag}@${s.fromSeq}`).join(' › ')}
          </div>
        )}
        {pending && <div style={{ color: '#b45309' }}>pending gesture: {pending.ops.length} ops</div>}
      </div>

      {groups.length === 0 && <div style={{ color: '#a1a1aa' }}>empty</div>}

      {groups.map((g) => (
        <div key={`${g.scope}-${g.rows[0].seq}`} style={{ marginBottom: 8 }}>
          <div
            style={{
              color: g.scope === CANVAS_SCOPE ? '#3f3f46' : '#6d28d9',
              borderBottom: '1px solid #e4e4e7',
              marginBottom: 2,
            }}
          >
            {g.scope}
            {g.scope !== CANVAS_SCOPE && tag === g.scope ? ' ← active' : ''}
          </div>
          {[...g.rows].reverse().map((t) => {
            const isLive = live.get(t.seq) === true
            const depth = chainDepth(txns, t)
            const isUndo = undoTarget?.seq === t.seq
            const isRedo = redoTarget?.seq === t.seq
            return (
              <div
                key={t.seq}
                style={{
                  display: 'flex',
                  gap: 6,
                  padding: '1px 3px',
                  borderRadius: 3,
                  opacity: isLive ? 1 : 0.4,
                  background: isUndo ? '#dbeafe' : isRedo ? '#dcfce7' : undefined,
                }}
                title={isLive ? 'live' : 'reverted by a live entry'}
              >
                <span style={{ width: 30 }}>#{t.seq}</span>
                <span style={{ width: 60, color: '#71717a' }}>
                  {t.undoes !== undefined ? `↩${t.undoes}` : t.collapses ? 'collapse' : 'edit'}
                </span>
                <span style={{ width: 34, color: '#71717a' }}>d{depth}</span>
                <span style={{ width: 44, color: '#71717a' }}>{t.ops.length} ops</span>
                <span>{isUndo ? '⟵ undo' : isRedo ? '⟶ redo' : ''}</span>
              </div>
            )
          })}
        </div>
      ))}

      <div style={{ marginTop: 8, color: '#71717a', lineHeight: 1.5 }}>
        dim = reverted · d = chain depth (even asserts, odd retracts) · ↩n = undoes n
      </div>
    </div>
  )
}
