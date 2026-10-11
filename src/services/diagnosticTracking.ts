import figures from 'figures'
import { GLYPH } from '../components/mercury-ui/glyphs.js'

export interface Diagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}

const SUMMARY_CHAR_CAP = 4000
const TRUNCATION_MARKER = '… [diagnostics truncated]'

const SEVERITY_SYMBOLS: ReadonlyMap<string, string> = new Map<Diagnostic['severity'], string>([
  ['Error', figures.cross],
  ['Warning', GLYPH.warn],
  ['Info', GLYPH.info],
  ['Hint', figures.star],
])

const fileLabel = (uri: string): string => {
  const segments = uri.split('/')
  return segments.length > 1 ? segments[segments.length - 1]! : uri
}

const diagnosticLine = ({ severity, range, message, code, source }: Diagnostic): string =>
  [
    `  ${DiagnosticTrackingService.getSeveritySymbol(severity)} [${range.start.line + 1}:${range.start.character + 1}] ${message}`,
    code !== undefined ? ` [${code}]` : '',
    source !== undefined ? ` (${source})` : '',
  ].join('')

const fileSection = (file: DiagnosticFile): string => [`${fileLabel(file.uri)}:`, ...file.diagnostics.map(diagnosticLine)].join('\n')

const capped = (summary: string): string =>
  summary.length <= SUMMARY_CHAR_CAP ? summary : summary.slice(0, SUMMARY_CHAR_CAP - TRUNCATION_MARKER.length) + TRUNCATION_MARKER

export class DiagnosticTrackingService {
  static getSeveritySymbol(severity: string): string {
    return SEVERITY_SYMBOLS.get(severity) ?? figures.bullet
  }

  static formatDiagnosticsSummary(files: DiagnosticFile[]): string {
    return capped(files.map(fileSection).join('\n\n'))
  }
}
