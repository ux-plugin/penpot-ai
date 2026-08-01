/**
 * Turning existing SkSL into a graph, so a shader is never *not* a graph.
 *
 * A shader authored as code used to have no graph at all — the editor offered
 * "Start a graph", which replaced your source. That is backwards: the graph is
 * the model, so code has to arrive as one.
 *
 * What this does is deliberately shallow. It finds `main`, takes its body as the
 * root node's code, and keeps everything above it — uniforms, constants, helper
 * functions — in the graph's {@link ShaderGraph.preamble}, emitted verbatim. The
 * result round-trips: compiling it reproduces the source you started from.
 *
 * What it does NOT do is split those helper functions into separate wired nodes.
 * Doing that needs the call structure, and recovering that from arbitrary source
 * means parsing expressions — a real parser, not brace matching. Until then an
 * imported shader is one node you can open and edit, and nodes you add around it
 * wire normally.
 */

import type { ShaderGraph, ShaderNode } from './model'

const ROOT = 'root'

/** Index just past the `{...}` block starting at `open`, or -1 if unbalanced. */
function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    // Skip comments so a brace inside one cannot unbalance the scan.
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i)
      if (i === -1) return -1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** `main`'s signature, body and surrounding text — or null when there is no main. */
function splitMain(source: string): { param: string; body: string; rest: string } | null {
  const sig = /\bhalf4\s+main\s*\(\s*float2\s+(\w+)\s*\)\s*\{/.exec(source)
  if (!sig) return null
  const open = source.indexOf('{', sig.index)
  const close = matchBrace(source, open)
  if (close === -1) return null

  const body = source.slice(open + 1, close - 1).replace(/^\n+|\s+$/g, '')
  const rest = (source.slice(0, sig.index) + source.slice(close)).trim()
  // Strip one level of the original indentation so the body reads as its own
  // function rather than as something that used to be nested.
  const indents = body
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => /^\s*/.exec(l)?.[0].length ?? 0)
  const common = indents.length > 0 ? Math.min(...indents) : 0
  return {
    param: sig[1],
    body: body
      .split('\n')
      .map((l) => l.slice(common))
      .join('\n'),
    rest,
  }
}

/**
 * A graph equivalent to `source`. Never fails: source we cannot find a `main` in
 * becomes a graph whose single node holds it verbatim, which still compiles and
 * still opens for editing.
 */
export function graphFromSource(source: string): ShaderGraph {
  const split = splitMain(source)
  const root: ShaderNode = {
    id: ROOT,
    name: 'Material',
    parentId: undefined,
    pos: 'a',
    position: { x: 0, y: 0 },
    returns: 'vec4',
    params: [{ name: split?.param ?? 'p', type: 'vec2' }],
    body: split ? split.body : 'return half4(0.0, 0.0, 0.0, 1.0);',
    values: {},
  }
  return {
    root: ROOT,
    nodes: { [ROOT]: root },
    edges: {},
    preamble: split ? split.rest : source.trim(),
  }
}
