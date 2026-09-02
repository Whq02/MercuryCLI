#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-teardown-ends-the-tree.ts — tool-lane teardown ends
//  the TREE, not the direct child (FN-015 rank 20).
//
//  Three force-kills never reached the estate's one tree-kill owner
//  (utils/processGroup): the CMake build timeout killed the cmake driver
//  and left the generator, compiler and linker beneath it holding their
//  output files; the language-server stop sent a bare kill() to a child
//  that, for a .cmd shim, is cmd.exe — the real server stayed resident with
//  its workspace index; the debug-adapter dispose SIGKILLed the adapter and
//  left the debuggee (its grandchild) running on its port. Each now routes
//  through endProcessTree / killProcessGroup.
//    §1 cmake timeout, LIVE: a shim cmake that starts a grandchild and
//       hangs — after the timeout leg fires, the grandchild is gone.
//    §2 language-server stop, LIVE: a fixture server that answers
//       initialize, starts a grandchild and never answers shutdown — after
//       stop()'s graceful budget expires, the grandchild is gone.
//    §3 debug-adapter dispose — call-shaped pins (the mock adapters spawn
//       no debuggee; the mechanism is the same owner §1 and §2 drive).
//  The POSIX arm is the one this host can drive; the win32 taskkill arm is
//  Windows-box work.
//
//  Run: ~/.bun/bin/bun run scripts/bash/prove-teardown-ends-the-tree.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'teardown-tree-home-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
/** Poll a pid to death inside a bound; true when it died. */
const diedWithin = async (pid: number, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(50)
  }
  return !alive(pid)
}
const readPid = async (file: string): Promise<number> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const n = Number(readFileSync(file, 'utf8').trim())
      if (Number.isInteger(n) && n > 1) return n
    }
    await sleep(25)
  }
  return -1
}
const reap = (pid: number): void => {
  if (pid > 1) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

if (process.platform === 'win32') {
  console.log('  [SKIP — LOUD] the live grandchild drills ride the POSIX process table; the win32 taskkill arm is the field leg')
}

section('§1 the cmake build timeout ends the driver AND its descendants')
if (process.platform !== 'win32') {
  const root = mkdtempSync(join(tmpdir(), 'teardown-tree-cmake-'))
  const shimDir = join(root, 'shim')
  mkdirSync(shimDir)
  const pidFile = join(root, 'grandchild.pid')
  // The shim starts a grandchild, records its pid and hangs like a wedged
  // generator: the timeout leg must fire, and the grandchild must not
  // outlive the driver.
  writeFileSync(join(shimDir, 'cmake'), `#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\nwait\n`)
  chmodSync(join(shimDir, 'cmake'), 0o755)
  const ws = join(root, 'ws')
  mkdirSync(join(ws, 'build'), { recursive: true })
  writeFileSync(join(ws, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\nproject(demo C)\n')
  writeFileSync(join(ws, 'build', 'CMakeCache.txt'), '# cache\n')
  const savedPath = process.env.PATH
  process.env.PATH = `${shimDir}:${savedPath ?? ''}`
  let grandchild = -1
  try {
    const { buildTarget, _resetCppBuildForTesting } = await import('../../src/services/ide/cppBuild.ts')
    const { _resetCppProjectForTesting } = await import('../../src/services/ide/cppProject.ts')
    _resetCppProjectForTesting()
    _resetCppBuildForTesting()
    // Three seconds: under a loaded box (a typecheck beside the pool) the
    // shim can take a second to reach its first line, and the timeout leg
    // must fire AFTER the grandchild was recorded for the assertion to mean
    // anything — the pid gate below says so when it did not.
    const run = await buildTarget({ from: ws, timeoutMs: 3_000 })
    grandchild = await readPid(pidFile)
    check('the shim cmake ran and the timeout leg fired', run.argv[0] === join(shimDir, 'cmake') && run.signal === 'SIGKILL' && run.exitCode === null, `${run.detail} argv=${run.argv.join(' ')}`)
    check('the fixture recorded its grandchild', grandchild > 1, `pid=${grandchild}`)
    const dead = grandchild > 1 && (await diedWithin(grandchild, 2_500))
    check('the grandchild is gone after the timeout kill (tree, not leader)', dead, `pid ${grandchild} still alive 2.5 s after the kill`)
  } finally {
    process.env.PATH = savedPath
    reap(grandchild)
    rmSync(root, { recursive: true, force: true })
  }
}

section('§2 the language-server stop ends the server AND its descendants')
if (process.platform !== 'win32') {
  const root = mkdtempSync(join(tmpdir(), 'teardown-tree-lsp-'))
  const pidFile = join(root, 'grandchild.pid')
  const server = join(root, 'fixture-server.mjs')
  // A server that speaks just enough LSP to initialize, starts a grandchild
  // (the shape of a .cmd shim whose cmd.exe hosts the real server, or a
  // server that forks its indexer), and never answers shutdown — so the
  // stop's graceful budget expires and the kill is the road taken.
  writeFileSync(
    server,
    [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      'const grand = spawn("sleep", ["30"], { stdio: "ignore" })',
      'writeFileSync(process.argv[2], String(grand.pid))',
      'let buf = Buffer.alloc(0)',
      'process.stdin.on("data", chunk => {',
      '  buf = Buffer.concat([buf, chunk])',
      '  for (;;) {',
      '    const headerEnd = buf.indexOf("\\r\\n\\r\\n")',
      '    if (headerEnd === -1) return',
      '    const m = /Content-Length: (\\d+)/i.exec(buf.subarray(0, headerEnd).toString())',
      '    if (!m) return',
      '    const start = headerEnd + 4',
      '    const len = Number(m[1])',
      '    if (buf.length < start + len) return',
      '    const body = JSON.parse(buf.subarray(start, start + len).toString())',
      '    buf = buf.subarray(start + len)',
      '    if (body.method === "initialize") {',
      '      const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } })',
      '      process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\\r\\n\\r\\n${payload}`)',
      '    }',
      '  }',
      '})',
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'),
  )
  let grandchild = -1
  try {
    const { createLSPClient } = await import('../../src/services/lsp/LSPClient.ts')
    const client = createLSPClient('teardown-fixture')
    await client.start(process.execPath, [server, pidFile])
    const init = await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} } as never)
    check('the fixture server initialized', init !== undefined && client.isInitialized)
    grandchild = await readPid(pidFile)
    check('the fixture recorded its grandchild', grandchild > 1, `pid=${grandchild}`)
    const started = Date.now()
    await client.stop({ gracefulTimeoutMs: 300 })
    const dead = grandchild > 1 && (await diedWithin(grandchild, 2_500))
    check('the grandchild is gone after stop() (tree, not leader)', dead, `pid ${grandchild} still alive 2.5 s after stop (stop took ${Date.now() - started}ms)`)
  } finally {
    reap(grandchild)
    rmSync(root, { recursive: true, force: true })
  }
}

section('§3 the debug-adapter dispose rides the tree owner (call-shaped)')
{
  const dap = readFileSync(join(import.meta.dir, '../../src/services/dap/dapClient.ts'), 'utf8')
  const disposeAt = dap.indexOf('async dispose(): Promise<void> {')
  const killSyncAt = dap.indexOf('killSync(): void {')
  const disposeBody = disposeAt !== -1 && killSyncAt !== -1 ? dap.slice(disposeAt, killSyncAt) : ''
  check('dispose() exists ahead of killSync()', disposeAt !== -1 && killSyncAt > disposeAt)
  check('dispose() ends the adapter TREE before the sync sweep', /await endProcessTree\(child, 'SIGKILL'\)/.test(disposeBody))
  check('…and strikes any survivor by pid', /endProcessTreeSurvivors\(/.test(disposeBody))
  check('the sync exit sweep keeps its leader kill (exit handlers cannot await — the documented residual)', /if \(this\.#child && this\.#child\.exitCode === null\) this\.#child\.kill\('SIGKILL'\)/.test(dap))
  const lsp = readFileSync(join(import.meta.dir, '../../src/services/lsp/LSPClient.ts'), 'utf8')
  check('LSPClient.stop() routes through the tree owner (no bare child.kill())', /await endProcessTree\(child, 'SIGTERM'\)/.test(lsp) && !/\n\s*child\.kill\(\)/.test(lsp))
  const cpp = readFileSync(join(import.meta.dir, '../../src/services/ide/cppBuild.ts'), 'utf8')
  // Re-trued at the release-blockers fold: the timeout leg moved into the ONE
  // settle owner, whose forced end routes through endProcessTree — the tree
  // kill this pin exists for, delivered by the owner instead of a local timer.
  check(
    'the cmake timeout rides the settle owner (tree-killing forced ends; no bare SIGKILL on the driver)',
    /void settleChildRun\(child, \{ timeoutMs \}\)/.test(cpp) && !/child\.kill\('SIGKILL'\)/.test(cpp),
  )
}

section('§4 the win32 survivor half — the reap covers the acted set')
{
  // endWin32Tree probed the ROOT alone, so the Windows survivor list was
  // always [] or [root] and endProcessTreeSurvivors could never run on the
  // platform that needs it most. taskkill's own transcript is the
  // descendant snapshot its walk took; the reap now polls that whole set.
  const { taskkillActedPids } = await import('../../src/utils/processGroup.ts')
  const transcript = [
    'SUCCESS: The process with PID 100 (child of PID 7) has been terminated.',
    'SUCCESS: The process with PID 101 (child of PID 100) has been terminated.',
    'SUCCESS: The process with PID 7 has been terminated.',
  ].join('\r\n')
  check('the transcript reader names every acted pid once, first token per line', JSON.stringify(taskkillActedPids(transcript)) === '[100,101,7]', JSON.stringify(taskkillActedPids(transcript)))
  check('a repeated pid cannot double-join', JSON.stringify(taskkillActedPids('x PID 100 x\nx PID 100 x')) === '[100]')
  check('failure text with no PID token yields none', taskkillActedPids('ERROR: The process "4242" not found.').length === 0)
  const group = readFileSync(join(import.meta.dir, '../../src/utils/processGroup.ts'), 'utf8')
  const win32At = group.indexOf('async function endWin32Tree(')
  const body = win32At !== -1 ? group.slice(win32At, group.indexOf('\n}\n', win32At)) : ''
  check('endWin32Tree reaps over the acted set plus the root, never the root alone', /const acted = taskkillActedPids\(stdout\)/.test(body) && /acted\.includes\(pid\) \? acted : \[pid, \.\.\.acted\]/.test(body))
  check('ended counts acted pids confirmed gone; survivors are whatever still lives', /const ended = acted\.filter\(/.test(body) && /survivors: remaining/.test(body))
  check('the POSIX arm keeps its snapshot-walk-strike-reap shape (untouched by this half)', /async function endPosixTree\(/.test(group) && /collectPosixTargets\(/.test(group) && /process\.kill\(-pid, signal\)/.test(group))
}

if (failures > 0) {
  console.error(`\nprove-teardown-ends-the-tree: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-teardown-ends-the-tree: all green')
process.exit(0)
