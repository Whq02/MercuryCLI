#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'teardown-tree-home-'))

let failures = 0
let hint = ''
const check = (label: string, cond: boolean, detail = ''): void => {
  const text = [detail, hint].filter(part => part !== '').join('; ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && text ? ' — ' + text : ''}`)
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
    }
  }
}

if (process.platform === 'win32') {
  console.log('  [SKIP — LOUD] the live grandchild drills ride the POSIX process table; the win32 taskkill arm is the field leg')
}

section('§1 the cmake build timeout ends the driver AND its descendants')
if (process.platform !== 'win32') {
  hint = 'buildTarget in src/integrations/ide/cppBuild.ts must end the whole process tree of cmake on a timeout, not only the leader (see endProcessTree in src/platform/processes/processGroup.ts)'
  const root = mkdtempSync(join(tmpdir(), 'teardown-tree-cmake-'))
  const shimDir = join(root, 'shim')
  mkdirSync(shimDir)
  const pidFile = join(root, 'grandchild.pid')
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
    const { buildTarget, _resetCppBuildForTesting } = await import('../../src/integrations/ide/cppBuild.ts')
    const { _resetCppProjectForTesting } = await import('../../src/integrations/ide/cppProject.ts')
    _resetCppProjectForTesting()
    _resetCppBuildForTesting()
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
  hint = 'stop() of the client from createLSPClient in src/integrations/lsp/LSPClient.ts must end the server and its descendants'
  const root = mkdtempSync(join(tmpdir(), 'teardown-tree-lsp-'))
  const pidFile = join(root, 'grandchild.pid')
  const server = join(root, 'fixture-server.mjs')
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
    const { createLSPClient } = await import('../../src/integrations/lsp/LSPClient.ts')
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


section('§4 the win32 survivor half — the reap covers the acted set')
{
  hint = 'fix taskkillActedPids in src/platform/processes/processGroup.ts'
  const { taskkillActedPids } = await import('../../src/platform/processes/processGroup.ts')
  const transcript = [
    'SUCCESS: The process with PID 100 (child of PID 7) has been terminated.',
    'SUCCESS: The process with PID 101 (child of PID 100) has been terminated.',
    'SUCCESS: The process with PID 7 has been terminated.',
  ].join('\r\n')
  check('the transcript reader names every acted pid once, first token per line', JSON.stringify(taskkillActedPids(transcript)) === '[100,101,7]', JSON.stringify(taskkillActedPids(transcript)))
  check('a repeated pid cannot double-join', JSON.stringify(taskkillActedPids('x PID 100 x\nx PID 100 x')) === '[100]')
  check('failure text with no PID token yields none', taskkillActedPids('ERROR: The process "4242" not found.').length === 0)
}

section("§5 the shell engine's end ends the brush AND its descendants")
if (process.platform !== 'win32') {
  hint = 'endEngineSession in src/platform/shell/engineSession.ts must end the brush process and its descendants'
  const { resolveShellEngine, runEngineCommand, endEngineSession, resetEngineSessionForTest } = await import('../../src/platform/shell/engineSession.ts')
  const resolution = resolveShellEngine('brush')
  if (resolution.engine !== 'brush') {
    console.log(`  [SKIP — LOUD] no shell engine pack on this host (${resolution.reason}) — the engine leg runs where the pack is`)
  } else {
    const root = mkdtempSync(join(tmpdir(), 'teardown-tree-engine-'))
    const pidFile = join(root, 'grandchild.pid')
    const controller = new AbortController()
    const run = (command: string) => runEngineCommand(resolution.binaryPath, command, { timeout: 10_000, signal: controller.signal }).result
    let grandchild = -1
    try {
      const who = await run('echo "pid=$$"')
      const brushPid = Number(/pid=(\d+)/.exec(who.stdout)?.[1] ?? -1)
      check('the engine session answered with its pid', brushPid > 1, JSON.stringify(who.stdout.slice(0, 80)))
      await run(`sh -c 'sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait' >/dev/null 2>&1 &`)
      grandchild = await readPid(pidFile)
      check('the fixture recorded a descendant of the session', grandchild > 1, `pid=${grandchild}`)
      await endEngineSession()
      check('the brush process is gone after the session end', brushPid > 1 && (await diedWithin(brushPid, 2_500)), `pid ${brushPid} still alive 2.5 s after the end`)
      check('the descendant is gone too (tree, not leader)', grandchild > 1 && (await diedWithin(grandchild, 2_500)), `pid ${grandchild} still alive 2.5 s after the end`)
    } finally {
      reap(grandchild)
      resetEngineSessionForTest()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

section('§6 from the built bundle, under Node: a session interrupted while a search runs ends the search program, though it ignores SIGTERM')
if (process.platform !== 'win32') {
  hint = 'an interrupted session must kill the search program it spawned (SIGKILL after SIGTERM is ignored); rebuild dist with bun run build.ts first if the bundle is stale'
  const { spawn } = await import('node:child_process')
  const { realpathSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const distAt = process.argv.indexOf('--dist')
  const dist = distAt === -1 ? join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs') : resolve(process.argv[distAt + 1]!)
  if (!existsSync(dist)) {
    console.log('  [SKIP — LOUD] dist/mercury.mjs absent — build first (the gate prebuilds)')
  } else {
    const { FIXTURE_API_KEY, seedFirstRun } = await import('../lib/firstRunSeed.ts')
    const { startFixtureApi } = await import('../lib/fixtureApi.ts')
    const { nodeBinPath } = await import('../lib/nodeBin.ts')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'teardown-tree-search-')))
    const [home, config, cwd, bin] = ['user-home', 'config-home', 'work', 'bin'].map(name => join(root, name)) as [string, string, string, string]
    for (const dir of [home, config, cwd, bin]) mkdirSync(dir)
    const pidFile = join(root, 'search.pid')
    writeFileSync(join(bin, 'rg'), `#!/bin/sh\ncase " $* " in *" --version "*) echo "ripgrep 14.1.0"; exit 0;; esac\ntrap '' TERM INT\necho "$$" > ${JSON.stringify(pidFile)}\nwhile :; do /bin/sleep 1; done\n`)
    chmodSync(join(bin, 'rg'), 0o755)
    writeFileSync(join(cwd, 'a.txt'), 'needle\n')
    seedFirstRun(config, [cwd])
    const api = await startFixtureApi([
      { kind: 'tool_use', name: 'Grep', id: 'toolu_search', input: { pattern: 'needle' } },
      { kind: 'text', text: 'done' },
    ])
    let searching = -1
    try {
      const child = spawn(nodeBinPath(), [dist, 'run', '--mode', 'sovereign', '--model', 'claude-opus-4-8', '--format', 'text', 'teardown-search'], {
        cwd,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          HOME: home,
          SHELL: '/bin/zsh',
          TERM: 'dumb',
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          TMPDIR: tmpdir(),
          MERCURY_CONFIG_DIR: config,
          MERCURY_DAEMON_DIR: join(config, 'daemon'),
          MERCURY_CREDENTIAL_STORE: 'file',
          MERCURY_LOCAL_PROBE_TARGETS: 'none',
          MERCURY_BUILTIN_RIPGREP: '0',
          ANTHROPIC_API_KEY: FIXTURE_API_KEY,
          ANTHROPIC_BASE_URL: api.url,
        },
      })
      const ended = new Promise<number | null>(done => child.once('exit', code => done(code)))
      const began = Date.now()
      while (!existsSync(pidFile) && Date.now() - began < 60_000) await sleep(50)
      searching = await readPid(pidFile)
      check('the session started the search program it was handed (a stand-in that ignores SIGTERM and never answers)', searching > 1, `pid=${searching}`)
      await sleep(500)
      child.kill('SIGINT')
      const guard = setTimeout(() => child.kill('SIGKILL'), 60_000)
      const code = await ended
      clearTimeout(guard)
      check('the interrupted session ended by itself', code !== null, `exit ${String(code)}`)
      check('the search program is gone 2.5 s after the session ended: it was killed, not asked', searching > 1 && (await diedWithin(searching, 2_500)), `pid ${searching} still alive`)
    } finally {
      reap(searching)
      await api.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
if (failures > 0) {
  console.error(`\nprove-teardown-ends-the-tree: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-teardown-ends-the-tree: all green')
process.exit(0)
