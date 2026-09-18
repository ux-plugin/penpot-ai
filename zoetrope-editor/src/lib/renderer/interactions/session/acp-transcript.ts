/**
 * ACP transcript model + reducer.
 *
 * Folds streamed ACP `session/update` bodies into an ordered list of transcript items
 * (user/assistant/thought/tool/plan). Kept separate from the view so the chat-sessions
 * store can accumulate a chat's transcript in the BACKGROUND — even while another chat is
 * on screen — and persist it. The view is then a pure render of the stored items.
 */

import type { AcpUpdateBody } from '../../desktop-bridge'

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; id: string; title: string; toolKind?: string; status: string }
  | { kind: 'plan'; entries: { content: string; status: string }[] }

/** Fold one streamed update into the transcript, returning a new array. */
export function reduceTranscript(items: TranscriptItem[], u: AcpUpdateBody): TranscriptItem[] {
  const next = items.slice()
  const last = next[next.length - 1]
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const t = u.content?.text ?? ''
      if (last?.kind === 'assistant') next[next.length - 1] = { ...last, text: last.text + t }
      else next.push({ kind: 'assistant', text: t })
      return next
    }
    case 'agent_thought_chunk': {
      const t = u.content?.text ?? ''
      if (last?.kind === 'thought') next[next.length - 1] = { ...last, text: last.text + t }
      else next.push({ kind: 'thought', text: t })
      return next
    }
    case 'tool_call': {
      next.push({
        kind: 'tool',
        id: u.toolCallId ?? String(next.length),
        title: u.title ?? 'Tool call',
        toolKind: u.kind,
        status: u.status ?? 'pending',
      })
      return next
    }
    case 'tool_call_update': {
      const i = next.findIndex((it) => it.kind === 'tool' && it.id === u.toolCallId)
      if (i >= 0) {
        const t = next[i] as Extract<TranscriptItem, { kind: 'tool' }>
        next[i] = { ...t, status: u.status ?? t.status, title: u.title ?? t.title }
      }
      return next
    }
    case 'plan': {
      const entries = (u.entries ?? []).map((e) => ({ content: e.content, status: e.status }))
      if (last?.kind === 'plan') next[next.length - 1] = { kind: 'plan', entries }
      else next.push({ kind: 'plan', entries })
      return next
    }
    default:
      return items
  }
}
