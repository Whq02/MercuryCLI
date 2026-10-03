#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { armScratch, check, cleanup, FAILING_SERVER, FAKE_SERVER, finish, fixtureServer, openToolDoor, section, TS_PROBE_FILES, writeProject } from './lspProofDoor.ts'

console.log('prove-lsp-failure-words — every LSP tool failure the model receives says what happened and what helps')
console.log('  which server, for which language; why it could not answer (its own last line, the timeout, no typescript,')
console.log('  invalid arguments); the result carries isError on a real failure; the collapsed line shows the cause;')
console.log('  nothing in the words invites a blind retry')

const scratch = armScratch('lsp-failure-words')
const project = writeProject(scratch, 'project', TS_PROBE_FILES)
const lib = path.join(project, 'lib.ts')
const main = path.join(project, 'main.ts')
const pidFile = path.join(scratch, 'pids')
const spawns = (): number => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).length : 0)
const retryWords = /backing off|retry|re-run|try again/i

type Door = Awaited<ReturnType<typeof openToolDoor>>
async function withServer(mode: string, extra: Record<string, unknown>, body: (door: Door) => Promise<void>): Promise<void> {
  process.env.MERCURY_LSP_SERVERS = JSON.stringify({
    ...fixtureServer('fixture-ts', FAILING_SERVER, { FAILING_LSP_MODE: mode, FAILING_LSP_PID_FILE: pidFile }, '.ts', 'typescript', extra),
  })
  const door = await openToolDoor(project)
  try {
    await body(door)
  } finally {
    await door.close()
  }
}

section('§1 the server refuses to start: the words name the server, the language, its own reason and what helps')
await withServer('refuse-initialize', {}, async door => {
  const before = spawns()
  const out = await door.drive({ operation: 'workspaceDiagnostics', paths: [lib, main] })
  check('the result is an error (isError true)', out.isError === true, out.text.slice(0, 200))
  check('the outcome is failed', (out.data as { outcome?: string } | null)?.outcome === 'failed', JSON.stringify(out.data?.outcome))
  check('it says nothing was checked', /^0 of 2 file\(s\) checked/.test(out.text), out.text.split('\n')[0] ?? '')
  check('it names the server and its language', /the TypeScript language server \(env:fixture-ts\)/.test(out.text), out.text)
  check('it says the server did not start, with the server’s own reason', /did not start: no resolvable 'typescript' package from workspace root \/fixture-project/.test(out.text), out.text)
  check('it says what helps: install typescript, or the project’s own type check', /What helps: install typescript in the project \(npm install -D typescript\), or check the files with npm run typecheck/.test(out.text), out.text)
  check('it does not invite a retry', !retryWords.test(out.text), out.text)
  check('one spawn served the whole call (the second file did not respawn)', spawns() - before === 1, `spawns=${spawns() - before}`)
  const single = await door.drive({ operation: 'diagnostics', filePath: lib })
  check('the single-file diagnostics op says the same: not checked, the server, the reason, what helps', single.isError === true && /lib\.ts was not checked: the TypeScript language server \(env:fixture-ts\) did not start: no resolvable/.test(single.text) && /What helps: install typescript/.test(single.text), single.text)
  const definition = await door.drive({ operation: 'goToDefinition', filePath: main, line: 2, character: 14 })
  check('a base operation says it was not run, the server and the reason', definition.isError === true && /goToDefinition operation was not run: the TypeScript language server \(env:fixture-ts\) did not start — no resolvable/.test(definition.text), definition.text)
})

section('§2 the server exits before it answers: its own last line is the reason')
await withServer('exit-before-initialize', {}, async door => {
  const out = await door.drive({ operation: 'workspaceDiagnostics', paths: [lib] })
  check('isError true', out.isError === true)
  check('the words carry the server’s own last line', /server said: fixture-ts: the typescript compiler is missing from this machine/.test(out.text), out.text)
  check('…and say it exited rather than started', /did not start: exited/.test(out.text), out.text)
  check('no retry invitation', !retryWords.test(out.text), out.text)
})

section('§3 the server never answers initialize: the words say it timed out, in seconds')
await withServer('never-initialize', { startupTimeout: 700 }, async door => {
  const t0 = Date.now()
  const out = await door.drive({ operation: 'workspaceDiagnostics', paths: [lib] })
  const elapsed = Date.now() - t0
  check('isError true', out.isError === true)
  check(`the call settled at the startup budget (${elapsed} ms)`, elapsed >= 600 && elapsed < 6000)
  check('the words say it did not start within 0.7 s', /did not start: did not start within 0\.7 s|did not start within 0\.7 s/.test(out.text), out.text)
  check('the remedy is the project type check (installing a package is not claimed to fix a timeout)', /check the files with npm run typecheck/.test(out.text) && !/install typescript/.test(out.text), out.text)
})

section('§4 the server starts but refuses the diagnostic request: the method and its reason')
await withServer('refuse-diagnostics', {}, async door => {
  const out = await door.drive({ operation: 'workspaceDiagnostics', paths: [lib, main] })
  check('isError true', out.isError === true)
  check('the words name the request and the server’s reason', /did not answer textDocument\/diagnostic: .*fixture compiler failure/.test(out.text), out.text)
  check('no retry invitation', !retryWords.test(out.text), out.text)
})

section('§5 the request times out: the words say so in seconds, and nothing invites a retry')
await withServer('never-answer-diagnostics', { requestTimeout: 700 }, async door => {
  const out = await door.drive({ operation: 'diagnostics', filePath: lib })
  check('isError true', out.isError === true)
  check('the words say the server got no answer within 0.7 s', /did not answer textDocument\/diagnostic: got no answer within 0\.7s/.test(out.text), out.text)
  check('no retry invitation (the old sentence said "retry, or restart it")', !retryWords.test(out.text), out.text)
})

section('§6 no server claims the files: the words say why and what would provide one')
{
  process.env.MERCURY_LSP_SERVERS = JSON.stringify(fixtureServer('other', FAKE_SERVER, { FAKE_LSP_MODE: 'normal' }, '.fake', 'fake'))
  const door = await openToolDoor(project)
  const out = await door.drive({ operation: 'workspaceDiagnostics', paths: [lib, main] })
  check('isError true (red on the base: "No claimed files to check — every path was unclaimed or unreadable", isError false)', out.isError === true, out.text)
  check('it names the extension and the files', /no language server claims '\.ts' files in this session \(lib\.ts, main\.ts\)/.test(out.text), out.text)
  check('it says what helps: install typescript, or the project’s own type check', /What helps: install typescript in the project \(npm install -D typescript\), or check the files with npm run typecheck/.test(out.text), out.text)
  const single = await door.drive({ operation: 'diagnostics', filePath: lib })
  check('the single-file op says not checked, with the same help', single.isError === true && /lib\.ts was not checked: no language server claims '\.ts' files/.test(single.text) && /What helps: install typescript/.test(single.text), single.text)
  const missing = await door.drive({ operation: 'workspaceDiagnostics', paths: [path.join(project, 'absent.ts')] })
  check('a path that does not exist is named as not found', missing.isError === true && /absent\.ts: not found or unreadable/.test(missing.text), missing.text)
  await door.close()
}

section('§7 invalid arguments: the cause, the valid shape, and that the same arguments will fail again')
{
  const door = await openToolDoor(project)
  const verdict = await door.tool.validateInput!({ operation: 'workspaceDiagnostics', filePath: project, line: 1, character: 1 } as never, {} as never)
  check('refused', verdict.result === false)
  check('the first words name the operation and the missing key', /^Invalid arguments for workspaceDiagnostics: paths is required \(expected array\)/.test(verdict.message ?? ''), verdict.message ?? '')
  check('the valid shape is spelled out', /The valid shape is \{"operation":"workspaceDiagnostics","paths":\["<file or directory>", …\]\}/.test(verdict.message ?? ''), verdict.message ?? '')
  check('it says the same arguments will fail the same way and that no server was asked', /The same arguments will fail the same way; nothing was asked of a language server/.test(verdict.message ?? ''), verdict.message ?? '')
  const rename = await door.tool.validateInput!({ operation: 'rename', filePath: lib, line: 1, character: 14 } as never, {} as never)
  check('rename without newName: the shape names newName as required and apply/plan as optional', /newName is required/.test(rename.message ?? '') && /"newName":"<new name>"/.test(rename.message ?? '') && /optional: apply, plan/.test(rename.message ?? ''), rename.message ?? '')
  const typed = await door.tool.validateInput!({ operation: 'workspaceDiagnostics', paths: 'lib.ts' } as never, {} as never)
  check('a wrong type keeps its detail', /paths: Invalid input: expected array, received string/.test(typed.message ?? ''), typed.message ?? '')
  await door.close()
}

section('§8 the screen: the collapsed line shows the cause, and a failed result shows its words, not a count')
{
  const { enableConfigs } = await import(path.join(import.meta.dir, '../../src/utils/config/globalConfig.ts'))
  enableConfigs()
  const React = (await import('react')).default
  const { renderToString } = await import(path.join(import.meta.dir, '../../src/utils/staticRender.tsx'))
  const { renderToolUseErrorMessage, renderToolResultMessage } = await import(path.join(import.meta.dir, '../../src/tools/LSPTool/UI.tsx'))
  const tagged = '<tool_use_error>Invalid arguments for workspaceDiagnostics: paths is required (expected array). The valid shape is {"operation":"workspaceDiagnostics","paths":["<file or directory>", …]} (1-50 entries). The same arguments will fail the same way; nothing was asked of a language server.</tool_use_error>'
  const collapsed = await renderToString(React.createElement(React.Fragment, null, renderToolUseErrorMessage(tagged, { verbose: false })), 160)
  check('the collapsed error line names the cause', /LSP: Invalid arguments for workspaceDiagnostics: paths is required/.test(collapsed), collapsed)
  check('…and no longer says the bare "LSP operation failed"', !/LSP operation failed/.test(collapsed), collapsed)
  const executorError = '<tool_use_error>InputValidationError: The LSP tool failed due to the following issue:\nThe parameter `frobnicate` was not expected</tool_use_error>'
  const unknownKey = await renderToString(React.createElement(React.Fragment, null, renderToolUseErrorMessage(executorError, { verbose: false })), 200)
  check('an unknown-key refusal shows the key on one line', /frobnicate/.test(unknownKey) && !/\n\s*\n/.test(unknownKey.trim()), unknownKey)
  const failed = { operation: 'workspaceDiagnostics', result: '0 of 2 file(s) checked — 0 error(s), 0 warning(s) in 0 file(s), 2 not checked\n  not checked: lib.ts — the TypeScript language server (env:fixture-ts) did not start: no resolvable typescript', filePath: '', resultCount: 0, fileCount: 2, outcome: 'failed' as const }
  const row = await renderToString(React.createElement(React.Fragment, null, renderToolResultMessage(failed as never, undefined, { verbose: false })), 160)
  check('a failed result shows its first line (red on the base: "Found 0 diagnostics")', /0 of 2 file\(s\) checked/.test(row) && !/Found 0/.test(row), row)
  check('…under the failed badge', /failed/.test(row), row)
}

section('§9 the healthy path is untouched: a server that answers gives diagnostics with no error')
await withServer('fail-then-ok', { env: { FAILING_LSP_MODE: 'fail-then-ok', FAILING_LSP_FAIL_TIMES: '0', FAILING_LSP_PID_FILE: pidFile } }, async door => {
  const out = await door.drive({ operation: 'workspaceDiagnostics', paths: [lib, main] })
  check('isError false', out.isError === false, out.text)
  check('both files checked, one error found', /^2 of 2 file\(s\) checked — 1 error\(s\)/.test(out.text), out.text)
  check('the fixture’s diagnostic is listed', /main\.ts:2:14 fixture-ts 2322/.test(out.text), out.text)
})

cleanup(scratch)
finish('prove-lsp-failure-words')
