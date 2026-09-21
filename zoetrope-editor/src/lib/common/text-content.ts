/**
 * Plain-text view of a Penpot text content tree. Pure, no store access —
 * shared by component props, the property registry and codegen.
 */
import type { TextContent } from 'penpot-exporter/types'

/** All runs joined, paragraphs separated by newlines. */
export function plainTextOf(content: TextContent | undefined): string {
  const paragraphs = content?.children?.flatMap((set) => set.children ?? []) ?? []
  return paragraphs.map((p) => (p.children ?? []).map((s) => s.text ?? '').join('')).join('\n')
}

/**
 * Rewrite a text node's content to a plain string, keeping the first run's
 * styling.
 *
 * A text prop makes its target a single-run label — extra runs and paragraphs
 * are dropped rather than preserved with stale text. That is the honest reading
 * of "this node's text is a parameter": if it needs rich internal structure, it
 * is not a parameter.
 */
export function setPlainTextContent(content: TextContent | undefined, value: string): TextContent {
  const asRecord = content as unknown as Record<string, unknown> | undefined
  const paragraphSet = (asRecord?.children as Array<Record<string, unknown>> | undefined)?.[0]
  const paragraph = (paragraphSet?.children as Array<Record<string, unknown>> | undefined)?.[0]
  const firstRun = (paragraph?.children as Array<Record<string, unknown>> | undefined)?.[0]

  return {
    ...(asRecord ?? { type: 'root', verticalAlign: 'top' }),
    type: 'root',
    children: [
      {
        ...(paragraphSet ?? {}),
        type: 'paragraph-set',
        children: [
          {
            ...(paragraph ?? {}),
            type: 'paragraph',
            children: [{ ...(firstRun ?? {}), type: 'text', text: value }],
          },
        ],
      },
    ],
  } as unknown as TextContent
}
