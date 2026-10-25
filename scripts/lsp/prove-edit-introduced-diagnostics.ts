import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as registry from '../../src/services/lsp/LSPDiagnosticRegistry.js'
import { DiagnosticTrackingService, type Diagnostic, type DiagnosticFile } from '../../src/services/diagnosticTracking.js'

const ROOT = join(import.meta.dir, '..', '..')
const SERVER = 'mercury-ts'
const FILE = '/x/proj/src/app.ts'
const OTHER = '/x/proj/src/other.ts'

type Registry = typeof registry & {
  snapshotDiagnosticsBeforeWrite?: (path: string, before: string | null, after: string, docVersion: number | undefined) => void
  _writeBaselineForTesting?: (path: string) => Array<{ serverName: string; steps: number; docVersion: number | undefined }>
}
const live = registry as Registry
const snapshot = live.snapshotDiagnosticsBeforeWrite ?? (() => undefined)
const baselineOf = live._writeBaselineForTesting ?? (() => [])

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const lines = (count: number): string => Array.from({ length: count }, (_, i) => `const v${i + 1} = ${i + 1}`).join('\n') + '\n'
const insertAfter = (text: string, line: number, inserted: string[]): string => {
  const rows = text.split('\n')
  rows.splice(line, 0, ...inserted)
  return rows.join('\n')
}
const replaceLines = (text: string, from: number, to: number, replacement: string[]): string => {
  const rows = text.split('\n')
  rows.splice(from - 1, to - from + 1, ...replacement)
  return rows.join('\n')
}

const diagnostic = (line: number, severity: Diagnostic['severity'], message: string, code: string): Diagnostic => ({
  message,
  severity,
  range: { start: { line, character: 0 }, end: { line, character: 12 } },
  source: SERVER,
  code,
})
const unusedWarning = (line: number): Diagnostic => diagnostic(line, 'Warning', "'helper' is declared but its value is never read.", '6133')
const typeError = (line: number): Diagnostic => diagnostic(line, 'Error', "Type 'string' is not assignable to type 'number'.", '2322')

function publish(uri: string, diagnostics: Diagnostic[], version?: number): void {
  const file: DiagnosticFile = { uri, diagnostics }
  registry.recordPublishedReport(SERVER, file, version)
  registry.registerPendingLSPDiagnostic({ serverName: SERVER, files: [file], ...(version !== undefined ? { version } : {}) })
}
function drain(): Diagnostic[] {
  return registry.checkForLSPDiagnostics().flatMap(set => set.files.flatMap(file => file.diagnostics))
}
function writeAsTheToolsDo(path: string, before: string | null, after: string, docVersion: number | undefined): void {
  snapshot(path, before, after, docVersion)
  registry.clearDeliveredDiagnosticsForFile(`file://${path}`)
}
const shown = (items: Diagnostic[]): string => DiagnosticTrackingService.formatDiagnosticsSummary([{ uri: FILE, diagnostics: items }])
const startLines = (items: Diagnostic[]): number[] => items.map(item => item.range.start.line + 1).sort((a, b) => a - b)

section('the row: an edit at line 10 of a file carrying a warning at line 200')
registry.resetAllLSPDiagnosticState()
const v1 = lines(300)
publish(FILE, [unusedWarning(199)], 1)
const firstTurn = drain()
check('the pre-existing warning is attached once, before any edit', firstTurn.length === 1 && startLines(firstTurn)[0] === 200, shown(firstTurn))
const v2 = insertAfter(v1, 10, ['const added1 = 1', 'const added2 = 2', 'const added3 = 3', 'const added4 = 4', 'const added5 = 5'])
writeAsTheToolsDo(FILE, v1, v2, 1)
publish(FILE, [unusedWarning(204), typeError(12)], 2)
const afterEdit = drain()
check('only the diagnostic the edit introduced is attached (the error at line 13)', afterEdit.length === 1 && afterEdit[0]?.severity === 'Error' && startLines(afterEdit)[0] === 13, `attached lines ${JSON.stringify(startLines(afterEdit))}: ${shown(afterEdit)}`)
check('the warning that moved from line 200 to 205 is not told to the model as broken by this edit', !afterEdit.some(item => item.range.start.line === 204))

section('refusals: a pre-existing diagnostic never attached after an unrelated edit')
const v3 = replaceLines(v2, 150, 150, ['const v150 = 150 + 0'])
writeAsTheToolsDo(FILE, v2, v3, 2)
publish(FILE, [unusedWarning(204), typeError(12)], 3)
const afterUnrelated = drain()
check('an edit that moves no lines re-attaches neither the warning nor the already-attached error', afterUnrelated.length === 0, shown(afterUnrelated))

section('refusals: a server slower than the write yields no data, never the stale list')
const v4 = insertAfter(v3, 2, ['const early1 = 1', 'const early2 = 2'])
writeAsTheToolsDo(FILE, v3, v4, 3)
publish(FILE, [unusedWarning(204), typeError(12)], 3)
check('a publish carrying the pre-write document version is parked nowhere', registry._pendingForTesting().every(entry => !entry.uris.includes(FILE)), JSON.stringify(registry._pendingForTesting()))
check('the stale publish is not recorded as the latest report either', registry.peekLastPublishedReport(SERVER, FILE)?.file.diagnostics.length === 2 && drain().length === 0)
publish(FILE, [unusedWarning(206), typeError(14), typeError(3)], 4)
const afterSlow = drain()
check('the written version then answers with the one diagnostic the edit introduced', afterSlow.length === 1 && startLines(afterSlow)[0] === 4, `attached lines ${JSON.stringify(startLines(afterSlow))}`)

section('refusals: a publish parked before the write is dropped by the write')
registry.resetAllLSPDiagnosticState()
publish(FILE, [unusedWarning(199)])
check('the pre-write publish is parked', registry.getPendingLSPDiagnosticCount() === 1)
writeAsTheToolsDo(FILE, v1, v2, undefined)
check('the write drops it: no data for the file until the server publishes again', registry.getPendingLSPDiagnosticCount() === 0 && drain().length === 0)
publish(FILE, [unusedWarning(204)])
check('a versionless server that re-publishes the moved warning is still subtracted through the line map', drain().length === 0)

section('refusals: a diagnostic the edit removed is not reported; one inside the replaced region is')
registry.resetAllLSPDiagnosticState()
publish(FILE, [typeError(49), unusedWarning(19)], 1)
drain()
const v5 = replaceLines(replaceLines(v1, 50, 50, []), 18, 22, ['const r1 = 1', 'const r2 = 2', 'const r3 = 3', 'const r4 = 4', 'const r5 = 5'])
writeAsTheToolsDo(FILE, v1, v5, 1)
publish(FILE, [unusedWarning(19)], 2)
const afterRegion = drain()
check('the removed error at line 50 is not reported', !afterRegion.some(item => item.severity === 'Error'))
check('the warning inside the replaced region 18-22 is reported as the edit\'s own', afterRegion.length === 1 && startLines(afterRegion)[0] === 20, shown(afterRegion))

section('refusals: a second write before the server answered composes the line map')
registry.resetAllLSPDiagnosticState()
publish(FILE, [unusedWarning(199)], 1)
drain()
writeAsTheToolsDo(FILE, v1, v2, 1)
const v6 = insertAfter(v2, 100, ['const mid1 = 1', 'const mid2 = 2', 'const mid3 = 3'])
writeAsTheToolsDo(FILE, v2, v6, 2)
check('the baseline carries two steps for one unanswered report', baselineOf(FILE).some(row => row.serverName === SERVER && row.steps === 2 && row.docVersion === 2), JSON.stringify(baselineOf(FILE)))
publish(FILE, [unusedWarning(207)], 3)
check('the warning moved by both edits (200 to 208) is still pre-existing', drain().length === 0)

section('refusals: the control roads are unchanged')
registry.resetAllLSPDiagnosticState()
writeAsTheToolsDo(FILE, v1, v2, undefined)
check('a file the server never reported has no baseline', baselineOf(FILE).length === 0)
publish(FILE, [unusedWarning(204)], 1)
check('its first publish after the write is delivered as today', drain().length === 1)
publish(OTHER, [typeError(7)], 1)
check('a publish for a file never written is delivered whole', drain().length === 1)
writeAsTheToolsDo(OTHER, null, lines(3), undefined)
check('a created file takes no baseline', baselineOf(OTHER).length === 0)
publish(OTHER, [typeError(7)], 2)
check('and reports as today after the cross-turn re-arm', drain().length === 1)
const crlfBefore = lines(300).replace(/\n/g, '\r\n')
const crlfAfter = insertAfter(crlfBefore, 10, ['const added = 1\r']).replace(/\r\r\n/g, '\r\n')
registry.resetAllLSPDiagnosticState()
publish(FILE, [unusedWarning(199)], 1)
drain()
writeAsTheToolsDo(FILE, crlfBefore, crlfAfter, 1)
publish(FILE, [unusedWarning(200)], 2)
check('a CRLF file maps its lines the same way', drain().length === 0)
registry.resetAllLSPDiagnosticState()
publish(FILE, [unusedWarning(199)], 1)
drain()
const huge = 'x\n'.repeat(5_000_001)
writeAsTheToolsDo(FILE, huge, huge + 'y\n', 1)
check('a text past the servers\' 10 MB ceiling takes no baseline and reports as today', baselineOf(FILE).length === 0)

section('refusals: the baseline table is bounded to 256 files, LRU by write order')
registry.resetAllLSPDiagnosticState()
for (let i = 0; i < 257; i++) {
  const path = `/x/proj/src/many${i}.ts`
  registry.recordPublishedReport(SERVER, { uri: path, diagnostics: [typeError(0)] }, 1)
  snapshot(path, 'a\n', 'a\nb\n', 1)
}
check('the 257th write evicts the first file\'s baseline', baselineOf('/x/proj/src/many0.ts').length === 0 && baselineOf('/x/proj/src/many1.ts').length === 1 && baselineOf('/x/proj/src/many256.ts').length === 1)

section('refusals: the words the model reads are the heading it already knows')
const attachmentText = readFileSync(join(ROOT, 'src/utils/messages/attachmentText.ts'), 'utf8')
check('the attachment heading is byte-identical', attachmentText.includes('`<new-diagnostics>New diagnostics from the language server:\\n\\n${DiagnosticTrackingService.formatDiagnosticsSummary(item.files)}</new-diagnostics>`'))

section('the four write roads snapshot before the servers learn of the write, each naming its writer')
const editTool = readFileSync(join(ROOT, 'src/tools/FileEditTool/FileEditTool.ts'), 'utf8')
const writeTool = readFileSync(join(ROOT, 'src/tools/FileWriteTool/FileWriteTool.ts'), 'utf8')
const ops = readFileSync(join(ROOT, 'src/tools/LSPTool/mercuryOps.ts'), 'utf8')
const changeSet = readFileSync(join(ROOT, 'src/tools/ChangeSetTool/ChangeSetTool.ts'), 'utf8')
const astEdit = readFileSync(join(ROOT, 'src/tools/AstEditTool/AstEditTool.ts'), 'utf8')
const before = (text: string, first: string, second: string): boolean => text.indexOf(first) !== -1 && text.indexOf(first) < text.indexOf(second)
check('Edit snapshots the file before the clear and the change, as its owner', before(editTool, 'snapshotDiagnosticsBeforeWrite(expandedPath, fileExists ? freshContent : null, finalStateContent, lspManager.getDocumentVersion(expandedPath), owner)', 'clearDeliveredDiagnosticsForFile(`file://${expandedPath}`)'))
check('Write snapshots the file before the clear and the change, as its owner', before(writeTool, 'snapshotDiagnosticsBeforeWrite(expandedPath, fileExists ? normalizedContent : null, writtenContent, lspManager.getDocumentVersion(expandedPath), ownerFromToolUseContext(context))', 'clearDeliveredDiagnosticsForFile(`file://${expandedPath}`)'))
const syncBody = ops.slice(ops.indexOf('export async function syncServersAfterWrite('))
check('the shared post-write sync snapshots before its clear, as the owner it was handed', before(syncBody, 'snapshotDiagnosticsBeforeWrite(absolutePath, before, newText, manager.getDocumentVersion(absolutePath), owner)', 'clearDeliveredDiagnosticsForFile(absolutePath)'))
check('ChangeSet hands the sync the original text and its owner', changeSet.includes('syncServersAfterWrite(lspManager, landedPath, t.plannedContent, before, owner)'))
check('AstEdit hands the sync the original text and its owner', astEdit.includes('syncServersAfterWrite(lspManager, f.abs, f.after, f.before, owner)'))
check('the workspace-edit apply hands the sync the original text and its owner', ops.includes('syncServersAfterWrite(manager, w.abs, w.newText, w.create ? null : w.originalText, owner)'))

registry.resetAllLSPDiagnosticState()
if (failures > 0) {
  console.error(`\nprove-edit-introduced-diagnostics: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-edit-introduced-diagnostics: GREEN')
