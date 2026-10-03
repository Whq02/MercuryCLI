#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { armScratch, check, cleanup, FAILING_SERVER, finish, fixtureServer, openToolDoor, section, TS_PROBE_FILES, writeProject } from './lspProofDoor.ts'

console.log('prove-lsp-three-tries — the same failing LSP call is answered in full three times, then refused for the session')
console.log('  the same operation + arguments, or the same server that cannot start; a different file or operation is a new call;')
console.log('  a server that later answers clears the count; a refused call does no server work')

const scratch = armScratch('lsp-three-tries')
const project = writeProject(scratch, 'project', TS_PROBE_FILES)
const lib = path.join(project, 'lib.ts')
const main = path.join(project, 'main.ts')
const pidFile = path.join(scratch, 'pids')
const counterFile = path.join(scratch, 'spawn-counter')
const spawns = (): number => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).length : 0)
const ledger = await import(path.join(import.meta.dir, '../../src/services/lsp/failureLedger.ts'))

section('§1 a server that cannot start: three full answers, then the refusal — for this call, for a new file, for another operation')
process.env.MERCURY_LSP_SERVERS = JSON.stringify(fixtureServer('fixture-ts', FAILING_SERVER, { FAILING_LSP_MODE: 'refuse-initialize', FAILING_LSP_PID_FILE: pidFile }, '.ts', 'typescript'))
{
  const door = await openToolDoor(project)
  const call = { operation: 'workspaceDiagnostics', paths: [lib, main] }
  const full = /the TypeScript language server \(env:fixture-ts\) did not start: no resolvable 'typescript' package/
  const first = await door.drive(call)
  check('call 1: the full error, isError', first.isError && full.test(first.text), first.text)
  check('call 1: no count yet', !/times this session/.test(first.text), first.text)
  const second = await door.drive(call)
  check('call 2: the full error again, isError', second.isError && full.test(second.text), second.text)
  check('call 2: says it has failed the same way 2 times', /This call has failed the same way 2 times this session\./.test(second.text), second.text)
  const third = await door.drive(call)
  check('call 3: the full error again, isError', third.isError && full.test(third.text), third.text)
  check('call 3: says it has failed 3 times and will not be tried again', /This call has failed 3 times this session; it will not be tried again\./.test(third.text), third.text)
  check('call 3: the server itself is named as not to be tried again', /The TypeScript language server \(env:fixture-ts\) did not start 3 times this session; calls that need it will not be tried again\./.test(third.text), third.text)
  const spawnsBefore = spawns()
  const fourth = await door.drive(call)
  const fourthWords = fourth.text.replace(/<\/?tool_use_error>/g, '')
  check('call 4: REFUSED in one sentence naming the earlier failures', fourth.isError && /^Not tried: the same workspaceDiagnostics call has failed 3 times this session \(.*did not start.*\); it will not be tried again this session\.$/.test(fourthWords), fourth.text)
  check('call 4: the refusal is one sentence, before any permission or server step (the validation stage answers it)', fourth.isError === true && fourthWords.split('. ').length === 1 && /<tool_use_error>/.test(fourth.text), fourth.text)
  check('call 4: no server work (no spawn)', spawns() === spawnsBefore, `spawns ${spawnsBefore} -> ${spawns()}`)
  const fifth = await door.drive(call)
  check('call 5: still refused, the count stays at the three real failures', /has failed 3 times this session/.test(fifth.text), fifth.text)
  const strayKeys = await door.drive({ ...call, line: 1, character: 1 })
  check('the same call with stray documented keys is the same call: refused by the tool itself, outcome failed', strayKeys.isError && /^Not tried: the same workspaceDiagnostics call has failed 3 times/.test(strayKeys.text) && (strayKeys.data as { outcome?: string } | null)?.outcome === 'failed', strayKeys.text)
  const otherFile = await door.drive({ operation: 'workspaceDiagnostics', paths: [main] })
  check('a different file is a new call, but the same server that cannot start is refused', otherFile.isError && /^Not tried: the TypeScript language server \(env:fixture-ts\) did not start 3 times this session \(no resolvable 'typescript'.*\); calls that need it will not be tried again this session\. What helps: install typescript/.test(otherFile.text), otherFile.text)
  const otherOp = await door.drive({ operation: 'diagnostics', filePath: lib })
  check('another operation on the same server is refused the same way', otherOp.isError && /^Not tried: the TypeScript language server \(env:fixture-ts\) did not start 3 times/.test(otherOp.text), otherOp.text)
  const base = await door.drive({ operation: 'hover', filePath: main, line: 2, character: 14 })
  check('a base operation needing that server is refused too', base.isError && /^Not tried: the TypeScript language server/.test(base.text), base.text)
  check('still no spawn across the refusals', spawns() === spawnsBefore, `spawns ${spawnsBefore} -> ${spawns()}`)
  const { createLSPServerInstance } = await import(path.join(import.meta.dir, '../../src/services/lsp/LSPServerInstance.ts'))
  const fresh = createLSPServerInstance('env:fixture-ts', { ...(JSON.parse(process.env.MERCURY_LSP_SERVERS!)['fixture-ts'] as object), scope: 'dynamic', source: 'proof' } as never)
  let latched: unknown
  await fresh.start().catch((e: unknown) => (latched = e))
  check('the latch is the session’s, not a backoff window: a fresh instance of that server refuses start() without spawning', latched instanceof Error && (latched as { refused?: boolean }).refused === true && spawns() === spawnsBefore, latched instanceof Error ? latched.message : String(latched))
  await door.close()
}

section('§2 the validation road counts the same way: three detailed refusals, then the one-sentence refusal')
{
  const door = await openToolDoor(project)
  const bad = { operation: 'workspaceDiagnostics', filePath: project, line: 1, character: 1 }
  const detailed = /^Invalid arguments for workspaceDiagnostics: paths is required \(expected array\)\. The valid shape is/
  const first = await door.drive(bad)
  check('call 1: the detailed refusal', first.isError && detailed.test(first.text.replace(/<\/?tool_use_error>/g, '')), first.text)
  check('call 1: no count yet', !/times this session/.test(first.text), first.text)
  const second = await door.drive(bad)
  check('call 2: detailed, and says 2 times', detailed.test(second.text.replace(/<\/?tool_use_error>/g, '')) && /failed the same way 2 times this session/.test(second.text), second.text)
  const third = await door.drive(bad)
  check('call 3: detailed, and says 3 times, not to be tried again', detailed.test(third.text.replace(/<\/?tool_use_error>/g, '')) && /failed 3 times this session; it will not be tried again/.test(third.text), third.text)
  const fourth = await door.drive(bad)
  check('call 4: the one-sentence refusal naming the earlier failure', fourth.isError && /^Not tried: the same workspaceDiagnostics call has failed 3 times this session \(Invalid arguments for workspaceDiagnostics: paths is required \(expected array\)\); it will not be tried again this session\.$/.test(fourth.text.replace(/<\/?tool_use_error>/g, '')), fourth.text)
  const different = await door.drive({ operation: 'workspaceDiagnostics', filePath: lib, line: 2, character: 3 })
  check('different arguments are a new call: the detailed refusal again, count 1', detailed.test(different.text.replace(/<\/?tool_use_error>/g, '')) && !/times this session/.test(different.text), different.text)
  const missing = await door.drive({ operation: 'diagnostics', filePath: path.join(project, 'absent.ts') })
  check('a missing file is a plain refusal that says the same arguments will fail', missing.isError && /File does not exist: .*absent\.ts\. The same arguments will fail the same way/.test(missing.text), missing.text)
  await door.close()
}

section('§3 a server that later answers clears the count')
{
  ledger.resetLspFailureLedger()
  process.env.MERCURY_LSP_SERVERS = JSON.stringify(fixtureServer('fixture-ts', FAILING_SERVER, { FAILING_LSP_MODE: 'fail-then-ok', FAILING_LSP_FAIL_TIMES: '1', FAILING_LSP_COUNTER: counterFile, FAILING_LSP_PID_FILE: pidFile }, '.ts', 'typescript'))
  const door = await openToolDoor(project)
  const call = { operation: 'workspaceDiagnostics', paths: [lib, main] }
  const first = await door.drive(call)
  const second = await door.drive(call)
  check('two failures recorded against the call and the server', first.isError && second.isError && /2 times this session/.test(second.text), second.text)
  const before = ledger._lspFailureLedgerForTesting()
  check('the ledger holds the call (2) and the server (2)', before.calls.length === 1 && before.calls[0]?.count === 2 && before.servers.some((s: { server: string; count: number }) => s.server === 'env:fixture-ts' && s.count === 2), JSON.stringify(before))
  const servers = (door.manager() as { getAllServers: () => Map<string, { restart: () => Promise<void>; state: string }> }).getAllServers()
  const server = servers.get('env:fixture-ts')!
  await server.restart()
  check('the explicit restart starts the server (the fixture answers from its second spawn)', server.state === 'running', server.state)
  const after = ledger._lspFailureLedgerForTesting()
  check('a server that answered cleared its count and the calls attributed to it', after.servers.length === 0 && after.calls.length === 0, JSON.stringify(after))
  const third = await door.drive(call)
  check('the same call now answers with diagnostics, no error', third.isError === false && /2 of 2 file\(s\) checked — 1 error\(s\)/.test(third.text), third.text)
  const later = await door.drive(call)
  check('…and keeps answering (no count, no refusal)', later.isError === false && !/times this session|Not tried/.test(later.text), later.text)
  await door.close()
}

section('§5 an interrupted call is not a failed try')
{
  ledger.resetLspFailureLedger()
  process.env.MERCURY_LSP_SERVERS = JSON.stringify(fixtureServer('fixture-ts', FAILING_SERVER, { FAILING_LSP_MODE: 'never-answer-diagnostics', FAILING_LSP_PID_FILE: pidFile }, '.ts', 'typescript', { requestTimeout: 60_000 }))
  const door = await openToolDoor(project)
  const t0 = Date.now()
  door.abortAfter(400)
  const interrupted = await door.drive({ operation: 'diagnostics', filePath: lib })
  const elapsed = Date.now() - t0
  check(`the Esc settled the call (${elapsed} ms, not the 60 s budget)`, elapsed < 10_000, interrupted.text)
  const held = ledger._lspFailureLedgerForTesting()
  check('nothing was counted against the call or the server', held.calls.length === 0 && held.servers.length === 0, JSON.stringify(held) + ' ' + interrupted.text.slice(0, 160))
  await door.close()
}

section('§4 the reload road starts over: a re-initialised manager forgets the session’s refusals')
{
  ledger.recordLspServerFailure('env:fixture-ts', 'proof')
  ledger.recordLspServerFailure('env:fixture-ts', 'proof')
  ledger.recordLspServerFailure('env:fixture-ts', 'proof')
  check('precondition: the server is latched', ledger.lspServerRefusal('env:fixture-ts') !== undefined)
  const lspManager = await import(path.join(import.meta.dir, '../../src/services/lsp/manager.ts'))
  lspManager.initializeLspServerManager()
  await lspManager.waitForInitialization()
  lspManager.reinitializeLspServerManager()
  await lspManager.waitForInitialization()
  check('after the reload the latch is gone', ledger.lspServerRefusal('env:fixture-ts') === undefined && ledger._lspFailureLedgerForTesting().servers.length === 0)
  await lspManager.shutdownLspServerManager()
}

cleanup(scratch)
finish('prove-lsp-three-tries')
