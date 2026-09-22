/**
 * normalize — lower the stored sugar into the normalized reactive graph.
 *
 * This is the "everything flows through one graph" step: cells become signal
 * sources (or derives, for formulas), interactions become event sources and
 * fold/switch/effect combinators, property references become sinks. The graph
 * is a compile artifact (never stored) and the semantic contract the emitters
 * target; the React emitter transliterates the sugar directly, guided by the
 * same catalog `lowers` metadata, so the two never disagree.
 */

import type { PageInteractions, ReactiveGraph, GraphNode, Cell, Expr, Ref } from '../ir'
import { cellRef, cellByUid, cellOf, isBacked, isFormula, editedCell, LIT, REF } from '../ir'
import { getAction } from '../catalog'
import { cellsIn, refName } from '../expr'

/** `event.value` — the reducer of a two-way edit. */
const EVENT_VALUE: Expr = { type: 'member', object: REF({ kind: 'name', name: 'event' }), property: 'value' }

export function normalize(ir: PageInteractions): ReactiveGraph {
  const nodes: GraphNode[] = []
  const edges: Array<{ from: string; to: string }> = []

  const cellId = (c: Cell): string => `${isFormula(c) ? 'derived' : 'cell'}:${cellRef(c)}`
  const depIds = (expr: Expr): string[] => {
    const out: string[] = []
    for (const uid of cellsIn(expr)) {
      const c = cellByUid(ir, uid)
      if (c) out.push(cellId(c))
    }
    return out
  }
  const targetName = (t: Ref | undefined): string => (t ? refName(t, ir) : '')

  // One outbound port per cell, however many actions write it.
  const outPorts = new Set<string>()
  const leave = (from: string, target: Ref | undefined) => {
    const c = cellOf(ir, target)
    if (!c || !isBacked(c)) return
    const key = cellRef(c)
    const out = `port:out:${key}`
    if (!outPorts.has(key)) {
      outPorts.add(key)
      nodes.push({ kind: 'port', id: out, dir: 'out' })
    }
    edges.push({ from, to: out })
  }

  // Cells -> state signals, formulas -> derive nodes. This is where "comes from
  // outside" first becomes plumbing: a cell that lives in a store additionally
  // grows an inbound port node feeding its signal. Nothing about that was named.
  for (const c of ir.cells) {
    const key = cellRef(c)
    if (isFormula(c)) {
      const inputs = depIds(c.formula!)
      nodes.push({ kind: 'derive', id: `derived:${key}`, inputs, expr: c.formula! })
      for (const from of inputs) edges.push({ from, to: `derived:${key}` })
      continue
    }
    nodes.push({ kind: 'source', id: `cell:${key}`, produces: 'signal', of: { source: 'state', cell: key } })
    if (isBacked(c)) {
      nodes.push({ kind: 'port', id: `port:in:${key}`, dir: 'in' })
      edges.push({ from: `port:in:${key}`, to: `cell:${key}` })
    }
  }

  // interactions -> an event source + one combinator per action
  ir.interactions.forEach((it, i) => {
    const src = `evt:${it.on.node}:${i}`
    nodes.push({ kind: 'source', id: src, produces: 'event', of: { source: 'event', node: it.on.node, trigger: it.on.trigger.type } })
    it.do.forEach((a, j) => {
      const nid = `act:${i}:${j}`
      const lowers = getAction(a.type)?.lowers ?? 'effect'
      if (lowers === 'fold') nodes.push({ kind: 'fold', id: nid, on: src, state: targetName(a.target), reducer: a.value ?? LIT(null) })
      else if (lowers === 'switch') nodes.push({ kind: 'switch', id: nid, on: src, cases: {} })
      else nodes.push({ kind: 'effect', id: nid, on: src, call: a.type })
      edges.push({ from: src, to: nid })
      // The write side of the same derivation: writing a cell that is backed
      // from outside has to leave, so the graph grows an outbound port and an
      // edge into it. The designer authored "add to cart.items" and never named
      // an event — this is where the event comes from.
      leave(nid, a.target)
    })
  })

  // property references -> sinks, with edges from each referenced signal
  ir.refs.forEach((r, i) => {
    for (const [prop, expr] of Object.entries(r.props)) {
      const nid = `sink:${i}:${prop}`
      nodes.push({ kind: 'sink', id: nid, from: expr, node: r.node, prop })
      for (const from of depIds(expr)) edges.push({ from, to: nid })
    }
    // A node that EDITS a cell: the read is the sink above; the write is a
    // discrete event folded back into the same cell. Two one-way edges, no
    // cycle — a Signal in and an Event out is why a controlled input terminates.
    const edited = editedCell(ir, r.node)
    if (edited) {
      const src = `evt:edit:${i}`
      nodes.push({ kind: 'source', id: src, produces: 'event', of: { source: 'event', node: r.node, trigger: 'value-change' } })
      const fold = `fold:edit:${i}`
      nodes.push({ kind: 'fold', id: fold, on: src, state: cellRef(edited), reducer: EVENT_VALUE })
      edges.push({ from: src, to: fold })
      leave(fold, { kind: 'cell', cell: edited.uid })
    }
  })

  return { nodes, edges }
}
