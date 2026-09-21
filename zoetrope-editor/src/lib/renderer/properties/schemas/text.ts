import { z } from 'zod'
import type { PenpotNode, TextContent } from 'penpot-exporter/types'
import { patchContent, type SpanPatch } from '../../../components/RightSidePanel/Sections/text-typography'
import { plainTextOf, setPlainTextContent } from '../../../common/text-content'
import { typographyToSpanPatch } from '../../../tokens/materialize'
import { prop } from '../meta'
import type { Accessor } from '../registry'

/**
 * Text is a tree (`content`). Every property here is synthetic: it reads the
 * first span and writes all spans through `patchContent`, the same path the
 * typography panel and tokens use. Span values are stored as strings.
 */
const span = (label: string, tokenable: readonly ('typography' | 'dimension')[], unit: 'px' | 'none' = 'none') =>
  prop(z.string().optional(), { label, unit, bindable: true, tokenable, syncGroup: 'text-font-group' })

export const Text = z.object({
  content: prop(z.string().optional(), { label: 'Text', bindable: true, syncGroup: 'content-group' }),
  fontFamily: span('Font family', ['typography']),
  fontSize: span('Font size', ['typography', 'dimension'], 'px'),
  fontWeight: span('Font weight', ['typography']),
  lineHeight: span('Line height', ['typography', 'dimension']),
  letterSpacing: span('Letter spacing', ['typography', 'dimension'], 'px'),
  textCase: span('Text case', ['typography']),
  textDecoration: span('Text decoration', ['typography']),
  typography: prop(z.record(z.string(), z.string()).optional(), {
    label: 'Typography',
    type: 'object',
    bindable: false,
    tokenable: ['typography'],
    syncGroup: 'text-font-group',
  }),
})
export type Text = z.infer<typeof Text>

type TextNode = PenpotNode & { content?: TextContent }

function firstSpan(n: PenpotNode): Record<string, unknown> | undefined {
  const c = (n as TextNode).content
  return c?.children?.[0]?.children?.[0]?.children?.[0] as Record<string, unknown> | undefined
}

const spanAccessor = (key: keyof SpanPatch & string): Accessor => ({
  get: (n) => firstSpan(n)?.[key],
  set: (n, v) => ({ content: patchContent((n as TextNode).content, { span: { [key]: String(v) } }) }) as Partial<PenpotNode>,
})

export const textAccessors: Record<keyof Text, Accessor> = {
  content: {
    get: (n) => plainTextOf((n as TextNode).content),
    set: (n, v) => ({ content: setPlainTextContent((n as TextNode).content, String(v ?? '')) }) as Partial<PenpotNode>,
  },
  fontFamily: spanAccessor('fontFamily'),
  fontSize: spanAccessor('fontSize'),
  fontWeight: spanAccessor('fontWeight'),
  lineHeight: spanAccessor('lineHeight'),
  letterSpacing: spanAccessor('letterSpacing'),
  textCase: spanAccessor('textTransform'),
  textDecoration: spanAccessor('textDecoration'),
  typography: {
    get: (n) => firstSpan(n),
    set: (n, v) =>
      typeof v === 'object' && v !== null
        ? ({ content: patchContent((n as TextNode).content, { span: typographyToSpanPatch(v as Record<string, string>) }) } as Partial<PenpotNode>)
        : {},
  },
}
