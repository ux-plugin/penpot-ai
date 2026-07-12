/**
 * CodeBlock — a styled, syntax-highlighted code section (like a markdown fence):
 * a bordered card with a header (label + copy) and a scrollable, highlighted body.
 *
 * The highlighter is a zero-dependency lightweight tokenizer: one regex splits the
 * source into comment / string / tag / keyword / number / attribute / punctuation
 * spans, coloured with Tailwind tokens (light + dark). It targets the generated
 * TSX we show (JSX + a little JS), not arbitrary code — good enough to read well.
 */

import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'

type TokenKind = 'comment' | 'string' | 'tag' | 'keyword' | 'number' | 'attr' | 'punct' | 'text'

const TOKEN_CLASS: Record<TokenKind, string> = {
  comment: 'text-muted-foreground italic',
  string: 'text-emerald-600 dark:text-emerald-400',
  tag: 'text-sky-600 dark:text-sky-400',
  keyword: 'text-violet-600 dark:text-violet-400',
  number: 'text-amber-600 dark:text-amber-400',
  attr: 'text-orange-600 dark:text-orange-400',
  punct: 'text-muted-foreground',
  text: '',
}

// Ordered alternation — first matching alternative wins, so `tag` beats `punct`
// on `<`, and `keyword` beats `attr` on `=>`. Named groups double as the token kind.
const TOKEN_RE =
  /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?<tag><\/?[A-Za-z][\w.]*|\/?>)|(?<keyword>\b(?:export|default|function|return|const|let|var|import|from|new|typeof|async|await|if|else|for|while|switch|case|break|continue|class|extends|true|false|null|undefined|of|in)\b|=>)|(?<number>\b\d[\d.]*\b)|(?<attr>[A-Za-z_][\w-]*(?=\s*=))|(?<punct>[{}()[\].,;:=<>/&|?!+\-*%]+)/g

interface Token {
  text: string
  kind: TokenKind
}

function tokenize(code: string): Token[] {
  const out: Token[] = []
  let last = 0
  for (const m of code.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ text: code.slice(last, idx), kind: 'text' })
    const groups = m.groups ?? {}
    const kind = (Object.keys(groups).find((k) => groups[k] != null) as TokenKind | undefined) ?? 'text'
    out.push({ text: m[0], kind })
    last = idx + m[0].length
  }
  if (last < code.length) out.push({ text: code.slice(last), kind: 'text' })
  return out
}

/**
 * Pretty-print the generated JSX: line-break + indent at tag boundaries. String-
 * and comment-aware, and only inserts whitespace, so the highlighted (and copied)
 * code stays valid and semantically identical.
 */
function formatCode(code: string): string {
  let out = ''
  let indent = 0
  let i = 0
  let base = ''
  let seenTag = false
  const n = code.length
  const nl = (): string => '\n' + base + '  '.repeat(Math.max(0, indent))
  const trimTail = (): void => {
    out = out.replace(/[ \t\n]*$/, '')
  }
  while (i < n) {
    const c = code[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += c
      i++
      while (i < n) {
        out += code[i]
        if (code[i] === '\\') {
          out += code[i + 1] ?? ''
          i += 2
          continue
        }
        if (code[i] === q) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') {
        out += code[i]
        i++
      }
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      out += '/*'
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i]
        i++
      }
      out += '*/'
      i += 2
      continue
    }
    if (c === '<' && code[i + 1] === '/') {
      indent = Math.max(0, indent - 1)
      seenTag = true
      trimTail()
      out += nl() + '</'
      i += 2
      while (i < n && code[i] !== '>') {
        out += code[i]
        i++
      }
      if (i < n) {
        out += '>'
        i++
      }
      continue
    }
    if (c === '<' && /[A-Za-z]/.test(code[i + 1] ?? '')) {
      if (!seenTag) {
        const lead = out.slice(out.lastIndexOf('\n') + 1)
        base = /^[ \t]*$/.test(lead) ? lead : ''
        seenTag = true
        out += '<'
      } else {
        trimTail()
        out += nl() + '<'
      }
      i++
      let brace = 0
      let localStr: string | null = null
      let selfClose = false
      while (i < n) {
        const d = code[i]
        if (localStr) {
          out += d
          if (d === '\\') {
            out += code[i + 1] ?? ''
            i += 2
            continue
          }
          if (d === localStr) localStr = null
          i++
          continue
        }
        if (d === '"' || d === "'" || d === '`') {
          localStr = d
          out += d
          i++
          continue
        }
        if (d === '{') {
          brace++
          out += d
          i++
          continue
        }
        if (d === '}') {
          brace = Math.max(0, brace - 1)
          out += d
          i++
          continue
        }
        if (brace === 0 && d === '/' && code[i + 1] === '>') {
          selfClose = true
          i += 2
          break
        }
        if (brace === 0 && d === '>') {
          i++
          break
        }
        out += d
        i++
      }
      out += selfClose ? ' />' : '>'
      if (!selfClose) indent++
      continue
    }
    out += c
    i++
  }
  return out
}

export interface CodeBlockProps {
  code: string
  /** Small header label (e.g. a scope or language). Defaults to "tsx". */
  label?: string
  className?: string
}

export function CodeBlock({ code, label = 'tsx', className }: CodeBlockProps) {
  const formatted = useMemo(() => formatCode(code), [code])
  const tokens = useMemo(() => tokenize(formatted), [formatted])
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard?.writeText(formatted).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div
      className={['flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/40', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-3 py-1.5">
        <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{label}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="m-0 min-h-0 flex-1 overflow-auto p-3 text-[11px] leading-relaxed text-foreground"
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      >
        <code>
          {tokens.map((t, i) =>
            t.kind === 'text' ? (
              t.text
            ) : (
              <span key={i} className={TOKEN_CLASS[t.kind]}>
                {t.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  )
}
