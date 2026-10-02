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

export class DiagnosticTrackingService {
  static getSeveritySymbol(severity: string): string {
    switch (severity) {
      case 'Error':
        return figures.cross
      case 'Warning':
        return GLYPH.warn
      case 'Info':
        return GLYPH.info
      case 'Hint':
        return figures.star
      default:
        return figures.bullet
    }
  }

  static formatDiagnosticsSummary(files: DiagnosticFile[]): string {
    const sections: string[] = []
    for (const file of files) {
      const segments = file.uri.split('/')
      const name = segments.length > 1 ? segments[segments.length - 1] : file.uri
      const lines = [`${name}:`]
      for (const diagnostic of file.diagnostics) {
        const position = `[${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}]`
        let line = `  ${DiagnosticTrackingService.getSeveritySymbol(diagnostic.severity)} ${position} ${diagnostic.message}`
        if (diagnostic.code !== undefined) line += ` [${diagnostic.code}]`
        if (diagnostic.source !== undefined) line += ` (${diagnostic.source})`
        lines.push(line)
      }
      sections.push(lines.join('\n'))
    }
    const summary = sections.join('\n\n')
    if (summary.length <= SUMMARY_CHAR_CAP) return summary
    return summary.slice(0, SUMMARY_CHAR_CAP - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
  }
}
