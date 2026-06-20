/**
 * AI-CLI chat bridge (client side).
 *
 * Talks to the dev-server `/__ai-chat` endpoint (see vite.config `aiChatPlugin`),
 * which spawns the local `claude` CLI. We build the full prompt here — where the
 * domain knowledge lives (nodes, current IR, the trigger/action catalog, the IR
 * schema) — send it as a plain string, and parse the model's `{ reply, ir }` JSON
 * back. The server stays a dumb subprocess bridge.
 *
 * This is the real implementation of the `interpret` seam: same idea, but a live
 * Claude session instead of the rule-based stub. Callers should fall back to the
 * stub when this throws (endpoint down / CLI missing).
 */

import { listTriggers, listActions } from '../catalog'
import type { PageInteractions } from '../ir'

export interface AiChatContext {
  request: string
  history: { role: 'user' | 'assistant'; text: string }[]
  nodes: { id: string; name?: string; type?: string }[]
  ir: PageInteractions
  selectedId?: string | null
}

export interface AiChatResult {
  reply: string
  /** Present only when the model returned a usable full IR. */
  ir?: PageInteractions
}

interface ActionEntry {
  key: string
  expects?: { target?: string; value?: boolean }
}

function describeAction(a: ActionEntry): string {
  const t = a.expects?.target ?? 'none'
  return `${a.key} (target:${t}${a.expects?.value ? ', value' : ''})`
}

function buildPrompt(ctx: AiChatContext): string {
  const triggers = listTriggers()
    .map((t) => t.key)
    .join(', ')
  const actions = (listActions() as ActionEntry[]).map(describeAction).join(', ')
  const nodes = ctx.nodes.map((n) => `- ${n.id}  "${n.name ?? ''}"  ${n.type ?? ''}`).join('\n')
  const history = ctx.history.map((m) => `${m.role}: ${m.text}`).join('\n')

  return [
    'You author UI interactions for a design tool, stored as a JSON "PageInteractions" IR.',
    '',
    'PageInteractions shape:',
    '{ version:1, variables:[{id,type,scope:"page",initial,source:"local"}], derived:[{id,expr}], ports:[],',
    '  interactions:[{id, on:{node:<nodeId>, trigger:{type}}, if?:<expr>, do:[{type, target?, value?}]}],',
    '  appRules:[], bindings:[{node:<nodeId>, prop, from:<expr>}], states:[], repeaters:[{node:<nodeId>, over, as?, key?}] }',
    'Expressions are a small JS subset (member access; + - * / %; == != < > <= >=; && ||; ternary; literals; object/array literals). Use == not ===.',
    'A list variable has type {collection:"object"} and initial []. collection.append target is the list id.',
    '',
    `Trigger types: ${triggers}`,
    `Action types: ${actions}`,
    '',
    'Design nodes (id, name, type) — only reference these ids:',
    nodes || '(none)',
    '',
    'Current IR:',
    JSON.stringify(ctx.ir),
    '',
    history ? `Conversation so far:\n${history}\n` : '',
    `User request: ${ctx.request}`,
    ctx.selectedId ? `Selected node id: ${ctx.selectedId}` : '',
    '',
    'Respond with ONLY a JSON object, no prose and no markdown fences:',
    '{ "reply": "<one short sentence for the user>", "ir": <the FULL updated PageInteractions, or null if you need to ask a clarifying question> }',
    'Preserve existing IR entries unless the request changes them. Generate fresh ids where needed.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Minimal structural guard before we commit a model-produced IR. */
function looksLikeIR(x: unknown): x is PageInteractions {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return o.version === 1 && Array.isArray(o.interactions) && Array.isArray(o.variables) && Array.isArray(o.bindings)
}

function parseResult(text: string): AiChatResult {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    const o = JSON.parse(stripped) as { reply?: unknown; ir?: unknown }
    const ir = looksLikeIR(o.ir) ? o.ir : undefined
    const reply = typeof o.reply === 'string' && o.reply.trim() ? o.reply : ir ? 'Done.' : stripped
    return { reply, ir }
  } catch {
    // Model didn't return clean JSON — surface its text as the reply.
    return { reply: text.trim() }
  }
}

export async function aiChat(ctx: AiChatContext): Promise<AiChatResult> {
  const res = await fetch('/__ai-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: buildPrompt(ctx) }),
  })
  if (!res.ok) throw new Error(`ai endpoint ${res.status}`)
  const data = (await res.json()) as { ok: boolean; text?: string; error?: string }
  if (!data.ok) throw new Error(data.error || 'ai bridge failed')
  return parseResult(data.text ?? '')
}
