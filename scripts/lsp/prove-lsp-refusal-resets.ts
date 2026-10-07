import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { armScratch, check, cleanup, FAILING_SERVER, finish, fixtureServer, openToolDoor, TS_PROBE_FILES, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('lsp-refusal-resets')
const project = writeProject(scratch, 'project', TS_PROBE_FILES)
const main = join(project, 'main.ts')
const lib = join(project, 'lib.ts')
const requestLog = join(scratch, 'requests.jsonl')
const pidFile = join(scratch, 'pids')
const counterFile = join(scratch, 'counter')
const available = await import('../../src/tools/LSPTool/LSPTool.ts')
const ledger = await import('../../src/services/lsp/failureLedger.ts')
if (!('LspReadTool' in available) || !('lspCallSituation' in ledger)) {
  check('call refusals reset when their situation changes', false)
  cleanup(scratch)
  finish('prove-lsp-refusal-resets')
}
let now = new Date(2026, 9, 7, 5, 0, 0).getTime()
ledger._setLspLedgerClockForTesting(() => now)
const requests = () => existsSync(requestLog) ? readFileSync(requestLog, 'utf8').split('\n').filter(line => line && JSON.parse(line).method === 'textDocument/diagnostic').length : 0
const spawns = () => existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).length : 0
const plain = (text: string) => text.replace(/<\/?tool_use_error>/g, '')
process.env.MERCURY_LSP_SERVERS = JSON.stringify(fixtureServer('fixture-ts', FAILING_SERVER, { FAILING_LSP_MODE: 'refuse-diagnostics', FAILING_LSP_REQUEST_LOG: requestLog }, '.ts', 'typescript'))
{
  const door = await openToolDoor(project)
  try {
    const manager = door.manager()!
    await manager.ensureServerStarted(main)
    const input = { operation: 'diagnostics', filePath: main }
    const first = await door.drive(input)
    check('first server failure has no counter note', first.isError && !/This call has now/.test(first.text), first.text)
    const second = await door.drive(input)
    check('second server failure has exact C2 suffix', second.text.endsWith(' This call has now failed the same way 2 times in a row with nothing it depends on changed.'), second.text)
    const third = await door.drive(input)
    check('third server failure has C3 and a 60-second window', third.isError && third.text.endsWith(' This call has now failed 3 times in a row with nothing it depends on changed; it will not be sent again until main.ts changes or a language server restarts, or before 05:01:00 (in 60 s).'), third.text)
    const before = requests()
    const held = ledger._lspFailureLedgerForTesting()[0]!
    const expected = `Not tried: this diagnostics call failed 3 times in a row with nothing it depends on changed (last: ${held.summary}). It will be sent again once main.ts changes or a language server restarts, or after 05:01:00 (in 60 s). Until then, answer it with Read or Grep, or fix the cause above.`
    const fourth = await door.drive(input)
    check('fourth call has exact C1 wrapped before server work', fourth.isError && plain(fourth.text) === expected && fourth.text.startsWith('<tool_use_error>') && requests() === before, fourth.text)
    const filled = await door.drive({ ...input, query: 'unused', limit: 1, line: 9, character: 8 })
    check('unread advertised arguments do not evade the call key', plain(filled.text) === expected && requests() === before, filled.text)
    appendFileSync(main, '\n')
    const changed = await door.drive(input)
    check('a changed named file sends the same call with count one', requests() > before && changed.isError && !/This call has now/.test(changed.text), changed.text)
    await door.drive(input)
    await door.drive(input)
    const server = manager.getAllServers().get('env:fixture-ts')!
    await server.restart()
    const priorRestart = requests()
    const restarted = await door.drive(input)
    check('a server restart sends the call with count one', requests() > priorRestart && !/This call has now/.test(restarted.text), restarted.text)
    await door.drive(input)
    await door.drive(input)
    now += 59_000
    const beforeTime = requests()
    const at59 = await door.drive(input)
    check('59 seconds is still refused, one second remains', requests() === beforeTime && /in 1 s/.test(at59.text), at59.text)
    now += 2_000
    const at61 = await door.drive(input)
    check('after 61 seconds a fourth failed try is sent and waits 120 seconds', requests() > beforeTime && /failed 4 times in a row/.test(at61.text) && /in 120 s/.test(at61.text), at61.text)
    for (let i = 0; i < 5; i++) {
      const bad = await door.drive({ operation: 'findReferences', filePath: main })
      check(`argument refusal ${i + 1} never counts`, bad.isError && /line, character are missing/.test(bad.text) && !/Not tried/.test(bad.text), bad.text)
    }
    const key = ledger.lspCallKey('workspaceSymbol', { operation: 'workspaceSymbol', query: 'none', filePath: main })
    const situation = await ledger.lspCallSituation([main], manager)
    ledger.recordLspServerFault(key, 'prior fault', situation)
    const noSymbols = await door.drive({ operation: 'workspaceSymbol', query: 'none', filePath: main })
    check('null workspace-symbol answer is no-change and clears its key', !noSymbols.isError && noSymbols.data?.outcome === 'no-change' && !ledger._lspFailureLedgerForTesting().some(entry => entry.key === key), noSymbols.text)
  } finally { await door.close() }
}
process.env.MERCURY_LSP_SERVERS = JSON.stringify(fixtureServer('fixture-ts', FAILING_SERVER, { FAILING_LSP_MODE: 'fail-then-ok', FAILING_LSP_FAIL_TIMES: '1', FAILING_LSP_COUNTER: counterFile, FAILING_LSP_PID_FILE: pidFile }, '.ts', 'typescript'))
{
  const door = await openToolDoor(project)
  try {
    const input = { operation: 'diagnostics', filePath: main }
    const first = await door.drive(input)
    check('a real failed start says when the next attempt is allowed', first.isError && /first call after .*in 15 s/.test(first.text) && spawns() === 1, first.text)
    const second = await door.drive(input)
    const third = await door.drive(input)
    check('start backoff has S2, no new spawn and no call-fault count', /Not tried: .*did not start 1 time in a row/.test(second.text) && /in 15 s/.test(third.text) && spawns() === 1 && ledger._lspFailureLedgerForTesting().length === 0, third.text)
    now += 16_000
    const succeeded = await door.drive(input)
    check('start backoff expiry really starts and answers again', spawns() === 2 && !succeeded.isError && /1 diagnostics/.test(succeeded.text), succeeded.text)
    const manager = door.manager()!
    const key = ledger.lspCallKey('diagnostics', input)
    const situation = await ledger.lspCallSituation([main], manager)
    ledger.recordLspServerFault(key, 'prior fault', situation)
    await door.drive(input)
    check('a successful call clears prior server faults', ledger._lspFailureLedgerForTesting().length === 0)
  } finally { await door.close() }
}
process.env.MERCURY_LSP_SERVERS = JSON.stringify(fixtureServer('fixture-ts', FAILING_SERVER, { FAILING_LSP_MODE: 'never-answer-diagnostics' }, '.ts', 'typescript', { requestTimeout: 60_000 }))
{
  const door = await openToolDoor(project)
  try {
    await door.manager()!.ensureServerStarted(lib)
    door.abortAfter(100)
    const start = Date.now()
    await door.drive({ operation: 'diagnostics', filePath: lib })
    check('interrupt settles before the request deadline and never counts', Date.now() - start < 10_000 && ledger._lspFailureLedgerForTesting().length === 0)
  } finally { await door.close() }
}
ledger._setLspLedgerClockForTesting()
cleanup(scratch)
finish('prove-lsp-refusal-resets')
