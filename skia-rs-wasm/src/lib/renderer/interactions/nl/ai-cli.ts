/**
 * AI chat client (Build mode).
 *
 * We build the full prompt here — where the domain knowledge lives (nodes, current
 * IR, the trigger/action catalog, the IR schema) — stream it to the backend LLM
 * *provider* facade via the Vercel AI SDK, accumulate the reply, and parse the
 * model's `{ reply, ir }` JSON envelope back.
 *
 * The backend (`/api/llm/v1/chat/completions`, OpenAI-compatible) holds the
 * platform provider key server-side; the browser only carries our backend
 * credential. Callers (ApiSession) fall back to the offline `interpret` stub when
 * this throws (backend down / unauthorized).
 */

import { streamText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { listTriggers, listActions } from '../catalog'
import type { PageInteractions } from '../ir'
import { getDesktopChat, getKeyStore } from '../../desktop-bridge'

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
  if (!status?.hasKey) return null
  const { text } = await chat.complete({ prompt })
  return text
}

export async function aiChat(ctx: AiChatContext): Promise<AiChatResult> {
  const prompt = buildPrompt(ctx)
  // Prefer the desktop BYOK path (provider call in main); otherwise stream from the
  // backend facade. Either transport failure (bad key, backend down, 401) rejects →
  // ApiSession falls back to the offline interpreter.
  const byok = await byokComplete(prompt)
  if (byok !== null) return parseResult(byok)

  const result = streamText({ model: resolveModel(), prompt })
  return parseResult(await result.text)
}
