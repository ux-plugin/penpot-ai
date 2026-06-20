/**
 * Inspector → Interactions tab. Shared by both modes.
 *
 * Authors per-node interactions against the page's PageInteractions IR using the
 * pure reducers in edit-interactions, committing each change via
 * commitInteractions (so the live preview reacts immediately). Trigger/action
 * menus are sourced from the catalog registry — they grow as the catalog does.
 */

import { useMemo, useState } from 'react'
import { useSnapshot } from 'valtio'
import { cn } from '@/lib/utils'
import type { IndexedShape } from '../../worker/types'
import { docProxy, getActiveOrSinglePageId } from '../../renderer/store/doc-proxy'
import {
  emptyPageInteractions,
  type PageInteractions,
  type Interaction,
  type Action,
  type Variable,
  type ValueType,
  type Binding,
  type Derived,
  type Json,
} from '../../renderer/interactions/ir'
import { listTriggers, listActions, getAction } from '../../renderer/interactions/catalog'
import { parse } from '../../renderer/interactions/expression'
import {
  addInteraction,
  removeInteraction,
  setTrigger,
  setCondition,
  addAction,
  removeAction,
  setActionType,
  setActionTarget,
  setActionValue,
  addVariable,
  removeVariable,
  makeCollectionVariable,
  makeScalarVariable,
  toVariableId,
  setVariableValue,
  setVariableType,
  setRepeater,
  clearRepeater,
  addBinding,
  setBindingProp,
  setBindingFrom,
  removeBinding,
  addDerived,
  setDerivedExpr,
  removeDerived,
} from '../../renderer/interactions/document/edit-interactions'
import { commitInteractions, currentInteractions } from '../../renderer/interactions/document/commit-interactions'

const ROOT_UUID = '00000000-0000-0000-0000-000000000000'

type Commit = (next: PageInteractions) => void
type LiveIR = () => PageInteractions

function isCollection(t: ValueType): boolean {
  return typeof t === 'object' && t !== null && 'collection' in t
}

function exprError(src?: string): string | null {
  if (!src || !src.trim()) return null
  try {
    parse(src)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid expression'
  }
}

const selectCls =
  'h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground outline-none focus:border-ring'
const inputCls =
  'h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-ring'
const sectionHeadCls = 'mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground'

/** Props a binding can drive (the runtime maps `text`/`children` to the text child). */
const COMMON_PROPS = ['text', 'visible', 'disabled', 'value', 'opacity']

function ActionRow({
  it,
  index,
  variables,
  nodes,
  commit,
  liveIR,
}: {
  it: Interaction
  index: number
  variables: readonly Variable[]
  nodes: readonly IndexedShape[]
  commit: Commit
  liveIR: LiveIR
}) {
  const action: Action = it.do[index]
  const entry = getAction(action.type)
  const expectsTarget = entry?.expects.target ?? 'none'
  const expectsValue = entry?.expects.value ?? false
  const id = it.id as string
  const err = exprError(action.value)

  const collections = variables.filter((v) => isCollection(v.type))
  const targetVars = expectsTarget === 'collection' ? collections : variables

  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="flex items-center gap-1.5">
        <select
          className={selectCls}
          value={action.type}
          onChange={(e) => commit(setActionType(liveIR(), id, index, e.target.value))}
          aria-label="Action"
        >
          {listActions().map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </select>

        {(expectsTarget === 'variable' || expectsTarget === 'collection') && (
          <select
            className={selectCls}
            value={action.target ?? ''}
            onChange={(e) => commit(setActionTarget(liveIR(), id, index, e.target.value))}
            aria-label="Target variable"
          >
            <option value="">{targetVars.length ? 'choose…' : 'add state below'}</option>
            {targetVars.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
        )}

        {expectsTarget === 'node.state' && (
          <select
            className={selectCls}
            value={action.target ?? ''}
            onChange={(e) => commit(setActionTarget(liveIR(), id, index, e.target.value))}
            aria-label="Target node"
          >
            <option value="">choose…</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name ?? n.id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}

        {(expectsTarget === 'screen' || expectsTarget === 'overlay') && (
          <span className="text-[11px] text-muted-foreground">needs another page</span>
        )}

        <button
          type="button"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
          aria-label="Remove action"
          title="Remove action"
          onClick={() => commit(removeAction(liveIR(), id, index))}
        >
          ✕
        </button>
      </div>

      {expectsValue && (
        <div className="mt-1.5">
          <input
            key={`${id}-${index}-${action.type}`}
            className={cn(inputCls, err && 'border-destructive')}
            defaultValue={action.value ?? ''}
            placeholder='value, e.g. { label: "Item " + (items.length + 1) }'
            onBlur={(e) => commit(setActionValue(liveIR(), id, index, e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            aria-label="Action value"
          />
          {err && <p className="mt-0.5 text-[10px] text-destructive">{err}</p>}
        </div>
      )}
    </div>
  )
}

function InteractionCard({
  it,
  triggers,
  variables,
  nodes,
  commit,
  liveIR,
}: {
  it: Interaction
  triggers: ReturnType<typeof listTriggers>
  variables: readonly Variable[]
  nodes: readonly IndexedShape[]
  commit: Commit
  liveIR: LiveIR
}) {
  const id = it.id as string
  const condErr = exprError(it.if)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">When</span>
        <select
          className={selectCls}
          value={it.on.trigger.type}
          onChange={(e) => commit(setTrigger(liveIR(), id, e.target.value))}
          aria-label="Trigger"
        >
          {triggers.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
          aria-label="Remove interaction"
          title="Remove interaction"
          onClick={() => commit(removeInteraction(liveIR(), id))}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-muted-foreground">Do</span>
        {it.do.length === 0 && <p className="text-[11px] text-muted-foreground/70">No actions yet.</p>}
        {it.do.map((_, i) => (
          <ActionRow key={i} it={it} index={i} variables={variables} nodes={nodes} commit={commit} liveIR={liveIR} />
        ))}
        <button
          type="button"
          className="self-start text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => commit(addAction(liveIR(), id))}
        >
          + Add action
        </button>
      </div>

      <div className="flex flex-col gap-1 border-t border-border/70 pt-2">
        <span className="text-[11px] text-muted-foreground">Only if (optional)</span>
        <input
          key={`${id}-cond`}
          className={cn(inputCls, condErr && 'border-destructive')}
          defaultValue={it.if ?? ''}
          placeholder="e.g. items.length < 10"
          onBlur={(e) => commit(setCondition(liveIR(), id, e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          aria-label="Condition"
        />
        {condErr && <p className="text-[10px] text-destructive">{condErr}</p>}
      </div>
    </div>
  )
}

function RepeatSection({
  nodeId,
  ir,
  collections,
  commit,
  liveIR,
}: {
  nodeId: string
  ir: PageInteractions
  collections: readonly Variable[]
  commit: Commit
  liveIR: LiveIR
}) {
  const rep = ir.repeaters.find((r) => r.node === nodeId)
  const on = Boolean(rep)
  const hasCollections = collections.length > 0
  const over = rep?.over ?? ''
  const overMissing = on && over !== '' && !collections.some((v) => v.id === over)
  const keyErr = exprError(rep?.key)

  const toggle = () => {
    if (on) commit(clearRepeater(liveIR(), nodeId))
    else if (hasCollections) commit(setRepeater(liveIR(), nodeId, { over: collections[0].id, as: 'item' }))
  }

  return (
    <section className="border-b border-border p-3">
      <h3 className={sectionHeadCls}>Repeat</h3>
      <label className="flex items-center gap-2 text-xs text-foreground">
        <input type="checkbox" checked={on} disabled={!on && !hasCollections} onChange={toggle} aria-label="Repeat over a list" />
        <span>Repeat this over a list</span>
      </label>
      {!hasCollections && !on && <p className="mt-1.5 text-[11px] text-muted-foreground/70">Add a list in State first.</p>}
      {on && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>over</span>
            <select
              className={selectCls}
              value={over}
              onChange={(e) => commit(setRepeater(liveIR(), nodeId, { over: e.target.value }))}
              aria-label="Repeat over list"
            >
              <option value="">choose…</option>
              {collections.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                </option>
              ))}
            </select>
            <span>as</span>
            <input
              key={`${nodeId}-as-${rep?.as ?? ''}`}
              className="h-7 w-20 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-ring"
              defaultValue={rep?.as ?? 'item'}
              onBlur={(e) => commit(setRepeater(liveIR(), nodeId, { as: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              aria-label="Item name"
            />
          </div>
          {overMissing && (
            <p className="text-[10px] text-destructive">List “{over}” was removed — pick another.</p>
          )}
          <input
            key={`${nodeId}-key-${rep?.key ?? ''}`}
            className={cn(inputCls, keyErr && 'border-destructive')}
            defaultValue={rep?.key ?? ''}
            placeholder="key (optional), e.g. item.id"
            onBlur={(e) => commit(setRepeater(liveIR(), nodeId, { key: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            aria-label="Item key expression"
          />
          {keyErr && <p className="text-[10px] text-destructive">{keyErr}</p>}
        </div>
      )}
    </section>
  )
}

function BindRow({
  nodeId,
  occ,
  binding,
  commit,
  liveIR,
}: {
  nodeId: string
  occ: number
  binding: Binding
  commit: Commit
  liveIR: LiveIR
}) {
  const err = exprError(binding.from)
  const props = COMMON_PROPS.includes(binding.prop) ? COMMON_PROPS : [binding.prop, ...COMMON_PROPS]
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="flex items-center gap-1.5">
        <select
          className={selectCls}
          value={binding.prop}
          onChange={(e) => commit(setBindingProp(liveIR(), nodeId, occ, e.target.value))}
          aria-label="Bound prop"
        >
          {props.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted-foreground">←</span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
          aria-label="Remove binding"
          title="Remove binding"
          onClick={() => commit(removeBinding(liveIR(), nodeId, occ))}
        >
          ✕
        </button>
      </div>
      <div className="mt-1.5">
        <input
          key={`${nodeId}-${occ}-${binding.prop}-from`}
          className={cn(inputCls, err && 'border-destructive')}
          defaultValue={binding.from}
          placeholder="expression, e.g. item.label"
          onBlur={(e) => commit(setBindingFrom(liveIR(), nodeId, occ, e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          aria-label="Binding expression"
        />
        {err && <p className="mt-0.5 text-[10px] text-destructive">{err}</p>}
      </div>
    </div>
  )
}

function BindSection({
  nodeId,
  ir,
  commit,
  liveIR,
}: {
  nodeId: string
  ir: PageInteractions
  commit: Commit
  liveIR: LiveIR
}) {
  const bindings = ir.bindings.filter((b) => b.node === nodeId)
  return (
    <section className="border-b border-border p-3">
      <h3 className={sectionHeadCls}>Bind</h3>
      {bindings.length === 0 && <p className="mb-1.5 text-[11px] text-muted-foreground/70">No bindings yet.</p>}
      <div className="mb-2 flex flex-col gap-1.5">
        {bindings.map((b, i) => (
          <BindRow key={i} nodeId={nodeId} occ={i} binding={b} commit={commit} liveIR={liveIR} />
        ))}
      </div>
      <button
        type="button"
        className="self-start text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => commit(addBinding(liveIR(), nodeId, 'text', ''))}
      >
        + Add binding
      </button>
    </section>
  )
}

const varInputCls =
  'h-6 w-full min-w-0 rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-ring'
const typeSelectCls =
  'h-6 shrink-0 rounded border border-border bg-background px-1 text-[10px] text-muted-foreground outline-none focus:border-ring'

/** Map a ValueType to a short dropdown key, and back. */
function typeKey(t: ValueType): string {
  if (typeof t === 'object') return 'list'
  return t === 'string' ? 'text' : t
}
function typeFromKey(k: string): ValueType {
  switch (k) {
    case 'text':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'list':
      return { collection: 'object' }
    default:
      return 'any'
  }
}
const TYPE_KEYS = ['text', 'number', 'boolean', 'list']

/** The value editor for a variable's initial value, by type. */
function VariableValueEditor({ v, commit, liveIR }: { v: Variable; commit: Commit; liveIR: LiveIR }) {
  const t = v.type
  const set = (value: Json) => commit(setVariableValue(liveIR(), v.id, value))

  if (typeof t === 'object') {
    const n = Array.isArray(v.initial) ? v.initial.length : 0
    return <span className="text-[10px] text-muted-foreground">starts empty · {n}</span>
  }
  if (t === 'boolean') {
    return (
      <input type="checkbox" checked={v.initial === true} onChange={(e) => set(e.target.checked)} aria-label={`${v.id} value`} />
    )
  }
  if (t === 'number') {
    return (
      <input
        type="number"
        key={`${v.id}-num-${String(v.initial)}`}
        className={varInputCls}
        defaultValue={typeof v.initial === 'number' ? v.initial : 0}
        onBlur={(e) => set(e.target.value === '' ? 0 : Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        aria-label={`${v.id} value`}
      />
    )
  }
  // string / any
  return (
    <input
      key={`${v.id}-str-${String(v.initial)}`}
      className={varInputCls}
      defaultValue={v.initial == null ? '' : String(v.initial)}
      placeholder="value"
      onBlur={(e) => set(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      aria-label={`${v.id} value`}
    />
  )
}

function VariableRow({ v, commit, liveIR }: { v: Variable; commit: Commit; liveIR: LiveIR }) {
  const cur = typeKey(v.type)
  const keys = TYPE_KEYS.includes(cur) ? TYPE_KEYS : [cur, ...TYPE_KEYS]
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 truncate font-mono text-xs text-foreground" title={v.id}>
        {v.id}
      </span>
      <select
        className={typeSelectCls}
        value={cur}
        onChange={(e) => commit(setVariableType(liveIR(), v.id, typeFromKey(e.target.value)))}
        aria-label={`${v.id} type`}
      >
        {keys.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <div className="flex min-w-0 flex-1 justify-end">
        <VariableValueEditor v={v} commit={commit} liveIR={liveIR} />
      </div>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${v.id}`}
        onClick={() => commit(removeVariable(liveIR(), v.id))}
      >
        ✕
      </button>
    </div>
  )
}

function DerivedRow({ d, commit, liveIR }: { d: Derived; commit: Commit; liveIR: LiveIR }) {
  const err = exprError(d.expr)
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs text-foreground">{d.id}</span>
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground" title="derived — read-only formula">
          ƒ
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${d.id}`}
          onClick={() => commit(removeDerived(liveIR(), d.id))}
        >
          ✕
        </button>
      </div>
      <input
        key={`${d.id}-expr`}
        className={cn(inputCls, 'mt-1.5', err && 'border-destructive')}
        defaultValue={d.expr}
        placeholder="formula, e.g. items.length == 0"
        onBlur={(e) => commit(setDerivedExpr(liveIR(), d.id, e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        aria-label={`${d.id} formula`}
      />
      {err && <p className="mt-0.5 text-[10px] text-destructive">{err}</p>}
    </div>
  )
}

export function InteractionsTab() {
  const doc = useSnapshot(docProxy)
  const pid = doc.currentPageId ?? getActiveOrSinglePageId()
  const page = pid ? doc.pageMap.get(pid) : undefined
  const selectedIds = useMemo(() => new Set(doc.selectedIds), [doc.selectedIds])
  const singleId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null

  const ir = page?.interactions ?? emptyPageInteractions()
  const variables = ir.variables
  const collections = variables.filter((v) => isCollection(v.type))
  const triggers = useMemo(() => listTriggers().filter((t) => t.scope === 'node'), [])
  const nodes: IndexedShape[] = page
    ? (Object.values(page.objects) as IndexedShape[]).filter((o) => o.id !== ROOT_UUID)
    : []

  const liveIR: LiveIR = () => (pid ? currentInteractions(pid) : undefined) ?? emptyPageInteractions()
  const commit: Commit = (next) => {
    if (pid) void commitInteractions(pid, next)
  }

  const derived = ir.derived

  const [newVar, setNewVar] = useState('')
  const addVar = (collection: boolean) => {
    const id = toVariableId(newVar)
    if (!id) return
    const v: Variable = collection ? makeCollectionVariable(id) : makeScalarVariable(id, 'string', '')
    commit(addVariable(liveIR(), v))
    setNewVar('')
  }

  const [newDerived, setNewDerived] = useState('')
  const addFormula = () => {
    const id = toVariableId(newDerived)
    if (!id) return
    commit(addDerived(liveIR(), id, ''))
    setNewDerived('')
  }

  const node = singleId ? (page?.objects[singleId] as IndexedShape | undefined) : undefined
  const nodeInteractions = singleId ? ir.interactions.filter((it) => it.on.node === singleId) : []

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {/* State — editable input variables */}
      <section className="border-b border-border p-3">
        <h3 className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">State</h3>
        {variables.length === 0 && <p className="mb-1.5 text-[11px] text-muted-foreground/70">No variables yet.</p>}
        <div className="mb-2 flex flex-col gap-1.5">
          {variables.map((v) => (
            <VariableRow key={v.id} v={v} commit={commit} liveIR={liveIR} />
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring"
            placeholder="new variable name"
            value={newVar}
            onChange={(e) => setNewVar(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addVar(false)
            }}
            aria-label="New variable name"
          />
          <button
            type="button"
            className="h-7 shrink-0 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={!toVariableId(newVar)}
            onClick={() => addVar(false)}
          >
            + Value
          </button>
          <button
            type="button"
            className="h-7 shrink-0 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={!toVariableId(newVar)}
            onClick={() => addVar(true)}
          >
            + List
          </button>
        </div>
      </section>

      {/* Derived — read-only formulas over other state */}
      <section className="border-b border-border p-3">
        <h3 className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">Derived</h3>
        {derived.length === 0 && (
          <p className="mb-1.5 text-[11px] text-muted-foreground/70">No formulas yet — e.g. a count or an empty check.</p>
        )}
        <div className="mb-2 flex flex-col gap-1.5">
          {derived.map((d) => (
            <DerivedRow key={d.id} d={d} commit={commit} liveIR={liveIR} />
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring"
            placeholder="new formula name"
            value={newDerived}
            onChange={(e) => setNewDerived(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addFormula()
            }}
            aria-label="New formula name"
          />
          <button
            type="button"
            className="h-7 shrink-0 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={!toVariableId(newDerived)}
            onClick={addFormula}
          >
            + Formula
          </button>
        </div>
      </section>

      {!node ? (
        <section className="p-3">
          <p className="py-6 text-center text-xs text-muted-foreground">
            {selectedIds.size > 1 ? 'Select one component.' : 'Select a component to add interactions.'}
          </p>
        </section>
      ) : (
        <>
          {/* Repeat the selected node over a list (list-template authoring) */}
          <RepeatSection nodeId={node.id} ir={ir} collections={collections} commit={commit} liveIR={liveIR} />

          {/* Bind the selected node's props to expressions */}
          <BindSection nodeId={node.id} ir={ir} commit={commit} liveIR={liveIR} />

          {/* Interactions for the selected node */}
          <section className="flex flex-col gap-2 p-3">
            <h3 className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Interactions · {node.name ?? 'component'}
            </h3>
            {nodeInteractions.map((it) => (
              <InteractionCard
                key={it.id}
                it={it}
                triggers={triggers}
                variables={variables}
                nodes={nodes}
                commit={commit}
                liveIR={liveIR}
              />
            ))}
            <button
              type="button"
              className="self-start rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              onClick={() => commit(addInteraction(liveIR(), singleId as string, crypto.randomUUID()))}
            >
              + Add interaction
            </button>
          </section>
        </>
      )}
    </div>
  )
}
