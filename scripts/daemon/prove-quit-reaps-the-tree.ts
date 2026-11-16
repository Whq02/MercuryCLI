#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-quit-reaps-home-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')
const owned = (await import('../../src/daemon/ownedDaemon.ts')) as Record<string, unknown>
const decideDaemonReap = owned.decideDaemonReap as
  | ((facts: { platform: NodeJS.Platform; gracefulAsked: boolean; stillAlive: boolean }) => string)
  | undefined
const shutdownOwnedDaemonGracefully = owned.shutdownOwnedDaemonGracefully as
  | ((pid: number, opts?: { rpc?: (req: unknown, o: { timeoutMs: number }) => Promise<unknown>; alive?: (pid: number) => boolean; waitMs?: number }) => Promise<string>)
  | undefined

console.log('============================================================')
console.log(' quitting reaps the daemon, its seats and their children')
console.log('============================================================')

section('§1 the graceful ask is the first road on win32')
{
  check('the graceful ask exists', typeof shutdownOwnedDaemonGracefully === 'function')
  if (shutdownOwnedDaemonGracefully) {
    let asked: Record<string, unknown> | null = null
    const settled = await shutdownOwnedDaemonGracefully(4242, {
      rpc: async req => {
        asked = req as Record<string, unknown>
        return { ok: true, op: 'shutdown', reaped: 2 }
      },
      alive: () => false,
      waitMs: 500,
    })
    check('it asks the daemon to shut down through the control socket', asked !== null && (asked as { op?: string }).op === 'shutdown', JSON.stringify(asked))
    check('…and asks for the SEATS to be reaped with it (the orphan estate)', (asked as { reapWorkers?: boolean } | null)?.reapWorkers === true, JSON.stringify(asked))
    check('a daemon that answers is left to end itself (asked)', settled === 'asked', settled)
    const unreachable = await shutdownOwnedDaemonGracefully(4242, {
      rpc: async () => {
        throw new Error('no socket')
      },
      alive: () => true,
      waitMs: 300,
    })
    check('an unreachable daemon reports unsettled (never a claim of a clean stop)', unreachable === 'unsettled', unreachable)
    const gone = await shutdownOwnedDaemonGracefully(4242, {
      rpc: async () => {
        throw new Error('no socket')
      },
      alive: () => false,
      waitMs: 300,
    })
    check('a daemon that does not answer and is already down reports settled', gone === 'settled', gone)
    const began = Date.now()
    const stubborn = await shutdownOwnedDaemonGracefully(4242, {
      rpc: async () => ({ ok: true, op: 'shutdown', reaped: 0 }),
      alive: () => true,
      waitMs: 300,
    })
    const waited = Date.now() - began
    check(`a daemon that answers and is still up is not waited for: the front lets the person go and the daemon ends itself by its own bounds (${waited} ms)`, stubborn === 'asked' && waited < 250, `${stubborn} after ${waited} ms`)
    const { daemonControlRpc } = (await import('../../src/daemon/controlSocket.ts')) as { daemonControlRpc: (req: unknown, o: { timeoutMs: number }) => Promise<{ ok?: boolean; code?: string }> }
    let own = 'it threw'
    try {
      const reply = await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 300 })
      own = `ok ${String(reply.ok)}, code ${String(reply.code)}`
    } catch (error) {
      own = `it threw: ${String(error).slice(0, 120)}`
    }
    check('the product’s own call to a daemon that is not there does not throw: it answers ok: false', own === 'ok false, code ENOCONN', own)
    const noAnswer = (code: string, alive: boolean): Promise<string> =>
      shutdownOwnedDaemonGracefully(4242, { rpc: async () => ({ ok: false, code, error: `daemon unreachable (${code})` }), alive: () => alive, waitMs: 300 })
    const outcomes = [await noAnswer('ENOCONN', true), await noAnswer('ETIMEOUT', true), await noAnswer('EUNKNOWN', true), await noAnswer('ENOCONN', false)]
    check(
      'so an answer of ok: false is no answer: unsettled while the daemon stands (not reached, not answering in time, or refusing), settled once it is gone',
      outcomes.join(' ') === 'unsettled unsettled unsettled settled',
      outcomes.join(' '),
    )
  }
}

section('§2 the hard kill is a BACKSTOP, not the first road')
{
  check('the reap decision is pure and exported', typeof decideDaemonReap === 'function')
  if (decideDaemonReap) {
    const d = decideDaemonReap
    check('win32, the ask settled it ⇒ nothing to kill', d({ platform: 'win32', gracefulAsked: true, stillAlive: false }) === 'already-down')
    check('win32, asked and still up ⇒ left to end itself: it asks its runners, they do their own exit work, and its own bounds end it', d({ platform: 'win32', gracefulAsked: true, stillAlive: true }) === 'asked')
    check('win32, no ask ran at all (a crash) ⇒ the hard kill fires', d({ platform: 'win32', gracefulAsked: false, stillAlive: true }) === 'hard-kill')
    check('posix keeps its signal road unchanged', d({ platform: 'linux', gracefulAsked: false, stillAlive: true }) === 'signal')
    check('posix with a dead daemon does nothing', d({ platform: 'darwin', gracefulAsked: false, stillAlive: false }) === 'already-down')
    check(
      'and no other platform ever reads asked: darwin and linux answer signal whatever was asked',
      (['darwin', 'linux'] as const).every(platform => [true, false].every(gracefulAsked => d({ platform, gracefulAsked, stillAlive: true }) === 'signal')),
    )
  }
}

section('§3 the ordinary quit runs the ask BEFORE any exit hook')
{
  const src = read('src', 'daemon', 'ownedDaemon.ts')
  check('the reaper registers a cleanup (the async road gracefulShutdown awaits)', /registerCleanup\(/.test(src), 'without it the only road left is TerminateProcess')
  check('the sync exit hook still stands behind it', /process\.once\('exit'/.test(src))
  check('the SIGHUP arm is kept', /process\.once\('SIGHUP'/.test(src))
  const askAt = src.indexOf("process.once('SIGHUP', () => void askToShutDown())")
  check('on win32 a closed window (SIGHUP) asks the daemon before the reap decides', askAt >= 0 && askAt < src.indexOf("process.once('SIGHUP', reap)"))
  check('…and a daemon that does not answer the ask meets the hard kill at once', /if \(outcome !== 'unsettled'\) return\s+gracefulAsked = false\s+reap\(\)/.test(src))
  check('the hard kill is gated on the reap decision', /decideDaemonReap\(/.test(src))
}

section('§4 LIVE — a reaped seat takes its own children with it')
{
  const roster = read('src', 'daemon', 'roster.ts')
  check('the roster kill routes through the one tree owner', /killProcessGroup\(|endProcessTree\(/.test(roster), 'a root-only kill leaves the seat\'s build/test/dev-server children running')
  check('…and no bare child.kill remains on the roster kill road', !/h\.child\?\.kill\(signal\)/.test(roster))
  const services = read('src', 'services', 'projectServices', 'serviceManager.ts')
  check('the session-service reaper ends trees at the quit', /killProcessGroup\(|endProcessTree\(/.test(services.slice(services.indexOf("process.once('exit'"), services.indexOf("process.once('exit'") + 900)) || /registerCleanup\(/.test(services), 'a session service\'s grandchild outlived the quit')

  const { killProcessGroup } = await import('../../src/utils/processGroup.ts')
  const leader = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process'); const kid=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'}); console.log(kid.pid); setInterval(()=>{},1000)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env },
  })
  let kid = 0
  leader.stdout?.on('data', (b: Buffer) => {
    kid = Number(String(b).trim()) || kid
  })
  const deadline = Date.now() + 4000
  while (kid === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  check('the fixture leader has a child', kid > 0, String(kid))
  killProcessGroup(leader, 'SIGKILL')
  const gone = async (pid: number): Promise<boolean> => {
    const until = Date.now() + 6000
    while (Date.now() < until) {
      try {
        process.kill(pid, 0)
      } catch (e) {
        if ((e as { code?: string }).code !== 'EPERM') return true
      }
      await new Promise(r => setTimeout(r, 50))
    }
    return false
  }
  check('the tree owner ends the leader', await gone(leader.pid ?? 0))
  check('…and the grandchild with it', kid > 0 && (await gone(kid)))
  try {
    if (kid) process.kill(kid, 'SIGKILL')
  } catch {
  }
}

section('§5 a worker whose daemon died exits through the cleanup registry')
{
  const watch = read('src', 'daemon', 'workerParentWatch.ts')
  check('the orphan exit is no longer a bare process.exit(0)', /gracefulExit|runCleanupFunctions|gracefulShutdown/.test(watch), 'in-flight transcript appends were discarded')
  check('…and it is still bounded (a wedged cleanup can never hold a dead worker)', /setTimeout|cap|budget/i.test(watch))
  const { __workerOrphanExitForTest } = (await import('../../src/daemon/workerParentWatch.ts')) as Record<string, unknown> as {
    __workerOrphanExitForTest?: (opts: { exit: (c: number) => void; cleanup: () => Promise<void>; capMs?: number }) => Promise<void>
  }
  check('the exit road is drivable', typeof __workerOrphanExitForTest === 'function')
  if (__workerOrphanExitForTest) {
    let ran = false
    let code: number | null = null
    await __workerOrphanExitForTest({
      exit: c => {
        code = c
      },
      cleanup: async () => {
        ran = true
      },
      capMs: 500,
    })
    check('the cleanup registry runs before the exit', ran)
    check('…and the worker still exits 0', code === 0, String(code))
    let wedgedExit: number | null = null
    const started = Date.now()
    await __workerOrphanExitForTest({
      exit: c => {
        wedgedExit = c
      },
      cleanup: () => new Promise<void>(() => {}),
      capMs: 400,
    })
    check(`a WEDGED cleanup still exits, at its cap (${Date.now() - started}ms)`, wedgedExit === 0 && Date.now() - started < 4000)
  }
}

section('§6 the exit-cliff estate is untouched')
{
  const graceful = read('src', 'utils', 'gracefulShutdown.ts')
  check('the graceful road still runs the cleanup registry', /runCleanupFunctions\(\)/.test(graceful))
  check('…still drains the named exit-cliff seams', /drainExitCliffSeams/.test(graceful))
  check('…and still quiesces before the cliff', /quiesceCleanupBeforeExit/.test(graceful))
}

section('§7 DRIVEN — the front’s own reaper in a process of its own, with a daemon that answers the ask, one that is not there, one that takes the call and never answers, and one that refuses')
{
  const { controlSockPath } = (await import('../../src/daemon/controlSocket.ts')) as { controlSockPath: () => string }
  const cap = Number(/const CLEANUP_TIMEOUT_MS = (\d+)/.exec(read('src', 'utils', 'gracefulShutdown.ts'))?.[1] ?? '2000')
  const worlds = mkdtempSync(join(tmpdir(), 'prove-quit-front-'))
  const frontFile = join(worlds, 'front.mjs')
  writeFileSync(
    frontFile,
    [
      "globalThis.MACRO = { VERSION: '1.0.0' }",
      'const [root, pidText, platform, road, notes, cap] = process.argv.slice(2)',
      "const { appendFileSync } = await import('node:fs')",
      "const { join } = await import('node:path')",
      "const { pathToFileURL } = await import('node:url')",
      "const note = step => appendFileSync(notes, JSON.stringify({ step, at: Date.now() }) + '\\n')",
      "if (platform !== 'host') Object.defineProperty(process, 'platform', { value: platform })",
      "const owned = await import(pathToFileURL(join(root, 'src', 'daemon', 'ownedDaemon.ts')).href)",
      "const { runCleanupFunctions } = await import(pathToFileURL(join(root, 'src', 'utils', 'cleanupRegistry.ts')).href)",
      'owned.adoptOwnedDaemonPid(Number(pidText))',
      "note('adopted')",
      "if (road === 'hangup') {",
      "  process.emit('SIGHUP')",
      '  await new Promise(done => setTimeout(done, 300))',
      "  note('after-hangup')",
      '}',
      'await Promise.race([runCleanupFunctions().catch(() => {}), new Promise(done => setTimeout(done, Number(cap)))])',
      "note('cleanups')",
      'process.exit(0)',
      '',
    ].join('\n'),
  )
  type Door = 'answers' | 'refuses' | 'silent' | 'none'
  let made = 0
  const drive = async (platform: string, road: 'hangup' | 'exit', door: Door): Promise<{ endedAt: number | null; at: Record<string, number>; calls: number; front: string }> => {
    const dir = join(worlds, `w${++made}`)
    mkdirSync(join(dir, 'daemon'), { recursive: true })
    const kept = process.env.MERCURY_DAEMON_DIR
    process.env.MERCURY_DAEMON_DIR = join(dir, 'daemon')
    const doorPath = controlSockPath()
    if (kept === undefined) delete process.env.MERCURY_DAEMON_DIR
    else process.env.MERCURY_DAEMON_DIR = kept
    let calls = 0
    let server: Server | null = null
    const callers: Socket[] = []
    if (door !== 'none') {
      server = createServer(sock => {
        callers.push(sock)
        sock.on('error', () => {})
        sock.on('data', () => {
          calls++
          if (door === 'answers') sock.write(JSON.stringify({ ok: true, op: 'shutdown', reaped: 0, workers: [] }) + '\n')
          if (door === 'refuses') sock.write(JSON.stringify({ ok: false, code: 'EUNKNOWN', error: 'refused' }) + '\n')
        })
      })
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(doorPath, resolve)
      })
    }
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    const daemonEnd: { at: number | null } = { at: null }
    daemon.on('exit', () => {
      daemonEnd.at = Date.now()
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    const notes = join(dir, 'notes.jsonl')
    writeFileSync(notes, '')
    const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: dir, MERCURY_DAEMON_DIR: join(dir, 'daemon') }
    delete env.MERCURY_DAEMON_PERSIST
    const front = spawn(process.execPath, [frontFile, ROOT, String(daemon.pid), platform, road, notes, String(cap)], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let said = ''
    front.stderr?.on('data', chunk => (said += String(chunk)))
    const code = await new Promise<number | null>(resolve => front.on('exit', resolve))
    const left = Date.now()
    await new Promise(resolve => setTimeout(resolve, 500))
    const at: Record<string, number> = { left }
    for (const line of readFileSync(notes, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as { step: string; at: number }
      at[row.step] = row.at
    }
    if (daemonEnd.at === null) daemon.kill('SIGKILL')
    for (const sock of callers) sock.destroy()
    if (server !== null) await new Promise<void>(resolve => server!.close(() => resolve()))
    return { endedAt: daemonEnd.at, at, calls, front: `the front left with ${String(code)}${said.trim() === '' ? '' : `: ${said.trim().split('\n').slice(-1)[0]!.slice(0, 160)}`}` }
  }
  const words = (run: Awaited<ReturnType<typeof drive>>): string =>
    `${run.endedAt === null ? 'the daemon stood 500 ms after the front had left' : `the daemon ended ${run.endedAt - run.at.left!} ms ${run.endedAt <= run.at.left! ? 'before' : 'after'} the front left`}; the door was called ${run.calls} time(s); the cleanups returned ${(run.at.cleanups ?? 0) - (run.at['after-hangup'] ?? run.at.adopted ?? 0)} ms after they began; ${run.front}`
  const win32 = process.platform === 'win32' ? 'host' : 'win32'
  for (const road of ['hangup', 'exit'] as const) {
    const answered = await drive(win32, road, 'answers')
    const span = (answered.at.cleanups ?? Infinity) - (answered.at['after-hangup'] ?? answered.at.adopted ?? 0)
    check(`win32, ${road === 'hangup' ? 'the window closed' : 'the front’s own exit'}, the daemon answers the ask: the front asks once, does not wait for the daemon’s end and leaves it standing`, answered.endedAt === null && answered.calls >= 1 && span < 1000, words(answered))
    const absent = await drive(win32, road, 'none')
    check(`win32, ${road === 'hangup' ? 'the window closed' : 'the front’s own exit'}, no daemon answers at its door: the front ends it`, absent.endedAt !== null, words(absent))
    const silent = await drive(win32, road, 'silent')
    check(
      `win32, ${road === 'hangup' ? 'the window closed' : 'the front’s own exit'}, the daemon takes the call and never answers: it stands while the ask is out and the front ends it as it leaves`,
      silent.endedAt !== null && silent.calls >= 1 && silent.endedAt >= (silent.at.cleanups ?? Infinity),
      words(silent),
    )
  }
  const refused = await drive(win32, 'exit', 'refuses')
  check('win32, the daemon answers ok: false: that is no answer, and the front ends it', refused.endedAt !== null && refused.calls >= 1, words(refused))
  if (process.platform === 'win32') console.log('  [SKIP] where a signal is the ask the front signals its daemon at the hangup at once and never calls its door — not driven on win32: the product’s files are not loaded under another platform’s name there; §2’s table holds the choice')
  else {
    const hung = await drive('host', 'hangup', 'answers')
    const quit = await drive('host', 'exit', 'answers')
    check(
      `on ${process.platform}, where a signal is the ask: the front signals its daemon in the hangup’s own tick and at its own exit, and never calls its door`,
      hung.endedAt !== null && hung.endedAt < (hung.at['after-hangup'] ?? 0) && hung.calls === 0 && quit.endedAt !== null && quit.endedAt >= (quit.at.cleanups ?? Infinity) && quit.calls === 0,
      `the hangup: ${words(hung)} · the exit: ${words(quit)}`,
    )
  }
  rmSync(worlds, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-quit-reaps-the-tree${failures ? ` (${failures} failure(s))` : ''}`)
console.log('FIELD-OWED: the win32 live confirmation — quit an interactive session on the Windows box and census that the daemon, its seats and their children are all gone (this Mac proves the class call-shaped).')
process.exit(failures === 0 ? 0 : 1)
