
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LSP = '1'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(name: string, ok: boolean, detail?: string, fixHint?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}${fixHint ? ` — fix: ${fixHint}` : ''}`)
  }
}

console.log('prove-lsp-contract')

console.log(' §1 schemas — meaningful parameters only')
const { lspInputSchema, readArgumentError, readArguments } = await import('../../src/tools/lsp/schemas.js')
const schema = lspInputSchema('LspRead')
{
  const ok = (v: unknown): boolean => {
    const parsed = schema.safeParse(v)
    return parsed.success && readArgumentError(parsed.data) === undefined
  }
  const kept = (v: Record<string, unknown>): string[] => Object.keys(readArguments((schema.safeParse(v) as { data?: Record<string, unknown> }).data ?? {}))
  check('documentSymbol: filePath alone is valid', ok({ operation: 'documentSymbol', filePath: 'a.ts' }), undefined, 'lspInputSchema or readArgumentError in src/tools/lsp/schemas.ts must accept documentSymbol with only filePath')
  check('documentSymbol: unread line/character are dropped, not refused', ok({ operation: 'documentSymbol', filePath: 'a.ts', line: 1, character: 1 }) && !kept({ operation: 'documentSymbol', filePath: 'a.ts', line: 1, character: 1 }).includes('line'), undefined, 'readArguments in src/tools/lsp/schemas.ts must drop line and character for documentSymbol, and readArgumentError must not refuse them')
  check('diagnostics: filePath alone is valid', ok({ operation: 'diagnostics', filePath: 'a.ts' }), undefined, 'lspInputSchema or readArgumentError in src/tools/lsp/schemas.ts must accept diagnostics with only filePath')
  check('diagnostics: unread positions are dropped, not refused', ok({ operation: 'diagnostics', filePath: 'a.ts', line: 1, character: 1 }) && !kept({ operation: 'diagnostics', filePath: 'a.ts', line: 1, character: 1 }).includes('character'), undefined, 'readArguments in src/tools/lsp/schemas.ts must drop line and character for diagnostics, and readArgumentError must not refuse them')
  check('a retired read operation takes the same unknown road', !ok({ operation: 'switchSourceHeader', filePath: 'a.cpp' }) && !ok({ operation: 'nonsense', filePath: 'a.cpp' }), undefined, 'lspInputSchema in src/tools/lsp/schemas.ts must reject switchSourceHeader and unknown operations for LspRead')
  check('workspaceSymbol: query required (bare shape REJECTED)', !ok({ operation: 'workspaceSymbol' }), undefined, 'readArgumentError in src/tools/lsp/schemas.ts must refuse workspaceSymbol without a query')
  check('workspaceSymbol: filePath+positions without query is still REJECTED (query is read and required)', !ok({ operation: 'workspaceSymbol', filePath: 'a.ts', line: 1, character: 1 }), undefined, 'readArgumentError in src/tools/lsp/schemas.ts must refuse workspaceSymbol without a query even when filePath and positions are given')
  check('workspaceSymbol: query alone is valid (workspace-scoped)', ok({ operation: 'workspaceSymbol', query: 'makeGreeting' }), undefined, 'lspInputSchema or readArgumentError in src/tools/lsp/schemas.ts must accept workspaceSymbol with only a query')
  check('workspaceSymbol: empty query REJECTED', !ok({ operation: 'workspaceSymbol', query: '' }), undefined, 'lspInputSchema or readArgumentError in src/tools/lsp/schemas.ts must refuse an empty workspaceSymbol query')
  check('workspaceSymbol: limit within cap valid', ok({ operation: 'workspaceSymbol', query: 'x', limit: 200 }), undefined, 'lspInputSchema in src/tools/lsp/schemas.ts must accept a workspaceSymbol limit of 200')
  check('workspaceSymbol: limit above cap REJECTED', !ok({ operation: 'workspaceSymbol', query: 'x', limit: 201 }), undefined, 'lspInputSchema in src/tools/lsp/schemas.ts must refuse a workspaceSymbol limit above 200')
  check('goToDefinition: positions still required', !ok({ operation: 'goToDefinition', filePath: 'a.ts' }), undefined, 'readArgumentError in src/tools/lsp/schemas.ts must refuse goToDefinition without line and character')
  check('rename: its own schema requires positions and newName', lspInputSchema('LspRename').safeParse({ filePath: 'a.ts', line: 2, character: 3, newName: 'y' }).success && !lspInputSchema('LspRename').safeParse({ filePath: 'a.ts', line: 2, character: 3 }).success, undefined, 'lspInputSchema(LspRename) in src/tools/lsp/schemas.ts must require filePath, line, character and newName')
}

console.log(' §2 boundWorkspaceSymbols — dedupe · sort · cap · honest totals')
const { boundWorkspaceSymbols } = await import('../../src/tools/lsp/formatters.js')
{
  const sym = (name: string, uri: string, line = 0) =>
    ({ name, kind: 12, location: { uri, range: { start: { line, character: 0 }, end: { line, character: 1 } } } }) as never
  const input = [
    sym('beta', 'file:///b.ts', 4),
    sym('alpha', 'file:///z.ts', 9),
    sym('alpha', 'file:///a.ts', 2),
    sym('alpha', 'file:///a.ts', 2),
    sym('gamma', 'file:///a.ts', 1),
  ]
  const bounded = boundWorkspaceSymbols(input, 3)
  check('duplicates removed', bounded.total === 4, undefined, `boundWorkspaceSymbols in src/tools/lsp/formatters.ts must drop identical name+uri+range symbols before counting (total was ${bounded.total})`)
  check('sorted by name then uri', bounded.shown.map(s => (s as { name: string }).name).join(',') === 'alpha,alpha,beta', undefined, 'boundWorkspaceSymbols in src/tools/lsp/formatters.ts must sort by name, then uri, before capping')
  check('capped with truncated=true', bounded.shown.length === 3 && bounded.truncated === true, undefined, `boundWorkspaceSymbols in src/tools/lsp/formatters.ts must cut shown to the limit and set truncated (shown ${bounded.shown.length}, truncated ${bounded.truncated})`)
  const all = boundWorkspaceSymbols(input, 50)
  check('under the cap: everything shown, truncated=false', all.shown.length === 4 && all.truncated === false, undefined, `boundWorkspaceSymbols in src/tools/lsp/formatters.ts must show every symbol and leave truncated false under the limit (shown ${all.shown.length}, truncated ${all.truncated})`)
}

console.log(' §3 diagnostic baselines through the real op (fake manager)')
const { runMercuryLspOp, clearDiagnosticsBaselines } = await import('../../src/tools/lsp/mercuryOps.js')
{
  const dir = mkdtempSync(join(tmpdir(), 'lsp-contract-'))
  const file = join(dir, 'probe.ts')
  writeFileSync(file, 'export const one = 1\n')

  interface Sent {
    method: string
    params: Record<string, unknown>
  }
  const sent: Sent[] = []
  let generation = 1
  let docVersion: number | undefined = 1
  const script: Array<{ kind: string; items?: unknown[]; resultId?: string }> = []
  const fakeServer = {
    name: 'fake-ts',
    get generation() {
      return generation
    },
    state: 'running',
    capabilities: { diagnosticProvider: {} },
    start: async () => {},
    sendRequest: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params })
      if (method !== 'textDocument/diagnostic') return undefined
      return script.shift()
    },
  }
  const fakeManager = {
    getServerForFile: () => fakeServer,
    getServersForFile: () => [fakeServer],
    isFileOpen: () => true,
    openFile: async () => {},
    changeFile: async () => {},
    changeAndSaveFile: async () => {},
    getDocumentVersion: () => docVersion,
    sendRequest: async (_p: string, method: string, params: Record<string, unknown>) => {
      sent.push({ method, params })
      if (method !== 'textDocument/diagnostic') return undefined
      return script.shift()
    },
  }
  const env = {
    input: { operation: 'diagnostics' as const, filePath: file },
    absolutePath: file,
    cwd: dir,
    manager: fakeManager as never,
    tool: {} as never,
    context: { getAppState: () => ({ toolPermissionContext: { additionalWorkingDirectories: new Map() } }) } as never,
  }
  const run = () => runMercuryLspOp(env as never)

  clearDiagnosticsBaselines()
  const diag = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'boom' }

  script.push({ kind: 'full', items: [diag], resultId: 'r1' })
  const first = await run()
  const firstReq = sent.filter(s => s.method === 'textDocument/diagnostic').at(-1)!
  check('first pull sends NO previousResultId', !('previousResultId' in firstReq.params), undefined, 'pullFileDiagnostics in src/tools/lsp/mercury-ops/pull.ts must send previousResultId only when a usable baseline exists')
  check('first pull reports the diagnostic as a FRESH report', /1 diagnostic/.test(first.result) && /fresh report/.test(first.result), undefined, `the diagnostics op in src/tools/lsp/mercury-ops/diagnostics.ts must state a fresh report with the diagnostic count; result was: ${first.result}`)

  script.push({ kind: 'unchanged' })
  const second = await run()
  const secondReq = sent.filter(s => s.method === 'textDocument/diagnostic').at(-1)!
  check('second pull carries previousResultId=r1', secondReq.params.previousResultId === 'r1', undefined, 'pullFileDiagnostics in src/tools/lsp/mercury-ops/pull.ts must send the stored baseline resultId as previousResultId')
  check('unchanged reuses the baseline set (still 1 diagnostic, says unchanged)', /1 diagnostic/.test(second.result) && /unchanged — server re-affirmed/.test(second.result), undefined, `an unchanged reply must reuse the baseline diagnostics and say so (src/tools/lsp/mercury-ops/diagnostics.ts, pull.ts); result was: ${second.result}`)

  docVersion = 2
  script.push({ kind: 'full', items: [], resultId: 'r2' })
  const third = await run()
  const thirdReq = sent.filter(s => s.method === 'textDocument/diagnostic').at(-1)!
  check('version bump: NO previousResultId (stale baseline refused)', !('previousResultId' in thirdReq.params), undefined, 'pullFileDiagnostics in src/tools/lsp/mercury-ops/pull.ts must not reuse a baseline recorded for an older document version')
  check('post-edit clean claim is anchored to a fresh report + version', /clean/.test(third.result) && /fresh report \(document version 2\)/.test(third.result), undefined, `the diagnostics op in src/tools/lsp/mercury-ops/diagnostics.ts must claim clean only with a fresh report and the document version; result was: ${third.result}`)

  script.push({ kind: 'unchanged' })
  const fourth = await run()
  check("clean baseline + 'unchanged' = verified clean, provenance stated", /clean/.test(fourth.result) && /unchanged — server re-affirmed/.test(fourth.result), undefined, `an unchanged reply on a clean baseline must read clean and name the re-affirmation (src/tools/lsp/mercury-ops/diagnostics.ts); result was: ${fourth.result}`)

  generation = 2
  script.push({ kind: 'full', items: [diag], resultId: 'r3' })
  await run()
  const fifthReq = sent.filter(s => s.method === 'textDocument/diagnostic').at(-1)!
  check('generation bump: NO previousResultId (restarted server owes a full report)', !('previousResultId' in fifthReq.params), undefined, 'pullFileDiagnostics in src/tools/lsp/mercury-ops/pull.ts must drop the baseline when the server generation changed')

  clearDiagnosticsBaselines()
  script.push({ kind: 'unchanged' })
  const sixth = await run()
  check("baseline-less 'unchanged' reads indeterminate, never clean", /indeterminate/.test(sixth.result) && !/is clean/.test(sixth.result), undefined, `an unchanged reply with no baseline must read indeterminate, not clean (src/tools/lsp/mercury-ops/diagnostics.ts, pull.ts); result was: ${sixth.result}`)
}

if (failures > 0) {
  console.error(`prove-lsp-contract: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-contract: GREEN')
process.exit(0)
