#!/usr/bin/env bun
// prove-drive-case-fold — Windows drive-letter case at the LSP boundary
// (field card FC-014). pyright publishes c:\… while Mercury resolves C:\…,
// so every by-path lookup missed: the pull harvest found nothing,
// post-write stabilization always timed out, and the cross-turn dedup CLEAR
// was a permanent no-op — diagnostics silently disabled with no error on
// any surface. Every registry map boundary now folds the drive letter to
// one case (a pure, platform-neutral string fold — only an ^[a-z]:[\\/]
// spelling changes). The live pyright leg is Windows-field-owed; these are
// the pure seams both sides ride.
//
//   §1 peek/record: a server-cased record answers a Mercury-cased peek.
//   §2 the dedup-clear cycle: a Mercury-cased clear re-arms a server-cased
//      delivered set (the permanent-no-op class).
//   §3 non-drive paths are untouched byte-for-byte.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'drive-case-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const registry = await import('../../src/services/lsp/LSPDiagnosticRegistry.ts')
const {
  registerPendingLSPDiagnostic,
  checkForLSPDiagnostics,
  clearDeliveredDiagnosticsForFile,
  recordPublishedReport,
  peekLastPublishedReport,
  resetAllLSPDiagnosticState,
} = registry

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const SERVER_CASED = 'c:\\Users\\me\\proj\\app.py' // what pyright publishes
const MERCURY_CASED = 'C:\\Users\\me\\proj\\app.py' // what Mercury resolves
const diag = (message: string) =>
  ({ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, message, severity: 1 }) as never

section('§1 PEEK ACROSS THE CASE SEAM')
{
  recordPublishedReport('pyright', { uri: SERVER_CASED, diagnostics: [diag('unused import')] } as never)
  const hit = peekLastPublishedReport('pyright', MERCURY_CASED)
  check('a server-cased record answers a Mercury-cased peek (FC-014)', hit !== undefined, JSON.stringify(hit ?? null))
}

section('§2 THE DEDUP-CLEAR CYCLE')
{
  resetAllLSPDiagnosticState()
  registerPendingLSPDiagnostic({ serverName: 'pyright', files: [{ uri: SERVER_CASED, diagnostics: [diag('E100 first')] } as never] })
  const first = checkForLSPDiagnostics()
  check('the first publish delivers', first.length === 1, JSON.stringify(first.map(f => f.files.length)))

  // The operator edits the file; Mercury re-arms delivery BY ITS OWN
  // spelling. At base this cleared nothing (permanent no-op).
  clearDeliveredDiagnosticsForFile(MERCURY_CASED)
  registerPendingLSPDiagnostic({ serverName: 'pyright', files: [{ uri: SERVER_CASED, diagnostics: [diag('E100 first')] } as never] })
  const second = checkForLSPDiagnostics()
  check(
    'after a Mercury-cased clear the SAME diagnostic redelivers (the clear reached the set)',
    second.length === 1 && second[0]!.files.some(f => f.diagnostics.length === 1),
    JSON.stringify(second),
  )
}

section('§3 NON-DRIVE PATHS UNTOUCHED')
{
  resetAllLSPDiagnosticState()
  const posix = '/Users/me/proj/app.py'
  recordPublishedReport('pyright', { uri: posix, diagnostics: [diag('posix')] } as never)
  check('a POSIX path round-trips byte-identically', peekLastPublishedReport('pyright', posix) !== undefined)
  check('and a case-DIFFERENT posix path is a different file (no over-folding)', peekLastPublishedReport('pyright', '/users/me/proj/app.py') === undefined)
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-drive-case-fold: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-drive-case-fold: all green')
