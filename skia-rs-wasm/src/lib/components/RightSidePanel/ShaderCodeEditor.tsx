/**
 * ShaderCodeEditor — the code pane, language-agnostic.
 *
 * It knows nothing about SkSL. It takes a `ShaderLanguage` (for the grammar)
 * and a list of `ShaderDiagnostic`s (computed elsewhere, by the same debounced
 * compile that feeds the uniform controls), and renders CodeMirror with
 * highlighting + inline underlines. Swapping SkSL→GLSL is a different provider,
 * not a different editor.
 *
 * Diagnostics are *pushed* in via `setDiagnostics`, not computed by a CodeMirror
 * linter source: the real compiler already ran, so re-running a linter here
 * would just duplicate it. CodeMirror maps the pushed ranges through subsequent
 * edits, so they track the text until the next compile.
 */

import { useEffect, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import type { EditorView } from '@codemirror/view'
import type { Text } from '@codemirror/state'
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import type { ShaderDiagnostic, ShaderLanguage } from '../../renderer/shader-lang'

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
      extensions={[language.highlight(), lintGutter()]}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: false,
        foldGutter: false,
        autocompletion: false,
      }}
    />
  )
}
