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

  // variables -> state signals (or an inbound port when fed by business logic)
  for (const v of ir.variables) {
    if (v.source === 'local') nodes.push({ kind: 'source', id: `var:${v.id}`, produces: 'signal', of: { source: 'state', variable: v.id } })
    else nodes.push({ kind: 'port', id: `var:${v.id}`, dir: 'in' })
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

  return { nodes, edges }
}
