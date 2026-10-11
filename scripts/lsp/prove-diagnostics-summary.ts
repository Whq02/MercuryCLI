#!/usr/bin/env bun
// gate-watch: src/services/diagnosticTracking.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import figures from 'figures'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const j = (v: unknown): string => JSON.stringify(v)

const { DiagnosticTrackingService } = await import('../../src/services/diagnosticTracking.ts')
const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.ts')
type File = import('../../src/services/diagnosticTracking.ts').DiagnosticFile
const at = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 1 } })

console.log('the severity symbols')
check('Error, Warning, Info, Hint wear their glyphs', [DiagnosticTrackingService.getSeveritySymbol('Error'), DiagnosticTrackingService.getSeveritySymbol('Warning'), DiagnosticTrackingService.getSeveritySymbol('Info'), DiagnosticTrackingService.getSeveritySymbol('Hint')].join('|') === [figures.cross, GLYPH.warn, GLYPH.info, figures.star].join('|'))
check('an unknown severity wears the bullet', DiagnosticTrackingService.getSeveritySymbol('Nope') === figures.bullet && DiagnosticTrackingService.getSeveritySymbol('toString') === figures.bullet)

console.log('the summary the model reads')
const files: File[] = [
  { uri: 'file:///repo/src/a.ts', diagnostics: [{ message: 'unused x', severity: 'Warning', range: at(0, 4), code: 'TS6133', source: 'ts' }, { message: 'bad', severity: 'Error', range: at(9, 0) }] },
  { uri: 'bare', diagnostics: [{ message: 'hint', severity: 'Hint', range: at(2, 2), source: 'eslint' }] },
]
const summary = DiagnosticTrackingService.formatDiagnosticsSummary(files)
const expected = [`a.ts:`, `  ${GLYPH.warn} [1:5] unused x [TS6133] (ts)`, `  ${figures.cross} [10:1] bad`, '', 'bare:', `  ${figures.star} [3:3] hint (eslint)`].join('\n')
check('files are headed by their last path segment, one indented line per diagnostic with 1-based positions, code and source when set, sections a blank line apart', summary === expected, j(summary))
check('no files makes an empty summary', DiagnosticTrackingService.formatDiagnosticsSummary([]) === '')
check('a file with no diagnostics is its heading alone', DiagnosticTrackingService.formatDiagnosticsSummary([{ uri: 'x/y.ts', diagnostics: [] }]) === 'y.ts:')
const long = DiagnosticTrackingService.formatDiagnosticsSummary([{ uri: 'big.ts', diagnostics: Array.from({ length: 400 }, (_, i) => ({ message: `line ${i} ${'m'.repeat(20)}`, severity: 'Info' as const, range: at(i, 0) })) }])
check('a summary past 4000 characters is cut to 4000 and ends with the truncation marker', long.length === 4000 && long.endsWith('… [diagnostics truncated]'), String(long.length))

console.log(failures === 0 ? '\nprove-diagnostics-summary: ALL PASS' : `\nprove-diagnostics-summary: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
