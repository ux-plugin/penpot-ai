/**
 * Inspector → Interactions tab. Shared by both modes.
 *
 * Authors the page's behaviour records with the edit builders in
 * edit-interactions, committing each edit's changes via commitBehaviour (so the
 * live preview reacts immediately). Trigger/action
 * menus are sourced from the catalog registry — they grow as the catalog does.
 */

import { useMemo, useState } from 'react'
import { computed } from '@preact/signals-core'
import { cn } from '@/lib/utils'
import {
  children,
  getActiveOrSinglePageId,
  getNode,
  nodesOfPage,
  useChildren,
  useCurrentPageId,
  useNode,
  useSignal,
  type LocalChange,
  type Node,
} from '../../doc'
import { useSelectedIds } from '../../renderer/store/document-selection'
import {
  EMPTY_BEHAVIOUR,
  bindingOf,
  bindingsOn,
  cellRef,
  isFormula,
  isCollectionType,
  ownerKind,
  propRef,
  editedCell,
  editableError,
  actionParam,
  rulesOn,
  REPEAT_PROP,
  VALUE_PROP,
  type Behaviour,
  type Rule,
  type Action,
  type Cell,
  type OwnerKind,
  type Store,
  type ValueType,
  type Json,
} from '../../renderer/interactions/ir'
import { listTriggers, listActions, getAction, isPlanned, type CatalogStatus } from '../../renderer/interactions/catalog'
import { isSlotShape, isFrameShape } from '../../worker/geometry/shapes'
import { addViewToSlot } from '../../renderer/slot/slot-edit'
import { parse } from '../../renderer/interactions/expression'
import { exprText, refName } from '../../renderer/interactions/expr'
import {
  addRule,
  removeRule,
  setTrigger,
  setCondition,
  addAction,
  removeAction,
  setActionType,
  setActionTarget,
  setActionNodeTarget,
  setActionValue,
  setActionParam,
  addCell,
  removeCell,
  makeListCell,
  makeCell,
  makeFormula,
  toCellId,
  setCellValue,
  setCellType,
  setCellFormula,
  setCellOwner,
  setCellStore,
  setRepeat,
  clearRepeat,
  moveRepeat,
  setRef,
  clearRef,
  moveRef,
  DOCUMENT,
  pageHome,
  type Home,
} from '../../renderer/interactions/document/edit-interactions'
import { commitBehaviour, currentBehaviour, currentStores } from '../../renderer/interactions/document/behaviour'
import { useBehaviour, useStores } from '../../renderer/interactions/document/use-behaviour'

type Commit = (changes: LocalChange[]) => void
type LiveIR = () => Behaviour

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

/**
 * Label for a catalog option, suffixed when the entry is registered but not yet
 * executed. Paired with a `disabled` option so a planned entry is visible (you
 * can see it's coming, and an IR that already uses one still displays it) but
 * can't be newly authored into an interaction that would never fire.
 */
function optionLabel(entry: { label: string; status?: CatalogStatus }): string {
  return isPlanned(entry) ? `${entry.label} — not wired yet` : entry.label
}

/** Value-field hint per action, so the example matches what the action does. */
function valuePlaceholder(type: string): string {
  switch (type) {
    case 'collection.update':
      return 'an object patches the item, e.g. { done: true }'
    case 'increment':
      return 'amount, blank = 1'
    case 'open-url':
      return 'url, e.g. "https://example.com"'
    default:
      return 'value, e.g. { label: "Item " + (items.length + 1) }'
  }
}

function ActionRow({
  it,
  index,
  cells,
  nodes,
  commit,
  liveIR,
}: {
  it: Rule
  index: number
  /** Every cell an action may write — anything but a formula. */
  cells: readonly Cell[]
  nodes: readonly Node[]
  commit: Commit
  liveIR: LiveIR
}) {
  const action: Action = it.do[index]
  const entry = getAction(action.type)
  const expectsTarget = entry?.expects.target ?? 'none'
  const expectsValue = entry?.expects.value ?? false
  const expectsParams = entry?.expects.params ?? []
  const id = it.id as string
  const valueText = exprText(action.value, liveIR())
  const targetText = action.target ? refName(action.target, liveIR()) : ''
  const err = exprError(valueText)

  const targets = expectsTarget === 'collection' ? cells.filter((c) => isCollectionType(c.type)) : cells

  // Slot swap ("Show here"): target picks the slot, value picks the view frame.
  // Both are plain node pickers — no routing/history vocabulary (derived at lowering).
  const slots = expectsTarget === 'slot' ? nodes.filter(isSlotShape) : []
  const isShowInSlot = action.type === 'show-in-slot'
  const viewFrames = isShowInSlot ? nodes.filter(isFrameShape) : []

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
            <option key={a.key} value={a.key} disabled={isPlanned(a) && a.key !== action.type}>
              {optionLabel(a)}
            </option>
          ))}
        </select>

        {(expectsTarget === 'variable' || expectsTarget === 'collection') && (
          <select
            className={selectCls}
            value={targetText}
            onChange={(e) => commit(setActionTarget(liveIR(), id, index, e.target.value))}
            aria-label="Target value"
          >
            <option value="">{targets.length ? 'choose…' : 'add a value below'}</option>
            {targets.map((c) => (
              <option key={cellRef(c)} value={cellRef(c)}>
                {cellRef(c)}
              </option>
            ))}
          </select>
        )}

        {expectsTarget === 'slot' && (
          <select
            className={selectCls}
            value={action.target?.kind === 'node' ? action.target.node : ''}
            onChange={(e) => commit(setActionNodeTarget(liveIR(), id, index, e.target.value))}
            aria-label="Target slot"
          >
            <option value="">{slots.length ? 'choose slot…' : 'add a slot first'}</option>
            {slots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? s.id.slice(0, 8)}
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

      {isShowInSlot ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>show</span>
          <select
            className={selectCls}
            value={action.value?.type === 'lit' && typeof action.value.value === 'string' ? action.value.value : ''}
            onChange={(e) => {
              const viewId = e.target.value
              // The view id is a literal, not an expression: quoted so it stores as one.
              commit(setActionValue(liveIR(), id, index, viewId ? JSON.stringify(viewId) : ''))
              // Register the chosen view on the target slot so it has a candidate
              // to mirror (defaults the slot's active view if it had none yet).
              if (viewId && action.target?.kind === 'node') void addViewToSlot(action.target.node, viewId)
            }}
            aria-label="View to show"
          >
            <option value="">{viewFrames.length ? 'choose view…' : 'add a frame first'}</option>
            {viewFrames.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name ?? f.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          {expectsValue && (
            <div className="mt-1.5">
              <input
                key={`${id}-${index}-${action.type}`}
                className={cn(inputCls, err && 'border-destructive')}
                defaultValue={valueText}
                placeholder={valuePlaceholder(action.type)}
                onBlur={(e) => commit(setActionValue(liveIR(), id, index, e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                aria-label="Action value"
              />
              {err && <p className="mt-0.5 text-[10px] text-destructive">{err}</p>}
            </div>
          )}

          {expectsParams.map((p) => {
            const cur = exprText(actionParam(action, p.key), liveIR())
            const pErr = exprError(cur)
            return (
              <div key={p.key} className="mt-1.5 flex items-start gap-1.5">
                <span className="mt-1.5 w-11 shrink-0 text-[11px] text-muted-foreground">{p.label}</span>
                <div className="min-w-0 flex-1">
                  <input
                    key={`${id}-${index}-${action.type}-${p.key}`}
                    className={cn(inputCls, pErr && 'border-destructive')}
                    defaultValue={cur}
                    placeholder={p.placeholder}
                    onBlur={(e) => commit(setActionParam(liveIR(), id, index, p.key, e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    aria-label={`Action ${p.label}`}
                  />
                  {pErr && <p className="mt-0.5 text-[10px] text-destructive">{pErr}</p>}
                </div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

function InteractionCard({
  it,
  triggers,
  cells,
  nodes,
  commit,
  liveIR,
}: {
  it: Rule
  triggers: ReturnType<typeof listTriggers>
  cells: readonly Cell[]
  nodes: readonly Node[]
  commit: Commit
  liveIR: LiveIR
}) {
  const id = it.id as string
  const condText = exprText(it.if, liveIR())
  const condErr = exprError(condText)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">When</span>
        <select
          className={selectCls}
          value={it.on.type}
          onChange={(e) => commit(setTrigger(liveIR(), id, e.target.value))}
          aria-label="Trigger"
        >
          {triggers.map((t) => (
            <option key={t.key} value={t.key} disabled={isPlanned(t) && t.key !== it.on.type}>
              {optionLabel(t)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
          aria-label="Remove interaction"
          title="Remove interaction"
          onClick={() => commit(removeRule(id))}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-muted-foreground">Do</span>
        {it.do.length === 0 && <p className="text-[11px] text-muted-foreground/70">No actions yet.</p>}
        {it.do.map((_, i) => (
          <ActionRow
            key={i}
            it={it}
            index={i}
            cells={cells}
            nodes={nodes}
            commit={commit}
            liveIR={liveIR}
          />
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
          defaultValue={condText}
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

/**
 * List authoring on a CONTAINER: a frame "shows" a list, and one of its children
 * is the per-item template. The `repeat` reference is stored on the template
 * child, so the IR/runtime/emitter are unchanged — only the authoring surface
 * moves from the leaf to the parent frame.
 */
function ListSection({
  node,
  ir,
  lists,
  commit,
  liveIR,
}: {
  node: Node
  ir: Behaviour
  /** Every list available to repeat over — page state AND lists arriving from outside. */
  lists: readonly { id: string }[]
  commit: Commit
  liveIR: LiveIR
}) {
  const kids = children(node.id).map(getNode).filter((c): c is Node => Boolean(c))
  const template = kids.find((c) => propRef(ir, c.id, REPEAT_PROP) !== undefined)
  const rep = template ? bindingOf(ir, template.id, REPEAT_PROP) : undefined
  const on = Boolean(rep && template)
  const hasLists = lists.length > 0
  const over = exprText(rep?.expr, ir)
  const overMissing = on && over !== '' && !lists.some((v) => v.id === over)
  const keyText = exprText(rep?.item?.key, ir)
  const keyErr = exprError(keyText)
  const childName = (c: Node) => c.name ?? c.id.slice(0, 8)

  const toggle = () => {
    if (on && template) commit(clearRepeat(liveIR(), template.id))
    else if (hasLists && kids[0]) commit(setRepeat(liveIR(), kids[0].id, { over: lists[0].id, as: 'item' }))
  }

  return (
    <section className="border-b border-border p-3">
      <h3 className={sectionHeadCls}>List</h3>
      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={on}
          disabled={!on && !hasLists}
          onChange={toggle}
          aria-label="Show a list inside this frame"
        />
        <span>Show a list inside this frame</span>
      </label>
      {!hasLists && !on && (
        <p className="mt-1.5 text-[11px] text-muted-foreground/70">
          Add a list in State, or one the app supplies.
        </p>
      )}
      {on && rep && template && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>shows list</span>
            <select
              className={selectCls}
              value={over}
              onChange={(e) => commit(setRepeat(liveIR(), template.id, { over: e.target.value }))}
              aria-label="Shows list"
            >
              <option value="">choose…</option>
              {lists.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                </option>
              ))}
            </select>
            <span>as</span>
            <input
              key={`${template.id}-as-${rep.item?.as ?? ''}`}
              className="h-7 w-20 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-ring"
              defaultValue={rep.item?.as ?? 'item'}
              onBlur={(e) => commit(setRepeat(liveIR(), template.id, { as: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              aria-label="Item name"
            />
          </div>

          {kids.length > 1 && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>item template</span>
              <select
                className={selectCls}
                value={template.id}
                onChange={(e) => commit(moveRepeat(liveIR(), template.id, e.target.value))}
                aria-label="Item template"
              >
                {kids.map((c) => (
                  <option key={c.id} value={c.id}>
                    {childName(c)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {overMissing && <p className="text-[10px] text-destructive">List “{over}” was removed — pick another.</p>}

          <input
            key={`${template.id}-key-${keyText}`}
            className={cn(inputCls, keyErr && 'border-destructive')}
            defaultValue={keyText}
            placeholder="key (optional), e.g. item.id"
            onBlur={(e) => commit(setRepeat(liveIR(), template.id, { key: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            aria-label="Item key expression"
          />
          {keyErr && <p className="text-[10px] text-destructive">{keyErr}</p>}

          <div className="mt-0.5 flex items-center gap-1.5 rounded bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground">
            <span aria-hidden>⟳</span>
            <span>
              shows {over || '…'} · template: {childName(template)}
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

function BindRow({
  nodeId,
  prop,
  expr,
  forEachItem,
  commit,
  liveIR,
}: {
  nodeId: string
  prop: string
  expr: string
  forEachItem: boolean
  commit: Commit
  liveIR: LiveIR
}) {
  const err = exprError(expr)
  const props = COMMON_PROPS.includes(prop) ? COMMON_PROPS : [prop, ...COMMON_PROPS]
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="flex items-center gap-1.5">
        <select
          className={selectCls}
          value={prop}
          onChange={(e) => commit(moveRef(liveIR(), nodeId, prop, e.target.value))}
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
          onClick={() => commit(clearRef(liveIR(), nodeId, prop))}
        >
          ✕
        </button>
      </div>
      <div className="mt-1.5">
        <input
          key={`${nodeId}-${prop}-from`}
          className={cn(inputCls, err && 'border-destructive')}
          defaultValue={expr}
          placeholder={forEachItem ? 'expression, e.g. item.label' : 'expression, e.g. count'}
          onBlur={(e) => commit(setRef(liveIR(), nodeId, prop, e.target.value))}
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

/**
 * Two-way binding for the selected node: "this field edits <value>".
 *
 * Only editable cells are offered. A derived value is deliberately absent
 * rather than shown-and-rejected — it is a formula, so writing to it is a
 * category error, not a missing feature. `editableError` is the single source
 * of that rule, shared with the engine.
 */
function EditsSection({
  nodeId,
  ir,
  commit,
  liveIR,
}: {
  nodeId: string
  ir: Behaviour
  commit: Commit
  liveIR: LiveIR
}) {
  const current = editedCell(ir, nodeId)
  // Anything the engine would accept a write into.
  const writable = ir.cells.filter((c) => !editableError(ir, cellRef(c)))
  const err = current ? editableError(ir, cellRef(current)) : null
  const setEdits = (target: string) =>
    commit(target ? setRef(liveIR(), nodeId, VALUE_PROP, target) : clearRef(liveIR(), nodeId, VALUE_PROP))

  return (
    <section className="flex flex-col gap-1.5 border-t border-border p-3">
      <h3 className={sectionHeadCls}>Edits</h3>
      {writable.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No editable state — add a variable above, then a field can edit it.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">this edits</span>
            <select
              className={selectCls}
              value={current ? cellRef(current) : ''}
              onChange={(e) => setEdits(e.target.value)}
              aria-label="Value this node edits"
            >
              <option value="">nothing</option>
              {writable.map((c) => (
                <option key={cellRef(c)} value={cellRef(c)}>
                  {cellRef(c)}
                </option>
              ))}
            </select>
          </div>
          {err && <p className="text-[10px] text-destructive">{err}</p>}
          {current && !err && (
            <p className="text-[10px] text-muted-foreground">
              Typing here sets <span className="font-mono">{cellRef(current)}</span>, and it shows the current value.
            </p>
          )}
        </>
      )}
    </section>
  )
}

function BindSection({
  nodeId,
  ir,
  forEachItem,
  commit,
  liveIR,
}: {
  nodeId: string
  ir: Behaviour
  forEachItem: boolean
  commit: Commit
  liveIR: LiveIR
}) {
  // `repeat` is authored in the List section and an edited `value` in Edits;
  // everything else a property references shows here.
  const edited = editedCell(ir, nodeId)
  const bindings = bindingsOn(ir, nodeId).filter((x) => x.prop !== REPEAT_PROP && !(edited && x.prop === VALUE_PROP))
  const add = () => {
    const live = liveIR()
    const prop = COMMON_PROPS.find((p) => propRef(live, nodeId, p) === undefined) ?? 'text'
    const first = live.cells.find((c) => c.node == null)
    commit(setRef(live, nodeId, prop, first ? cellRef(first) : '""'))
  }
  return (
    <section className="border-b border-border p-3">
      <h3 className={sectionHeadCls}>{forEachItem ? 'Bind · for each item' : 'Bind'}</h3>
      {bindings.length === 0 && <p className="mb-1.5 text-[11px] text-muted-foreground/70">No bindings yet.</p>}
      <div className="mb-2 flex flex-col gap-1.5">
        {bindings.map(({ prop, expr }) => (
          <BindRow key={prop} nodeId={nodeId} prop={prop} expr={exprText(expr, ir)} forEachItem={forEachItem} commit={commit} liveIR={liveIR} />
        ))}
      </div>
      <button
        type="button"
        className="self-start text-[11px] text-muted-foreground hover:text-foreground"
        onClick={add}
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

/**
 * A JSON value editor keyed to a ValueType. For a design-owned cell this is its
 * starting value; for one supplied from outside it is the sample the preview runs
 * on. Same control, because it is the same edit.
 */
function ValueEditor({
  id,
  type,
  value,
  placeholder,
  set,
}: {
  /** Only for keying/labelling — the caller owns where the value goes. */
  id: string
  type: ValueType
  value: Json
  placeholder?: string
  set: (next: Json) => void
}) {
  if (typeof type === 'object') {
    const n = Array.isArray(value) ? value.length : 0
    return <span className="text-[10px] text-muted-foreground">starts empty · {n}</span>
  }
  if (type === 'boolean') {
    return <input type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} aria-label={`${id} value`} />
  }
  if (type === 'number') {
    return (
      <input
        type="number"
        key={`${id}-num-${String(value)}`}
        className={varInputCls}
        defaultValue={typeof value === 'number' ? value : 0}
        onBlur={(e) => set(e.target.value === '' ? 0 : Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        aria-label={`${id} value`}
      />
    )
  }
  // string / any
  return (
    <input
      key={`${id}-str-${String(value)}`}
      className={varInputCls}
      defaultValue={value == null ? '' : String(value)}
      placeholder={placeholder ?? 'value'}
      onBlur={(e) => set(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      aria-label={`${id} value`}
    />
  )
}

/** The value editor for a cell's initial value, by type. */
function CellValueEditor({ c, commit, liveIR }: { c: Cell; commit: Commit; liveIR: LiveIR }) {
  const ref = cellRef(c)
  return <ValueEditor id={ref} type={c.type} value={c.initial} set={(value) => commit(setCellValue(liveIR(), ref, value))} />
}

/** Where a cell lives, in the designer's words. */
const OWNER_LABEL: Record<OwnerKind, string> = {
  node: 'this component',
  page: 'this page',
  document: 'whole document',
}
/** The owners a cell can be moved to from here; a node's cell can go back to its node. */
const OWNERS: OwnerKind[] = ['page', 'document']

/** The references that put a cell in `kind`, on `page`. */
function homeFor(kind: OwnerKind, c: Cell, page: string): Home {
  if (kind === 'node' && c.node != null) return { page: c.page ?? page, node: c.node }
  return kind === 'page' ? pageHome(page) : DOCUMENT
}

/**
 * One component-local cell — the design's own state. Name, type, where it lives,
 * starting value.
 *
 * There is no "from the app" control here anymore: a value the real app supplies
 * lives in a STORE, which the designer creates in the Data panel. "Comes from
 * outside" is where a value lives, not a checkbox on it. `stores` lets the row
 * offer "move into a store" — the designer decides what wires to what.
 */
function CellRow({
  c,
  page,
  stores,
  commit,
  liveIR,
}: {
  c: Cell
  page: string
  stores: readonly Store[]
  commit: Commit
  liveIR: LiveIR
}) {
  const ref = cellRef(c)
  const cur = typeKey(c.type)
  const keys = TYPE_KEYS.includes(cur) ? TYPE_KEYS : [cur, ...TYPE_KEYS]
  const owners: OwnerKind[] = c.node != null ? ['node', ...OWNERS] : OWNERS
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={ref}>
          {ref}
        </span>
        <select
          className={typeSelectCls}
          value={cur}
          onChange={(e) => commit(setCellType(liveIR(), ref, typeFromKey(e.target.value)))}
          aria-label={`${ref} type`}
        >
          {keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${ref}`}
          onClick={() => commit(removeCell(liveIR(), ref))}
        >
          ✕
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <select
          className={typeSelectCls}
          value={ownerKind(c)}
          onChange={(e) => {
            const kind = owners.find((o) => o === e.target.value)
            if (kind) commit(setCellOwner(liveIR(), ref, homeFor(kind, c, page)))
          }}
          aria-label={`${ref} lives in`}
        >
          {owners.map((o) => (
            <option key={o} value={o}>
              {OWNER_LABEL[o]}
            </option>
          ))}
        </select>
        {stores.length > 0 && (
          <select
            className={typeSelectCls}
            value=""
            onChange={(e) => e.target.value && commit(setCellStore(liveIR(), ref, e.target.value, stores))}
            aria-label={`Move ${ref} into a store`}
            title="Move this value into a store — mark it as supplied by the real app"
          >
            <option value="">move to store…</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">starts as</span>
          <CellValueEditor c={c} commit={commit} liveIR={liveIR} />
        </div>
      </div>
    </div>
  )
}

function FormulaRow({ c, commit, liveIR }: { c: Cell; commit: Commit; liveIR: LiveIR }) {
  const ref = cellRef(c)
  const formulaText = exprText(c.formula, liveIR())
  const err = exprError(formulaText)
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs text-foreground">{ref}</span>
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground" title="derived — read-only formula">
          ƒ
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${ref}`}
          onClick={() => commit(removeCell(liveIR(), ref))}
        >
          ✕
        </button>
      </div>
      <input
        key={`${ref}-expr`}
        className={cn(inputCls, 'mt-1.5', err && 'border-destructive')}
        defaultValue={formulaText}
        placeholder="formula, e.g. items.length == 0"
        onBlur={(e) => commit(setCellFormula(liveIR(), ref, e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        aria-label={`${ref} formula`}
      />
      {err && <p className="mt-0.5 text-[10px] text-destructive">{err}</p>}
    </div>
  )
}

export function InteractionsTab() {
  const currentPageId = useCurrentPageId()
  const pid = currentPageId ?? getActiveOrSinglePageId()
  const selectedIds = useSelectedIds()
  const singleId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null

  const ir = useBehaviour(pid)
  const stores = useStores()
  const cells = ir.cells
  // Store cells are authored in the Data panel and formulas below; this section
  // is the design's own state. All remain one namespace an interaction can name.
  const localCells = cells.filter((c) => !c.store && !isFormula(c))
  const formulas = cells.filter(isFormula)
  const writable = cells.filter((c) => !isFormula(c))
  const lists = cells.filter((c) => isCollectionType(c.type)).map((c) => ({ id: cellRef(c) }))
  const triggers = useMemo(() => listTriggers().filter((t) => t.scope === 'node'), [])
  // A computed over the page, so target pickers track adds, deletes and renames.
  const nodes = useSignal(useMemo(() => computed(() => (pid ? nodesOfPage(pid) : [])), [pid]))

  const liveIR: LiveIR = () => (pid ? currentBehaviour(pid) : EMPTY_BEHAVIOUR)
  const commit: Commit = (changes) => void commitBehaviour(changes)

  const [newVar, setNewVar] = useState('')
  const addVar = (collection: boolean) => {
    const id = toCellId(newVar)
    if (!id || !pid) return
    const home = pageHome(pid)
    commit(addCell(liveIR(), collection ? makeListCell(id, home) : makeCell(id, 'string', '', home), currentStores()))
    setNewVar('')
  }

  const [newDerived, setNewDerived] = useState('')
  const addFormula = () => {
    const id = toCellId(newDerived)
    if (!id || !pid) return
    commit(addCell(liveIR(), makeFormula(id, undefined, pageHome(pid)), currentStores()))
    setNewDerived('')
  }

  const node = useNode(singleId)
  const nodeInteractions = singleId ? rulesOn(ir, singleId) : []
  const isContainer = useChildren(singleId).length > 0
  const isTemplate = node ? propRef(ir, node.id, REPEAT_PROP) !== undefined : false

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {/* State — editable input variables */}
      <section className="border-b border-border p-3">
        <h3 className={sectionHeadCls}>Values</h3>
        {localCells.length === 0 && (
          <p className="mb-1.5 text-[11px] text-muted-foreground/70">
            No local values yet. App data lives in a store — see the Data panel on the left.
          </p>
        )}
        <div className="mb-2 flex flex-col gap-1.5">
          {localCells.map((c) => (
            <CellRow key={cellRef(c)} c={c} page={pid ?? ''} stores={stores} commit={commit} liveIR={liveIR} />
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
            disabled={!toCellId(newVar)}
            onClick={() => addVar(false)}
          >
            + Value
          </button>
          <button
            type="button"
            className="h-7 shrink-0 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={!toCellId(newVar)}
            onClick={() => addVar(true)}
          >
            + List
          </button>
        </div>
      </section>

      {/* Derived — read-only formulas over other state */}
      <section className="border-b border-border p-3">
        <h3 className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">Derived</h3>
        {formulas.length === 0 && (
          <p className="mb-1.5 text-[11px] text-muted-foreground/70">No formulas yet — e.g. a count or an empty check.</p>
        )}
        <div className="mb-2 flex flex-col gap-1.5">
          {formulas.map((c) => (
            <FormulaRow key={cellRef(c)} c={c} commit={commit} liveIR={liveIR} />
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
            disabled={!toCellId(newDerived)}
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
          {/* A container frame can SHOW a list — author it here; the repeater lands on the template child */}
          {isContainer && (
            <ListSection node={node} ir={ir} lists={lists} commit={commit} liveIR={liveIR} />
          )}

          {/* Two-way: this node EDITS a value (a field), rather than only displaying one */}
          <EditsSection nodeId={node.id} ir={ir} commit={commit} liveIR={liveIR} />

          {/* Bind the selected node's props to expressions (per-item when it's a list template) */}
          <BindSection nodeId={node.id} ir={ir} forEachItem={isTemplate} commit={commit} liveIR={liveIR} />

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
                cells={writable}
                nodes={nodes}
                commit={commit}
                liveIR={liveIR}
              />
            ))}
            <button
              type="button"
              className="self-start rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              onClick={() => commit(addRule(liveIR(), singleId as string, crypto.randomUUID()))}
            >
              + Add interaction
            </button>
          </section>
        </>
      )}
    </div>
  )
}
