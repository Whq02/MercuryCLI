import type * as TS from 'typescript'
import { type LspPosition, offsetAt, spanToRange, fromUri } from '../lsp.js'
import { FORMAT_OPTIONS } from '../convert.js'
import type { RequireState } from '../needs.js'

export function formattingRequest(params: unknown, requireState: RequireState): unknown {
  const st = requireState()
  const p = params as {
    textDocument: { uri: string }
    options?: { tabSize?: number; insertSpaces?: boolean }
  }
  const file = st.normalize(fromUri(p.textDocument.uri))
  const text = st.textOf(file)
  if (text === undefined) return []
  const project = st.projectFor(file)
  const settings: TS.FormatCodeSettings = {
    ...FORMAT_OPTIONS,
    indentSize: p.options?.tabSize ?? FORMAT_OPTIONS.indentSize,
    tabSize: p.options?.tabSize ?? FORMAT_OPTIONS.tabSize,
    convertTabsToSpaces: p.options?.insertSpaces ?? true,
  }
  const edits = project.service.getFormattingEditsForDocument(file, settings)
  return edits.map(e => ({
    range: spanToRange(text, e.span.start, e.span.length),
    newText: e.newText,
  }))
}

export function rangeFormattingRequest(params: unknown, requireState: RequireState): unknown {
  const st = requireState()
  const p = params as {
    textDocument: { uri: string }
    range: { start: LspPosition; end: LspPosition }
    options?: { tabSize?: number; insertSpaces?: boolean }
  }
  const file = st.normalize(fromUri(p.textDocument.uri))
  const text = st.textOf(file)
  if (text === undefined) return []
  const project = st.projectFor(file)
  const settings: TS.FormatCodeSettings = {
    ...FORMAT_OPTIONS,
    indentSize: p.options?.tabSize ?? FORMAT_OPTIONS.indentSize,
    tabSize: p.options?.tabSize ?? FORMAT_OPTIONS.tabSize,
    convertTabsToSpaces: p.options?.insertSpaces ?? true,
  }
  const edits = project.service.getFormattingEditsForRange(
    file,
    offsetAt(text, p.range.start),
    offsetAt(text, p.range.end),
    settings,
  )
  return edits.map(e => ({
    range: spanToRange(text, e.span.start, e.span.length),
    newText: e.newText,
  }))
}
