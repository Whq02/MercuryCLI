// prove-lsp-diag-dedup — pins the audit fix on the passive-diagnostics
// dedup re-arm: clearDeliveredDiagnosticsForFile must clear regardless of
// key form. The registry stores PLAIN paths (formatDiagnosticsForAttachment
// converts URIs) while FileEditTool/FileWriteTool clear with `file://${abs}`
// — before the fix those clears NO-OPed, so an identical diagnostic
// re-introduced after an edit was silently swallowed by cross-turn dedup
// (the model never saw the compiler complain again).

import {
  checkForLSPDiagnostics,
  clearDeliveredDiagnosticsForFile,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from '../../src/services/lsp/LSPDiagnosticRegistry.js'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const FILE = '/x/proj/src/a.ts' // plain-path key, as the passive pipeline stores it
const diag = {
  message: "Type 'string' is not assignable to type 'number'.",
  severity: 'Error' as const,
  range: { start: { line: 4, character: 6 }, end: { line: 4, character: 15 } },
  source: 'mercury-ts',
  code: '2322',
}
function push(): void {
  registerPendingLSPDiagnostic({
    serverName: 'mercury-ts',
    files: [{ uri: FILE, diagnostics: [diag] }],
  })
}
function deliveredCount(): number {
  const sets = checkForLSPDiagnostics()
  return sets.reduce(
    (n, s) => n + s.files.reduce((m, f) => m + f.diagnostics.length, 0),
    0,
  )
}

resetAllLSPDiagnosticState()

push()
check('first delivery lands', deliveredCount() === 1)
push()
check('identical re-push is cross-turn deduped (baseline behavior)', deliveredCount() === 0)

// The Edit/Write tools' historical call shape — MUST re-arm delivery.
clearDeliveredDiagnosticsForFile(`file://${FILE}`)
push()
check('clear via file:// form re-arms delivery (the audit fix)', deliveredCount() === 1)

// Plain form keeps working too.
push()
check('deduped again before plain clear', deliveredCount() === 0)
clearDeliveredDiagnosticsForFile(FILE)
push()
check('clear via plain path re-arms delivery', deliveredCount() === 1)

resetAllLSPDiagnosticState()

if (failures > 0) {
  console.error(`prove-lsp-diag-dedup: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-diag-dedup: GREEN')
