#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('C:/Program Files/Git/bin/bash.exe')) {
  process.env.SHELL = 'C:/Program Files/Git/bin/bash.exe'
}
process.env.MERCURY_SHELL_ENGINE = 'system'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const TAIL_HINT = ' | change windowsBatchTail in src/platform/shell/windowsBatchLine.ts'
const PLAN_HINT = ' | change planWindowsBatchInvocation in src/platform/shell/windowsBatchInvocation.ts'
const EXEC_HINT = ' | change the Windows batch branch of exec in src/platform/shell/shellExec.ts (planWindowsBatchInvocation and runWindowsBatchCommand in src/platform/shell/windowsBatchInvocation.ts)'

console.log('============================================================')
console.log(' Windows batch invocation — .cmd/.bat by bare name, literal args')
console.log('============================================================')

type BatchModule = typeof import('../../src/platform/shell/windowsBatchInvocation.ts')
let batch: BatchModule | null = null
try {
  batch = (await import('../../src/platform/shell/windowsBatchInvocation.ts')) as BatchModule
} catch (error) {
  console.log(`  module import failed: ${String(error).slice(0, 160)}`)
}

section('§1 the module exists and its wiring is in the exec path')
{
  check('src/platform/shell/windowsBatchInvocation.ts exports the planner and the composer', batch !== null && typeof batch.planWindowsBatchInvocation === 'function' && typeof batch.windowsBatchTail === 'function', 'export both from src/platform/shell/windowsBatchInvocation.ts, or fix the import error printed above')
}

const CRLF = '\r\n'
const writeBatch = (path: string, lines: string[]): void => writeFileSync(path, lines.join(CRLF))
const BIN = mkdtempSync(join(tmpdir(), 'batch-prove-bin-'))
const BIN_SPACED = mkdtempSync(join(tmpdir(), 'batch Café Ledger-'))
writeBatch(join(BIN, 'tool.cmd'), ['@echo off', 'exit /b 0'])
writeBatch(join(BIN, 'tool.bat'), ['@echo off', 'exit /b 0'])
writeBatch(join(BIN, 'onlycmd.cmd'), ['@echo off', 'exit /b 0'])
writeBatch(join(BIN, 'code42.cmd'), ['@echo off', 'exit /b 42'])
writeFileSync(join(BIN, 'plain'), '#!/bin/sh\nexit 0\n')
writeFileSync(join(BIN, 'tool.exe'), Buffer.alloc(0))
writeBatch(join(BIN_SPACED, 'spaced.cmd'), ['@echo off', 'exit /b 0'])
writeBatch(join(BIN_SPACED, 'hello.bat'), ['@echo off', 'exit /b 0'])
writeBatch(join(BIN_SPACED, 'tool.cmd'), ['@echo off', 'exit /b 0'])
mkdirSync(join(BIN_SPACED, 'folder.cmd'))

section('§2 the composer emits the cmd.exe line that carries every byte literally')
{
  const tail = batch === null ? null : batch.windowsBatchTail.bind(batch)
  const wrapped = (inner: string): string => `"${inner}"`
  const eq = (label: string, words: string[], want: string | null): void => {
    const got = tail === null ? null : tail(words)
    check(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}${TAIL_HINT}`)
  }
  if (tail === null) {
    check('the composer is importable', false, 'module absent | src/platform/shell/windowsBatchInvocation.ts must import and export windowsBatchTail')
  }
  eq('plain word is quoted, whole line wrapped once', ['C:\\bin\\tool.cmd', '--version'], wrapped('"C:\\bin\\tool.cmd" "--version"'))
  eq('empty word stays a quoted empty argument', ['p', ''], wrapped('"p" ""'))
  eq('a trailing backslash run is doubled inside the quotes', ['p', 'C:\\dir\\'], wrapped('"p" "C:\\dir\\\\"'))
  eq('a mid-word backslash is untouched', ['p', 'a\\b\\c'], wrapped('"p" "a\\b\\c"'))
  eq('a caret is literal inside quotes (never doubled)', ['p', 'a^b'], wrapped('"p" "a^b"'))
  eq('a bang is literal inside quotes', ['p', 'x!y!z'], wrapped('"p" "x!y!z"'))
  eq('spaces stay inside one quoted word', ['p', 'pl ain'], wrapped('"p" "pl ain"'))
  eq('non-ASCII stays byte-honest', ['p', 'ünï ✓'], wrapped('"p" "ünï ✓"'))
  eq('a percent run is emitted bare with a caret after the opening percents', ['p', '%FOO%'], wrapped('"p" %^FOO%'))
  eq('a prefixed percent run keeps its quoted head', ['p', '--flag=%FOO%'], wrapped('"p" "--flag="%^FOO%'))
  eq('a suffixed percent run keeps its quoted tail', ['p', '%FOO%x'], wrapped('"p" %^FOO%"x"'))
  eq('a run around spaces splits into quoted flanks', ['p', 'a %FOO% b'], wrapped('"p" "a "%^FOO%" b"'))
  eq('a doubled-percent run carries its caret after the opening pair', ['p', '%%FOO%%'], wrapped('"p" %%^FOO%%'))
  eq('a doubled-percent run with a prefix', ['p', '100%%FOO%%'], wrapped('"p" "100"%%^FOO%%'))
  eq('a lone percent with no closing pair stays quoted', ['p', '100%'], wrapped('"p" "100%"'))
  eq('a percent pair that closes no name stays quoted', ['p', 'a%%b'], wrapped('"p" "a%%b"'))
  eq('a word with two percent runs is refused, not guessed', ['p', 'a%FOO%b%CD%c'], null)
  eq('a word that is only percents is refused, not guessed', ['p', '%%'], null)
  eq('a percent run plus a stray percent is refused, not guessed', ['p', 'a%FOO%b%'], null)
  eq('a double quote in a word is refused (cmd.exe cannot carry it)', ['p', 'he said "hi"'], null)
}

section('§3 the planner takes only a lone simple command onto a found .cmd/.bat')
{
  const plan = async (command: string, options: { path?: string; cwd?: string } = {}) => {
    if (batch === null) return { kind: 'absent' as const }
    return batch.planWindowsBatchInvocation(command, {
      world: { platform: 'win32', path: options.path ?? BIN, comSpec: 'C:\\Windows\\System32\\cmd.exe' },
      cwd: options.cwd ?? tmpdir(),
    })
  }
  const isBatch = async (command: string, wantInner: string | null, options?: { path?: string; cwd?: string }): Promise<void> => {
    const got = await plan(command, options)
    if (wantInner === null) {
      check(`${command} stays on the ordinary shell`, got.kind === 'ordinary', JSON.stringify(got).slice(0, 120) + PLAN_HINT)
      return
    }
    const ok = got.kind === 'batch' && got.commandLine === `"${wantInner}"`
    check(`${command} resolves onto ${JSON.stringify(`"${wantInner}"`)}`, ok, got.kind === 'batch' ? `line ${JSON.stringify(got.commandLine)}${PLAN_HINT}` : got.kind + PLAN_HINT)
  }

  await isBatch('tool.cmd --version', `"${join(BIN, 'tool.cmd')}" "--version"`)
  await isBatch('onlycmd x', `"${join(BIN, 'onlycmd.cmd')}" "x"`)
  await isBatch('tool.cmd a^b %FOO% "pl ain"', `"${join(BIN, 'tool.cmd')}" "a^b" %^FOO% "pl ain"`)
  await isBatch('tool.cmd x # a trailing note', `"${join(BIN, 'tool.cmd')}" "x"`)
  await isBatch('(tool.cmd x)', `"${join(BIN, 'tool.cmd')}" "x"`)
  await isBatch('./tool.cmd x', `"${join(BIN, 'tool.cmd')}" "x"`, { cwd: BIN })
  await isBatch('hello.bat x', `"${join(BIN_SPACED, 'hello.bat')}" "x"`, { cwd: BIN_SPACED, path: '' })
  await isBatch('spaced.cmd x', `"${join(BIN_SPACED, 'spaced.cmd')}" "x"`, { cwd: BIN_SPACED, path: '' })
  await isBatch('tool.cmd x', `"${join(BIN_SPACED, 'tool.cmd')}" "x"`, { cwd: BIN_SPACED })
  await isBatch('onlycmd.cmd x', `"${join(BIN, 'onlycmd.cmd')}" "x"`, { cwd: BIN_SPACED })
  await isBatch('missing.cmd x', null, { cwd: BIN_SPACED, path: '' })
  await isBatch('folder.cmd x', null, { cwd: BIN_SPACED, path: '' })
  await isBatch('spaced x', null, { cwd: BIN_SPACED, path: '' })
  await isBatch('plain x', null)
  await isBatch('tool.exe x', null)
  await isBatch('echo hi', null)
  await isBatch('tool.cmd x && echo y', null)
  await isBatch('tool.cmd x; echo y', null)
  await isBatch('tool.cmd x | cat', null)
  await isBatch('tool.cmd x > out.txt', null)
  await isBatch('FOO=1 tool.cmd x', null)
  await isBatch('! tool.cmd x', null)
  await isBatch('tool.cmd *.txt', null)
  await isBatch('tool.cmd "has \\"quote\\"" x', null)
  await isBatch('/c/nowhere/tool.cmd x', null)
  await isBatch('~/tool.cmd x', null)
  await isBatch('./missing.cmd x', null, { cwd: BIN })
  const spaced = await plan('spaced.cmd --x "a b"', { path: BIN_SPACED })
  check('a batch under a directory with spaces resolves quoted', spaced.kind === 'batch' && spaced.commandLine === `""${join(BIN_SPACED, 'spaced.cmd')}" "--x" "a b""`, JSON.stringify(spaced).slice(0, 160) + PLAN_HINT)
}

section('§4 the live seam: a PATH-found batch receives its arguments byte-for-byte')
if (process.platform !== 'win32') {
  console.log('  [SKIP] the live legs run .cmd files through cmd.exe; this host has no cmd.exe (the Windows box runs them live)')
} else {
  const LIVE_BIN = mkdtempSync(join(tmpdir(), 'batch prove live-'))
  const dumpPath = join(LIVE_BIN, 'argv.json')
  writeFileSync(join(LIVE_BIN, 'dump.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.argv))\n`)
  writeBatch(join(LIVE_BIN, 'echoargs.cmd'), ['@echo off', 'node "%~dp0dump.mjs" %*', 'exit /b %errorlevel%'])
  writeBatch(join(LIVE_BIN, 'code42.cmd'), ['@echo off', 'exit /b 42'])
  const readDump = (): string[] => {
    try {
      return JSON.parse(readFileSync(dumpPath, 'utf8')).slice(2)
    } catch {
      return ['(no dump)']
    }
  }

  const was = process.env.PATH ?? ''
  process.env.PATH = `${LIVE_BIN};${was}`
  process.env.BATCHPROOFVAR = 'SHOULD-NOT-EXPAND'
  const { exec, setCwd } = await import('../../src/platform/shell/shellExec.ts')
  const SCRATCH = mkdtempSync(join(tmpdir(), 'batch-prove-run-'))
  mkdirSync(join(SCRATCH, 'work'), { recursive: true })
  setCwd(SCRATCH)

  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const makeBangContext = (): never => {
    let appState = getDefaultAppState()
    return {
      options: { commands: [], verbose: false, engineModel: 'claude-sonnet-5', tools: [BashTool], mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
      abortController: new AbortController(),
      readFileState: new Map(),
      getAppState: () => appState,
      setAppState: (update: (state: typeof appState) => typeof appState) => {
        appState = update(appState)
      },
      messages: [],
      setResponseLength: () => undefined,
      updateFileHistoryState: () => undefined,
      updateAttributionState: () => undefined,
      toolUseId: 'batch-bang',
    } as never
  }

  const run = async (command: string, timeout = 20_000): Promise<{ code: number; out: string; err: string }> => {
    const handle = await exec(command, new AbortController().signal, 'bash', { timeout, shouldAutoBackground: false })
    const r = await handle.result
    handle.cleanup()
    return { code: r.code, out: r.stdout, err: r.stderr }
  }

  const expectArgv = async (label: string, command: string, want: string[]): Promise<void> => {
    writeFileSync(dumpPath, 'stale')
    const r = await run(command)
    const got = readDump()
    const ok = r.code === 0 && JSON.stringify(got) === JSON.stringify(want)
    check(label, ok, `code ${r.code} argv ${JSON.stringify(got).slice(0, 160)}${r.err ? ` err ${JSON.stringify(r.err.slice(0, 80))}` : ''}${EXEC_HINT}`)
  }

  {
    const local = join(SCRATCH, 'Café Ledger')
    mkdirSync(local)
    const previous = process.env.NoDefaultCurrentDirectoryInExePath
    process.env.NoDefaultCurrentDirectoryInExePath = '1'
    try {
      for (const name of ['hello.bat', 'totals.cmd']) {
        writeBatch(join(local, name), ['@echo off', 'echo LOCAL-BATCH', 'exit /b 23'])
        const handle = await exec(name, new AbortController().signal, 'bash', { cwd: local, timeout: 20_000, shouldAutoBackground: false })
        const result = await handle.result
        handle.cleanup()
        check(`${name} runs from the explicit working directory with current-directory executable lookup disabled`, result.code === 23 && result.stdout.includes('LOCAL-BATCH'), JSON.stringify(result) + EXEC_HINT)
      }
    } finally {
      if (previous === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath
      else process.env.NoDefaultCurrentDirectoryInExePath = previous
    }
  }
  await expectArgv('a bare name that only exists as .cmd runs and every byte survives: caret, percent, spaces, bang, backslash, non-ASCII',
    'echoargs a^b %BATCHPROOFVAR% "pl ain" "C:\\dir\\\\" x!y! ünï',
    ['a^b', '%BATCHPROOFVAR%', 'pl ain', 'C:\\dir\\', 'x!y!', 'ünï'])
  await expectArgv('the spelled-out extension keeps the same literal contract',
    'echoargs.cmd --flag=%BATCHPROOFVAR% a^b',
    ['--flag=%BATCHPROOFVAR%', 'a^b'])

  {
    writeFileSync(dumpPath, 'stale')
    const r = await run('echoargs.cmd hi | tr a-z A-Z')
    check('a pipeline still runs through the shell (the batch bridge never takes it)', r.code === 0, `code ${r.code} out ${JSON.stringify(r.out.trim().slice(0, 60))}${EXEC_HINT}`)
    check('…and the piped row ran the batch through the shell, not the bridge', JSON.stringify(readDump()) === JSON.stringify(['hi']), JSON.stringify(readDump()).slice(0, 80) + EXEC_HINT)
  }
  {
    const r = await run('code42.cmd')
    check('the batch exit code reaches the tool result', r.code === 42, `code ${r.code}${EXEC_HINT}`)
  }
  {
    writeFileSync(dumpPath, 'stale')
    const r = await run('! echoargs.cmd x')
    check('a negated batch stays on the shell and its inversion holds', r.code === 1, `code ${r.code}${PLAN_HINT} (a negated command must stay ordinary)`)
    check('…and the negated row ran through the shell, not the bridge', JSON.stringify(readDump()) === JSON.stringify(['x']), JSON.stringify(readDump()).slice(0, 80) + PLAN_HINT)
  }
  {
    writeFileSync(dumpPath, 'stale')
    const r = await run('echoargs.cmd hi > redirect-out.txt')
    let redirected: string | null = null
    try {
      redirected = readFileSync(join(SCRATCH, 'redirect-out.txt'), 'utf8')
    } catch {
      redirected = null
    }
    check('a redirected batch stays on the shell and the redirect lands', r.code === 0 && redirected !== null, `code ${r.code} file ${JSON.stringify(redirected)}${PLAN_HINT}`)
    check('…and the redirected row ran through the shell, not the bridge', JSON.stringify(readDump()) === JSON.stringify(['hi']), JSON.stringify(readDump()).slice(0, 80) + PLAN_HINT)
  }
  {
    const r = await run('node -e "process.stdout.write(String(6*7))"')
    check('a non-batch program is untouched by the bridge', r.code === 0 && r.out.trim() === '42', `code ${r.code} out ${JSON.stringify(r.out.trim().slice(0, 40))}${PLAN_HINT}`)
  }

  {
    const { TaskOutput } = await import('../../src/engine/task-framework/taskOutput.ts')
    const { tailFile } = await import('../../src/platform/files/fsOperations.ts')
    writeBatch(join(LIVE_BIN, 'staged.cmd'), [
      '@echo off',
      'echo STAGED-LINE',
      ':wait',
      'if not exist "%~dp0gate.txt" (ping -n 2 127.0.0.1 >nul & goto wait)',
      'exit /b 0',
    ])
    rmSync(join(LIVE_BIN, 'gate.txt'), { force: true })
    const controller = new AbortController()
    const handle = await exec('staged.cmd', controller.signal, 'bash', { timeout: 60_000, shouldAutoBackground: false })
    TaskOutput.startPolling(handle.taskOutput.taskId)
    let seenStaged = false
    const deadline = Date.now() + 10_000
    while (!seenStaged && Date.now() < deadline) {
      try {
        const tail = await tailFile(handle.taskOutput.path, 4096)
        if (tail.content.includes('STAGED-LINE')) seenStaged = true
      } catch {
      }
      if (!seenStaged) await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
    writeFileSync(join(LIVE_BIN, 'gate.txt'), '')
    const result = await handle.result
    TaskOutput.stopPolling(handle.taskOutput.taskId)
    handle.cleanup()
    check('a batch that prints reaches the live tail file while it still runs', seenStaged, 'no staged line in the tail within 10s' + EXEC_HINT)
    check('…and the same batch settles 0 once its gate opens', result.code === 0, `code ${result.code}${EXEC_HINT}`)
  }

  {
    const { processBashCommand } = await import('../../src/engine/user-input/processBashCommand.tsx')
    const { extractTag } = await import('../../src/engine/messages/messages.ts')
    const outcome = await processBashCommand('echoargs.cmd from-bang %BATCHPROOFVAR%', [], [], makeBangContext(), (() => undefined) as never)
    const texts = (outcome.messages as Array<{ message?: { content?: unknown } }>).map(m => (typeof m.message?.content === 'string' ? m.message.content : ''))
    const card = texts.find(text => text.startsWith('<bash-stdout>'))
    const dump = readDump()
    const bangOk = card !== undefined && extractTag(card, 'bash-exit-code') === '0' && JSON.stringify(dump) === JSON.stringify(['from-bang', '%BATCHPROOFVAR%'])
    check('a bang command that names a batch keeps the literal contract through the same seam', bangOk, `card ${JSON.stringify(card ?? '').slice(0, 80)} dump ${JSON.stringify(dump)}${EXEC_HINT} (the bang path is processBashCommand in src/engine/user-input/processBashCommand.tsx)`)
  }

  process.env.PATH = was
}


console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL WINDOWS BATCH INVOCATION PROOFS PASS')
else console.log(` ❌ ${failures} WINDOWS BATCH INVOCATION CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)

