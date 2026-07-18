/**
 * ShaderCodeEditor — the code pane, language-agnostic.
 *
 * It knows nothing about SkSL. It takes a `ShaderLanguage` (for the grammar and
 * the static completion vocabulary) and a list of `ShaderDiagnostic`s (computed
 * elsewhere, by the same debounced compile that feeds the uniform controls), and
 * renders CodeMirror with highlighting + inline underlines + autocomplete.
 * Swapping SkSL→GLSL is a different provider, not a different editor.
 *
 * Diagnostics are *pushed* in via `setDiagnostics`, not computed by a CodeMirror
 * linter source: the real compiler already ran, so re-running a linter here
 * would just duplicate it. CodeMirror maps the pushed ranges through subsequent
 * edits, so they track the text until the next compile.
 *
 * Autocomplete merges the language's fixed vocabulary with the identifiers the
 * author has declared in the source — the language scans the live document for
 * them (`language.symbols`), so a just-declared name is completable immediately,
 * without waiting on a compile. The completion source reads the current document
 * at call time, so the CodeMirror extension is built once and never reconfigured.
 */

import { useEffect, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import type { EditorView } from '@codemirror/view'
import type { Text } from '@codemirror/state'
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import type { ShaderDiagnostic, ShaderLanguage } from '../../renderer/shader-lang'
import { buildCompletionOptions } from './shader-completion'

/** Map language-neutral (1-based line/column) diagnostics to CM offsets. */
function toCmDiagnostics(doc: Text, diagnostics: ShaderDiagnostic[]): Diagnostic[] {
  return diagnostics.map((d) => {
    const lineNo = Math.min(Math.max(d.line, 1), doc.lines)
    const line = doc.line(lineNo)
    const from = d.column != null ? Math.min(line.from + (d.column - 1), line.to) : line.from
    const rawTo = d.endColumn != null ? line.from + (d.endColumn - 1) : line.to
    const to = Math.min(Math.max(rawTo, from + 1), doc.length)
    return { from, to, severity: d.severity, message: d.message }
  })
}

export interface ShaderCodeEditorProps {
  language: ShaderLanguage
  value: string
  onChange: (value: string) => void
  diagnostics: ShaderDiagnostic[]
  className?: string
}

export function ShaderCodeEditor({
  language,
  value,
  onChange,
  diagnostics,
  className,
}: ShaderCodeEditorProps) {
  const viewRef = useRef<EditorView | null>(null)

  // One completion source per language, rebuilt only if the language changes.
  // It scans the live document at call time (via `language.symbols`) so an
  // identifier completes the moment it's declared — no editor reconfigure, no
  // wait on a compile.
  const completionExt = useRef<ReturnType<typeof autocompletion> | null>(null)
  const completionLang = useRef<ShaderLanguage | null>(null)
  if (completionLang.current !== language) {
    completionLang.current = language
    const source = (ctx: CompletionContext): CompletionResult | null => {
      const word = ctx.matchBefore(/[\w]+/)
      // Nothing typed and not an explicit trigger (Ctrl-Space) ⇒ don't pop up.
      if (!word || (word.from === word.to && !ctx.explicit)) return null
      const declared = language.symbols(ctx.state.doc.toString())
      return {
        from: word.from,
        options: buildCompletionOptions(declared, language.completions),
        validFor: /^[\w]*$/,
      }
    }
    completionExt.current = autocompletion({ override: [source], icons: true })
  }

  // Push the latest diagnostics into the live editor whenever they change.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, diagnostics)))
  }, [diagnostics])

  return (
    <CodeMirror
      value={value}
      height="100%"
      className={className}
      onChange={onChange}
      onCreateEditor={(view) => {
        viewRef.current = view
        // Seed diagnostics that arrived before the editor mounted.
        view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, diagnostics)))
      }}
      extensions={[language.highlight(), lintGutter(), completionExt.current!]}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: false,
        foldGutter: false,
        // We supply our own completion source (above); keep basicSetup from
        // adding a second, word-based one.
        autocompletion: false,
      }}
    />
  )
}
