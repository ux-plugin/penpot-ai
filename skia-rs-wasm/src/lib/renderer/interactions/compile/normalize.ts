/**
 * normalize — lower the stored ECA-sugar into the normalized reactive graph.
 *
 * This is the "everything flows through one graph" step: each sugar element
 * becomes Signal/Event source · derive · fold · sink · switch · effect · port
 * nodes. The graph is a compile artifact (never stored) and the semantic contract
 * the emitters target. Phase 0 produces it primarily as proof of the mapping;
 * the React emitter currently transliterates the higher-fidelity sugar directly,
 * guided by the same catalog `lowers` metadata, so the two never disagree.
 */

import type { PageInteractions, ReactiveGraph, GraphNode } from '../ir'
import { getAction } from '../catalog'
import { parse, freeRefs } from '../expression'

export function normalize(ir: PageInteractions): ReactiveGraph {
  const nodes: GraphNode[] = []
  const edges: Array<{ from: string; to: string }> = []

  const depId = (ref: string): string | undefined => {
    if (ir.variables.some((v) => v.id === ref)) return `var:${ref}`
    if (ir.derived.some((d) => d.id === ref)) return `derived:${ref}`
    if (ir.ports.some((p) => p.id === ref)) return `port:${ref}`
    return undefined
  }

  // variables -> state signals. A variable is always design-owned state; a value
  // from outside is a Port, so there is no per-variable branch here.
  for (const v of ir.variables) {
    nodes.push({ kind: 'source', id: `var:${v.id}`, produces: 'signal', of: { source: 'state', variable: v.id } })
  }

  for (const p of ir.ports) nodes.push({ kind: 'port', id: `port:${p.id}`, dir: p.dir })

  // derived -> derive nodes, with edges from each input signal
  for (const d of ir.derived) {
    const inputs = [...freeRefs(parse(d.expr))]
    nodes.push({ kind: 'derive', id: `derived:${d.id}`, inputs, expr: d.expr })
    for (const inp of inputs) {
      const from = depId(inp)
      if (from) edges.push({ from, to: `derived:${d.id}` })
    }
  }

  // interactions -> an event source + one combinator per action
  ir.interactions.forEach((it, i) => {
    const src = `evt:${it.on.node}:${i}`
    nodes.push({ kind: 'source', id: src, produces: 'event', of: { source: 'event', node: it.on.node, trigger: it.on.trigger.type } })
    it.do.forEach((a, j) => {
      const nid = `act:${i}:${j}`
      const lowers = getAction(a.type)?.lowers ?? 'effect'
      if (lowers === 'fold' || lowers === 'setState') nodes.push({ kind: 'fold', id: nid, on: src, state: a.target ?? '', reducer: a.value ?? 'null' })
      else if (lowers === 'switch') nodes.push({ kind: 'switch', id: nid, on: src, cases: {} })
      else nodes.push({ kind: 'effect', id: nid, on: src, call: a.type })
      edges.push({ from: src, to: nid })
      // An out-port call is not an opaque effect: it terminates at a port node,
      // so the graph shows the value actually leaving.
      if (a.target && ir.ports.some((p) => p.id === a.target && p.dir === 'out')) {
        edges.push({ from: nid, to: `port:${a.target}` })
      }
    })
  })

  // bindings -> sinks, with edges from each referenced signal
  ir.bindings.forEach((b, i) => {
    const nid = `sink:${i}`
    nodes.push({ kind: 'sink', id: nid, from: b.from, node: b.node, prop: b.prop })
    for (const inp of freeRefs(parse(b.from))) {
      const from = depId(inp)
      if (from) edges.push({ from, to: nid })
    }
  })

  // editable -> the three primitives that already exist. This is the whole
  // argument for storing two-way as sugar: it adds NO graph concept. The read is
  // a sink fed by the cell's signal; the write is a discrete event folded back
  // into the same cell. Signal in, Event out — so there is no cycle, for the same
  // reason a React controlled input terminates rather than looping.
  ir.editable.forEach((e, i) => {
    const sink = `sink:edit:${i}`
    nodes.push({ kind: 'sink', id: sink, from: e.target, node: e.node, prop: e.prop })
    const from = depId(e.target)
    if (from) edges.push({ from, to: sink })

    const src = `evt:edit:${i}`
    nodes.push({ kind: 'source', id: src, produces: 'event', of: { source: 'event', node: e.node, trigger: 'value-change' } })

    const fold = `fold:edit:${i}`
    nodes.push({ kind: 'fold', id: fold, on: src, state: e.target, reducer: 'event.value' })
    edges.push({ from: src, to: fold })
  })

  return { nodes, edges }
}
