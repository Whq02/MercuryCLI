#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    check('a daemon that settles reports settled', settled === 'settled', settled)
    const unreachable = await shutdownOwnedDaemonGracefully(4242, {
      rpc: async () => {
        throw new Error('no socket')
      },
      alive: () => true,
      waitMs: 300,
    })
    check('an unreachable daemon reports unsettled (never a claim of a clean stop)', unreachable === 'unsettled', unreachable)
    const stubborn = await shutdownOwnedDaemonGracefully(4242, {
      rpc: async () => ({ ok: true, op: 'shutdown', reaped: 0 }),
      alive: () => true,
      waitMs: 300,
    })
    check('a daemon that answers but does not go down reports unsettled (bounded, never a hang)', stubborn === 'unsettled', stubborn)
  }
}

section('§2 the hard kill is a BACKSTOP, not the first road')
{
  check('the reap decision is pure and exported', typeof decideDaemonReap === 'function')
  if (decideDaemonReap) {
    const d = decideDaemonReap
    check('win32, the ask settled it ⇒ nothing to kill', d({ platform: 'win32', gracefulAsked: true, stillAlive: false }) === 'already-down')
    check('win32, the ask did NOT settle it ⇒ the hard kill still fires', d({ platform: 'win32', gracefulAsked: true, stillAlive: true }) === 'hard-kill')
    check('win32, no ask ran at all (a crash) ⇒ the hard kill fires', d({ platform: 'win32', gracefulAsked: false, stillAlive: true }) === 'hard-kill')
    check('posix keeps its signal road unchanged', d({ platform: 'linux', gracefulAsked: false, stillAlive: true }) === 'signal')
    check('posix with a dead daemon does nothing', d({ platform: 'darwin', gracefulAsked: false, stillAlive: false }) === 'already-down')
  }
}

section('§3 the ordinary quit runs the ask BEFORE any exit hook')
{
  const src = read('src', 'daemon', 'ownedDaemon.ts')
  check('the reaper registers a cleanup (the async road gracefulShutdown awaits)', /registerCleanup\(/.test(src), 'without it the only road left is TerminateProcess')
  check('the sync exit hook still stands behind it', /process\.once\('exit'/.test(src))
  check('the SIGHUP arm is kept', /process\.once\('SIGHUP'/.test(src))
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

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-quit-reaps-the-tree${failures ? ` (${failures} failure(s))` : ''}`)
console.log('FIELD-OWED: the win32 live confirmation — quit an interactive session on the Windows box and census that the daemon, its seats and their children are all gone (this Mac proves the class call-shaped).')
process.exit(failures === 0 ? 0 : 1)
