/**
 * AI chat client (Build mode).
 *
 * We build the full prompt here — where the domain knowledge lives (nodes, the
 * page's behaviour as text, the trigger/action catalog) — stream it to the
 * backend LLM *provider* facade via the Vercel AI SDK, accumulate the reply, and
 * parse the model's `{ reply, behaviour }` JSON envelope back into records.
 *
 * The backend (`/api/llm/v1/chat/completions`, OpenAI-compatible) holds the
 * platform provider key server-side; the browser only carries our backend
 * credential. It throws when the backend is down or unauthorized.
 */

import { streamText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { listTriggers, listActions } from '../catalog'
import type { Behaviour } from '../ir'
import { fromText, toText, type TextBehaviour } from '../expr'
import { getDesktopChat, getKeyStore } from '../../desktop-bridge'

export interface AiChatContext {
  request: string
  history: { role: 'user' | 'assistant'; text: string }[]
  nodes: { id: string; name?: string; type?: string }[]
  page: string
  behaviour: Behaviour
  selectedId?: string | null
}

export interface AiChatResult {
  reply: string
  /** Present only when the model returned a usable full behaviour, as records of the page. */
  behaviour?: Behaviour
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
    'You author UI interactions for a design tool. A page\'s behaviour is JSON:',
    '',
    '{ cells:[{name, node?:<nodeId>, scope?:"document", type, initial, formula?:<expr>, store?}],',
    '  bindings:[{node:<nodeId>, prop, expr:<expr>, item?:{as?, key?}}],',
    '  rules:[{id?, node?:<nodeId>, on:{type}, if?:<expr>, do:[{type, target?, value?}]}] }',
    'A cell is the one kind of state: a value, or a read-only formula when `formula` is set. A cell with `node` is that node\'s own;',
    'without, it is the page\'s (or the document\'s, with scope "document"). A node\'s variant set is a cell it owns with type {enum:[...]},',
    'addressed as <nodeId>.<name>. A binding makes a node property read cells;',
    'the reserved prop "repeat" repeats the node over a list (item names the loop variable) and a bare cell in "value" makes the node edit it.',
    'A rule without `node` belongs to the page (load, timer, key).',
    'Expressions are a small JS subset (member access; + - * / %; == != < > <= >=; && ||; ternary; literals; object/array literals). Use == not ===.',
    'A list cell has type {collection:"object"} and initial []. collection.append target is the list id.',
    '',
    `Trigger types: ${triggers}`,
    `Action types: ${actions}`,
    '',
    'Design nodes (id, name, type) — only reference these ids:',
    nodes || '(none)',
    '',
    'Current behaviour:',
    JSON.stringify(toText(ctx.behaviour)),
    '',
    history ? `Conversation so far:\n${history}\n` : '',
    `User request: ${ctx.request}`,
    ctx.selectedId ? `Selected node id: ${ctx.selectedId}` : '',
    '',
    'Respond with ONLY a JSON object, no prose and no markdown fences:',
    '{ "reply": "<one short sentence for the user>", "behaviour": <the FULL updated behaviour, or null if you need to ask a clarifying question> }',
    'Preserve existing entries unless the request changes them. Keep rule ids.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Minimal structural guard before we commit a model-produced behaviour. */
function looksLikeBehaviour(x: unknown): x is TextBehaviour {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return Array.isArray(o.cells) && Array.isArray(o.bindings) && Array.isArray(o.rules)
}

function parseResult(text: string, ctx: AiChatContext): AiChatResult {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    const o = JSON.parse(stripped) as { reply?: unknown; behaviour?: unknown }
    const behaviour = looksLikeBehaviour(o.behaviour) ? fromText(o.behaviour, ctx.page, ctx.behaviour) : undefined
    const reply = typeof o.reply === 'string' && o.reply.trim() ? o.reply : behaviour ? 'Done.' : stripped
    return { reply, behaviour }
  } catch {
    // Model didn't return clean JSON — surface its text as the reply.
    return { reply: text.trim() }
  }
}

const BACKEND_URL =
  (import.meta.env.VITE_AI_BACKEND_URL as string | undefined)?.trim() || 'http://localhost:8003/api/llm/v1'
const BACKEND_KEY = (import.meta.env.VITE_AI_BACKEND_KEY as string | undefined)?.trim() || ''

/**
 * The web/platform model: the backend LLM-provider facade (provider key held
 * server-side; the browser carries only our backend credential).
 */
function resolveModel() {
  const provider = createOpenAICompatible({
    name: 'penpot-ai',
    baseURL: BACKEND_URL,
    apiKey: BACKEND_KEY || undefined,
  })
  return provider.chatModel('platform')
}

/**
 * Desktop BYOK: when the user has stored a key, run the completion in the Electron
 * main process (the key never enters renderer JS). Returns null when the bridge is
 * absent (web) or no key is stored, so the caller uses the platform facade.
 */
async function byokComplete(prompt: string): Promise<string | null> {
  const chat = getDesktopChat()
  if (!chat) return null
  const status = await getKeyStore()?.getStatus()
  if (!status || Object.keys(status.keys).length === 0) return null
  const { text } = await chat.complete({ prompt })
  return text
}

export async function aiChat(ctx: AiChatContext): Promise<AiChatResult> {
  const prompt = buildPrompt(ctx)
  // Prefer the desktop BYOK path (provider call in main); otherwise stream from the
  // backend facade. Either transport failure (bad key, backend down, 401) rejects.
  const byok = await byokComplete(prompt)
  if (byok !== null) return parseResult(byok, ctx)

  const result = streamText({ model: resolveModel(), prompt })
  return parseResult(await result.text, ctx)
}
