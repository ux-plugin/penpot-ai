/**
 * Build-mode Data panel — the stores the designer creates.
 *
 * A store is a named, document-wide container the designer makes the same way
 * they make a component: it holds the values the real app will supply, filled
 * with sample data the preview runs on. This is the answer to "where does
 * outside data live": not a checkbox on each value, but a thing you built for it.
 *
 * A cell in a store is still just a cell — an interaction reads or writes it by
 * name, exactly like a component's own state. What a write has to DO to reach the
 * real backend is derived at lowering (a prop, a callback, a mutation), never
 * authored here. So this panel only ever edits data: names, types, samples, and a
 * sentence saying what each store maps to.
 *
 * The store list lives on the document (`docProxy.meta.stores`); the cells a
 * store holds live on the page that uses them, like every other cell.
 */

import { useMemo, useState } from 'react'
import { useSnapshot } from 'valtio'
import { cn } from '@/lib/utils'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import type { IndexedPage } from '../../worker/types'
import {
  emptyPageInteractions,
  cellRef,
  type PageInteractions,
  type Cell,
  type Store,
  type ValueType,
  type Json,
} from '../../renderer/interactions/ir'
import {
  addStore,
  removeStore,
  setStoreDescription,
  addStoreField,
  detachStore,
  removeCell,
  setCellType,
  setCellValue,
  setCellDescription,
  toCellId,
  isNameTaken,
} from '../../renderer/interactions/document/edit-interactions'
import {
  commitInteractions,
  currentInteractions,
  commitStores,
  currentStores,
} from '../../renderer/interactions/document/commit-interactions'

type Commit = (next: PageInteractions) => void
type LiveIR = () => PageInteractions

const fieldCls =
  'h-6 min-w-0 rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-ring'
const typeCls =
  'h-6 shrink-0 rounded border border-border bg-background px-1 text-[10px] text-muted-foreground outline-none focus:border-ring'

const TYPE_KEYS = ['text', 'number', 'boolean', 'list'] as const
function typeKey(t: ValueType): string {
  if (typeof t === 'object') return 'list'
  return t === 'string' ? 'text' : t
}
function typeFromKey(k: string): ValueType {
  switch (k) {
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'list':
      return { collection: 'object' }
    default:
      return 'string'
  }
}

/** The sample a store cell runs on — the value the preview shows in place of real data. */
function SampleEditor({ c, commit, liveIR }: { c: Cell; commit: Commit; liveIR: LiveIR }) {
  const ref = cellRef(c)
  const set = (value: Json) => commit(setCellValue(liveIR(), ref, value))
  if (typeof c.type === 'object') {
    const n = Array.isArray(c.initial) ? c.initial.length : 0
    return <span className="shrink-0 text-[10px] text-muted-foreground">{n} rows</span>
  }
  if (c.type === 'boolean') {
    return <input type="checkbox" checked={c.initial === true} onChange={(e) => set(e.target.checked)} aria-label={`${ref} sample`} />
  }
  if (c.type === 'number') {
    return (
      <input
        type="number"
        key={`${ref}-${String(c.initial)}`}
        className={cn(fieldCls, 'w-16')}
        defaultValue={typeof c.initial === 'number' ? c.initial : 0}
        onBlur={(e) => set(e.target.value === '' ? 0 : Number(e.target.value))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label={`${ref} sample`}
      />
    )
  }
  return (
    <input
      key={`${ref}-${String(c.initial)}`}
      className={cn(fieldCls, 'w-24')}
      defaultValue={c.initial == null ? '' : String(c.initial)}
      placeholder="example"
      onBlur={(e) => set(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      aria-label={`${ref} sample`}
    />
  )
}

function FieldRow({ c, commit, liveIR }: { c: Cell; commit: Commit; liveIR: LiveIR }) {
  const ref = cellRef(c)
  const cur = typeKey(c.type)
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={ref}>
          {ref}
        </span>
        <select
          className={typeCls}
          value={cur}
          onChange={(e) => commit(setCellType(liveIR(), ref, typeFromKey(e.target.value)))}
          aria-label={`${ref} type`}
        >
          {TYPE_KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <SampleEditor c={c} commit={commit} liveIR={liveIR} />
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${ref}`}
          onClick={() => commit(removeCell(liveIR(), ref))}
        >
          ✕
        </button>
      </div>
      {/* What real value this field is, for whoever binds the store at handover. */}
      <input
        key={`${ref}-desc`}
        className={cn(fieldCls, 'font-sans')}
        defaultValue={c.description ?? ''}
        placeholder="what is this? e.g. the product title"
        onBlur={(e) => commit(setCellDescription(liveIR(), ref, e.target.value))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label={`${ref} description`}
      />
    </div>
  )
}

function StoreCard({
  store,
  fields,
  commit,
  liveIR,
  onRemove,
  onDescribe,
}: {
  store: Store
  fields: readonly Cell[]
  commit: Commit
  liveIR: LiveIR
  onRemove: () => void
  onDescribe: (text: string) => void
}) {
  const { id } = store
  const [newField, setNewField] = useState('')
  const fid = toCellId(newField)
  const free = !!fid && !isNameTaken(liveIR(), fid, currentStores())
  const addField = () => {
    if (!free) return
    commit(addStoreField(liveIR(), currentStores(), id, fid, 'string'))
    setNewField('')
  }
  return (
    <div className="rounded-lg border border-border p-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={id}>
          {id}
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${id} store`}
          title="Remove store — its values become local, keeping their wiring"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
      <input
        key={`${id}-desc`}
        className={cn(fieldCls, 'mt-1.5 w-full font-sans')}
        defaultValue={store.description ?? ''}
        placeholder="what real data does this map to? e.g. the products table"
        onBlur={(e) => onDescribe(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label={`${id} store description`}
      />

      <div className="mt-1.5 flex flex-col gap-1">
        {fields.length === 0 && <p className="text-[10px] text-muted-foreground/70">No values yet.</p>}
        {fields.map((c) => (
          <FieldRow key={cellRef(c)} c={c} commit={commit} liveIR={liveIR} />
        ))}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          className={cn(fieldCls, 'flex-1')}
          placeholder="new value name"
          value={newField}
          onChange={(e) => setNewField(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addField()}
          aria-label={`New value in ${id}`}
        />
        <button
          type="button"
          className="h-6 shrink-0 rounded border border-border px-2 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          disabled={!free}
          onClick={addField}
        >
          + Value
        </button>
      </div>
    </div>
  )
}

export function StoresPanel() {
  const doc = useSnapshot(docProxy)
  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const ir = (pid ? doc.pageMap.get(pid)?.interactions : undefined) ?? emptyPageInteractions()
  const stores = doc.meta?.stores ?? []

  const liveIR: LiveIR = () => (pid ? currentInteractions(pid) : undefined) ?? emptyPageInteractions()
  const commit: Commit = (next) => {
    if (pid) void commitInteractions(pid, next)
  }

  const fieldsByStore = useMemo(() => {
    const m = new Map<string, Cell[]>()
    for (const c of ir.cells as Cell[]) {
      if (!c.store) continue
      const list = m.get(c.store)
      if (list) list.push(c)
      else m.set(c.store, [c])
    }
    return m
  }, [ir.cells])

  const [newStore, setNewStore] = useState('')
  const sid = toCellId(newStore)
  const free = !!sid && !isNameTaken(ir, sid, stores)
  const create = () => {
    if (!free) return
    void commitStores(addStore(currentStores(), sid))
    setNewStore('')
  }

  // Deleting the container releases its cells on EVERY page — they stay, as
  // design-owned values, so nothing wired to them breaks.
  const remove = (id: string) => {
    const pages: { pageId: string; next: PageInteractions }[] = []
    for (const [pageId, page] of docProxy.pageMap as Map<string, IndexedPage>) {
      if (page.interactions?.cells.some((c) => c.store === id)) pages.push({ pageId, next: detachStore(page.interactions, id) })
    }
    void commitStores(removeStore(currentStores(), id), pages)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
        <span className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">Data</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {stores.length === 0 && (
          <p className="px-1 py-1 text-[11px] text-muted-foreground/70">
            A store holds the values the real app supplies — a table, a list, a record. Create one, fill it with sample
            data, and interactions can read or change it by name.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {stores.map((s) => (
            <StoreCard
              key={s.id}
              store={s as Store}
              fields={fieldsByStore.get(s.id) ?? []}
              commit={commit}
              liveIR={liveIR}
              onRemove={() => remove(s.id)}
              onDescribe={(text) => void commitStores(setStoreDescription(currentStores(), s.id, text))}
            />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <input
            className={cn(fieldCls, 'flex-1')}
            placeholder="new store name"
            value={newStore}
            onChange={(e) => setNewStore(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            aria-label="New store name"
          />
          <button
            type="button"
            className="h-6 shrink-0 rounded border border-border px-2 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={!free}
            onClick={create}
          >
            + Store
          </button>
        </div>
      </div>
    </div>
  )
}
