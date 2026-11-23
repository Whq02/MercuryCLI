import { fileURLToPath, pathToFileURL } from 'node:url'
import type * as TS from 'typescript'

export type TsModule = typeof TS

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  uri: string
  range: LspRange
}

export interface LspTextEdit {
  range: LspRange
  newText: string
}

export interface LspDiagnostic {
  range: LspRange
  severity: number
  code?: number | string
  source: string
  message: string
}

export interface LspDocumentSymbol {
  name: string
  kind: number
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}

export interface LspCallHierarchyItem {
  name: string
  kind: number
  uri: string
  range: LspRange
  selectionRange: LspRange
  detail?: string
}

export interface LspCodeAction {
  title: string
  kind: string
  diagnostics?: LspDiagnostic[]
  edit?: { changes: Record<string, LspTextEdit[]> }
  data?: unknown
}

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 10) starts.push(i + 1)
    else if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i++
      starts.push(i + 1)
    }
  }
  return starts
}

export function offsetAt(text: string, pos: LspPosition): number {
  const starts = lineStartsOf(text)
  if (pos.line >= starts.length) return text.length
  const lineStart = starts[pos.line] ?? text.length
  let lineEnd = pos.line + 1 < starts.length ? (starts[pos.line + 1] ?? text.length) : text.length
  while (lineEnd > lineStart && (text[lineEnd - 1] === '\n' || text[lineEnd - 1] === '\r')) lineEnd--
  return Math.min(lineStart + Math.max(0, pos.character), lineEnd)
}

export function positionAt(text: string, offset: number): LspPosition {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const starts = lineStartsOf(text)
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((starts[mid] ?? 0) <= clamped) lo = mid
    else hi = mid - 1
  }
  return { line: lo, character: clamped - (starts[lo] ?? 0) }
}

export function spanToRange(text: string, start: number, length: number): LspRange {
  return {
    start: positionAt(text, start),
    end: positionAt(text, start + length),
  }
}

export function toUri(file: string): string {
  return pathToFileURL(file).href
}

export function fromUri(uri: string): string {
  return uri.startsWith('file://') ? fileURLToPath(uri) : uri
}

export function symbolKindOf(kind: string): number {
  switch (kind) {
    case 'module':
      return 2
    case 'class':
    case 'local class':
    case 'type':
      return 5
    case 'method':
      return 6
    case 'property':
    case 'getter':
    case 'setter':
      return 7
    case 'constructor':
      return 9
    case 'enum':
      return 10
    case 'interface':
      return 11
    case 'function':
    case 'local function':
      return 12
    case 'var':
    case 'let':
    case 'local var':
    case 'alias':
    case 'parameter':
      return 13
    case 'const':
      return 14
    case 'enum member':
      return 22
    case 'type parameter':
      return 26
    default:
      return 13
  }
}

export function diagnosticSeverityOf(ts: TsModule, cat: TS.DiagnosticCategory): number {
  switch (cat) {
    case ts.DiagnosticCategory.Error:
      return 1
    case ts.DiagnosticCategory.Warning:
      return 2
    case ts.DiagnosticCategory.Message:
      return 3
    default:
      return 4
  }
}
