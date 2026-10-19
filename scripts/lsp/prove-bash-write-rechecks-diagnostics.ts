import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as registry from '../../src/services/lsp/LSPDiagnosticRegistry.js'
import type { Diagnostic, DiagnosticFile } from '../../src/services/diagnosticTracking.js'

const ROOT = join(import.meta.dir, '..', '..')
const SERVER = 'mercury-ts'
const FILE = '/x/proj/src/app.ts'

type Registry = typeof registry & {
  noteOutOfBandWrite?: (path: string, versions: ReadonlyArray<{ serverName: string; docVersion: number }>) => void
}
const live = registry as Registry
const attachments = (await import('../../src/utils/attachments/diagnostics.ts').catch(() => null)) as { deliverAfterRevalidation?: (resynced: readonly string[], deadlineMs?: number) => Promise<Array<{ type: string; files: DiagnosticFile[] }>>; awaitFreshReports?: (resynced: readonly string[], deadlineMs?: number) => Promise<string[]> } | null

let failures = 0
let count = 0
function check(name: string, ok: boolean, detail = ''): void {
  count++
  if (ok) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const diagnostic = (line: number, message: string, code: string): Diagnostic => ({ message, severity: 'Error', range: { start: { line, character: 0 }, end: { line, character: 12 } }, source: SERVER, code })
const cannotFind = (line: number, name: string): Diagnostic => diagnostic(line, `Cannot find name '${name}'.`, '2304')
function publish(uri: string, diagnostics: Diagnostic[], version?: number): void {
  const file: DiagnosticFile = { uri, diagnostics }
  registry.recordPublishedReport(SERVER, file, version)
  registry.registerPendingLSPDiagnostic({ serverName: SERVER, files: [file], ...(version !== undefined ? { version } : {}) })
}
const drain = (): Diagnostic[] => registry.checkForLSPDiagnostics().flatMap(set => set.files.flatMap(file => file.diagnostics))
const messagesOf = (rows: Array<{ files: DiagnosticFile[] }>): string[] => rows.flatMap(row => row.files.flatMap(file => file.diagnostics.map(d => d.message)))

section('§1 the registry: a publish made on the text before a Bash write never reaches the model (the field row M39-04, .38 leg)')
registry.resetAllLSPDiagnosticState()
publish(`file://${FILE}`, [cannotFind(4, 'helper')], 3)
check('the stale publish is parked for delivery before the write is known', registry._pendingForTesting().some(entry => entry.uris.includes(`file://${FILE}`)), j(registry._pendingForTesting()))
live.noteOutOfBandWrite?.(FILE, [{ serverName: SERVER, docVersion: 3 }])
check('a write outside the tools drops the parked publish for that file', !registry._pendingForTesting().some(entry => entry.uris.includes(`file://${FILE}`)), j(registry._pendingForTesting()))
publish(`file://${FILE}`, [cannotFind(4, 'helper')], 3)
check('a late publish of the old document version is ignored', drain().length === 0, j(registry._pendingForTesting()))
publish(`file://${FILE}`, [], 4)
check('the clean publish of the re-synced version is the report (no stale "Cannot find name")', drain().length === 0 && registry.peekLastPublishedReport(SERVER, FILE)?.file.diagnostics.length === 0, j(registry.peekLastPublishedReport(SERVER, FILE)))
publish(`file://${FILE}`, [diagnostic(9, "Type 'string' is not assignable to type 'number'.", '2322')], 5)
check('a real error on the re-synced text still reaches the model', drain().map(d => d.message).join('|') === "Type 'string' is not assignable to type 'number'.", '')

section('§2 the delivery waits for the fresh report of a re-synced file, bounded')
registry.resetAllLSPDiagnosticState()
{
  publish(`file://${FILE}`, [cannotFind(4, 'helper')], 3)
  live.noteOutOfBandWrite?.(FILE, [{ serverName: SERVER, docVersion: 3 }])
  const started = Date.now()
  const pending = attachments?.deliverAfterRevalidation?.([FILE], 2_000)
  setTimeout(() => publish(`file://${FILE}`, [diagnostic(9, 'Property \'push\' does not exist on type \'never\'.', '2339')], 4), 120)
  const rows = pending === undefined ? null : await pending
  const waited = Date.now() - started
  check('the attachment carries the fresh report, delivered when it arrived (not the stale set, not the whole deadline)', rows !== null && messagesOf(rows).join('|') === "Property 'push' does not exist on type 'never'." && waited < 1_500, `${j(rows)} after ${waited} ms`)
  registry.resetAllLSPDiagnosticState()
  const quietStart = Date.now()
  const quiet = attachments?.deliverAfterRevalidation?.([FILE], 150)
  const quietRows = quiet === undefined ? null : await quiet
  check('with no report inside the deadline nothing stale is attached and the wait is the deadline', quietRows !== null && quietRows.length === 0 && Date.now() - quietStart >= 140, j(quietRows))
  const none = attachments?.deliverAfterRevalidation?.([], 2_000)
  const noneStart = Date.now()
  const noneRows = none === undefined ? null : await none
  check('with nothing re-synced the delivery does not wait', noneRows !== null && Date.now() - noneStart < 100, '')
}

section('§3 the manager tells the registry about a re-sync, with the document versions it knew')
{
  const manager = readFileSync(join(ROOT, 'src/services/lsp/LSPServerManager.ts'), 'utf8')
  check('revalidateOpenDocuments notes the out-of-band write after the change reaches the servers', manager.includes('noteOutOfBandWrite(path, versions)') && manager.indexOf('await changeFile(path, text)') < manager.indexOf('noteOutOfBandWrite(path, versions)'), '')
  const road = readFileSync(join(ROOT, 'src/utils/attachments/diagnostics.ts'), 'utf8')
  check('the attachment road delivers after the revalidation report, waiting on the re-synced files', road.includes('deliverAfterRevalidation(resynced)'), '')
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('BASH WRITE RECHECKS DIAGNOSTICS RED')
  process.exit(1)
}
console.log('BASH WRITE RECHECKS DIAGNOSTICS GREEN')
