
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LSP = '1'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('prove-lsp-contract')

console.log(' §1 schemas — meaningful parameters only')
const { lspToolInputSchema } = await import('../../src/tools/LSPTool/schemas.js')
const schema = lspToolInputSchema()
{
  const ok = (v: unknown): boolean => schema.safeParse(v).success
  check('documentSymbol: filePath alone is valid', ok({ operation: 'documentSymbol', filePath: 'a.ts' }))
  check('documentSymbol: legacy dummy line/character REJECTED', !ok({ operation: 'documentSymbol', filePath: 'a.ts', line: 1, character: 1 }))
  check('diagnostics: filePath alone is valid', ok({ operation: 'diagnostics', filePath: 'a.ts' }))
  check('diagnostics: legacy dummy positions REJECTED', !ok({ operation: 'diagnostics', filePath: 'a.ts', line: 1, character: 1 }))
  check('switchSourceHeader: filePath alone is valid', ok({ operation: 'switchSourceHeader', filePath: 'a.cpp' }))
  check('workspaceSymbol: query required (bare shape REJECTED)', !ok({ operation: 'workspaceSymbol' }))
  check('workspaceSymbol: legacy dummy shape (filePath+positions, no query) REJECTED', !ok({ operation: 'workspaceSymbol', filePath: 'a.ts', line: 1, character: 1 }))
  check('workspaceSymbol: query alone is valid (workspace-scoped)', ok({ operation: 'workspaceSymbol', query: 'makeGreeting' }))
  check('workspaceSymbol: empty query REJECTED', !ok({ operation: 'workspaceSymbol', query: '' }))
  check('workspaceSymbol: limit within cap valid', ok({ operation: 'workspaceSymbol', query: 'x', limit: 200 }))
  check('workspaceSymbol: limit above cap REJECTED', !ok({ operation: 'workspaceSymbol', query: 'x', limit: 201 }))
  check('goToDefinition: positions still required', !ok({ operation: 'goToDefinition', filePath: 'a.ts' }))
  check('rename: positions + newName still required', ok({ operation: 'rename', filePath: 'a.ts', line: 2, character: 3, newName: 'y' }))
}

console.log(' §2 boundWorkspaceSymbols — dedupe · sort · cap · honest totals')
const { boundWorkspaceSymbols } = await import('../../src/tools/LSPTool/formatters.js')
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
  check('duplicates removed', bounded.total === 4)
  check('sorted by name then uri', bounded.shown.map(s => (s as { name: string }).name).join(',') === 'alpha,alpha,beta')
  check('capped with truncated=true', bounded.shown.length === 3 && bounded.truncated === true)
  const all = boundWorkspaceSymbols(input, 50)
  check('under the cap: everything shown, truncated=false', all.shown.length === 4 && all.truncated === false)
}

console.log(' §3 diagnostic baselines through the real op (fake manager)')
const { runMercuryLspOp, clearDiagnosticsBaselines } = await import('../../src/tools/LSPTool/mercuryOps.js')
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
  check('first pull sends NO previousResultId', !('previousResultId' in firstReq.params))
  check('first pull reports the diagnostic as a FRESH report', /1 diagnostic/.test(first.result) && /fresh report/.test(first.result))

  script.push({ kind: 'unchanged' })
  const second = await run()
  const secondReq = sent.filter(s => s.method === 'textDocument/diagnostic').at(-1)!
  check('second pull carries previousResultId=r1', secondReq.params.previousResultId === 'r1')
  check('unchanged reuses the baseline set (still 1 diagnostic, says unchanged)', /1 diagnostic/.test(second.result) && /unchanged — server re-affirmed/.test(second.result))

  docVersion = 2
  script.push({ kind: 'full', items: [], resultId: 'r2' })
  const third = await run()
  const thirdReq = sent.filter(s => s.method === 'textDocument/diagnostic').at(-1)!
  check('version bump: NO previousResultId (stale baseline refused)', !('previousResultId' in thirdReq.params))
  check('post-edit clean claim is anchored to a fresh report + version', /clean/.test(third.result) && /fresh report \(document version 2\)/.test(third.result))

  script.push({ kind: 'unchanged' })
  const fourth = await run()
  check("clean baseline + 'unchanged' = verified clean, provenance stated", /clean/.test(fourth.result) && /unchanged — server re-affirmed/.test(fourth.result))

  generation = 2
  script.push({ kind: 'full', items: [diag], resultId: 'r3' })
  await run()
  const fifthReq = sent.filter(s => s.method === 'textDocument/diagnostic').at(-1)!
  check('generation bump: NO previousResultId (restarted server owes a full report)', !('previousResultId' in fifthReq.params))

  clearDiagnosticsBaselines()
  script.push({ kind: 'unchanged' })
  const sixth = await run()
  check("baseline-less 'unchanged' reads indeterminate, never clean", /indeterminate/.test(sixth.result) && !/is clean/.test(sixth.result))
}

if (failures > 0) {
  console.error(`prove-lsp-contract: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-contract: GREEN')
process.exit(0)
