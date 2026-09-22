/**
 * Interactions module — reactive-graph foundation for prototyping interactions
 * that compile to React. See docs/interactions/PHASE_0_PLAN.md.
 */

export * from './ir'
export * from './catalog'
export * from './expression'
// `expression.refsOf(src)` is `freeRefs(parse(src))`; the IR's `refsOf(ir, node)` is the one exported here.
export { refsOf } from './ir'
export * from './addressing'
export * from './expr'
export * from './upgrade'
export * from './anchor'
export * from './compile'
export * from './document/nodes-to-presentation'
