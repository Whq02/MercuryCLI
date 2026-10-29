import {
  checkForLSPDiagnostics,
  clearDeliveredDiagnosticsForFile,
  registerPendingLSPDiagnostic,
  resetAllLSPDiagnosticState,
} from '../../src/services/lsp/LSPDiagnosticRegistry.js'

import { registerLSPNotificationHandlers } from '../../src/services/lsp/passiveFeedback.js'
let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const FILE = '/x/proj/src/a.ts'
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

clearDeliveredDiagnosticsForFile(`file://${FILE}`)
push()
check('clear via file:// form re-arms delivery (the audit fix)', deliveredCount() === 1)

push()
check('deduped again before plain clear', deliveredCount() === 0)
clearDeliveredDiagnosticsForFile(FILE)
push()
check('clear via plain path re-arms delivery', deliveredCount() === 1)

resetAllLSPDiagnosticState()

let publish: (params: unknown) => void = () => {}
registerLSPNotificationHandlers({ getAllServers: () => new Map([['fake', { onNotification: (_method: string, handler: (params: unknown) => void) => { publish = handler } }]]) } as never)
publish({ uri: FILE, diagnostics: [{ ...diag, severity: 1 }] })
publish({ uri: FILE, diagnostics: [] })
check('a clean publish supersedes an undelivered error from the same server and file', deliveredCount() === 0)
resetAllLSPDiagnosticState()

if (failures > 0) {
  console.error(`prove-lsp-diag-dedup: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-diag-dedup: GREEN')
