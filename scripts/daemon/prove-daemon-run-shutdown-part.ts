#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-run-shutdown-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 80; i++) await Promise.resolve()
}

const did: string[] = []
const note = (what: string): void => void did.push(what)
const script = { supersededBy: null as { pid: number; buildTree: string | null; alive: boolean } | null }
const timers: Array<{ ms: number; run: () => void; unref: boolean }> = []

const controlSocket = await import('../../src/daemon/controlSocket.ts')
const planeRecords = await import('../../src/daemon/planeRecords.ts')
const spawnLedger = await import('../../src/utils/spawnLedger.ts')
mock.module('../../src/daemon/controlSocket.ts', () => ({
  ...controlSocket,
  clearControlKey: async () => note('clear the control key'),
  clearDaemonState: async () => note('clear the daemon record'),
  markDaemonStoppingSync: () => {
    note('mark the record stopping')
    return true
  },
}))
mock.module('../../src/daemon/planeRecords.ts', () => ({ ...planeRecords, supersededByLivePlaneOwnerSync: () => script.supersededBy }))
mock.module('../../src/utils/spawnLedger.ts', () => ({ ...spawnLedger, recordSpawnExit: (row: { kind: string; event: string; id: string; reason: string }) => note(`ledger ${row.kind} ${row.event} ${row.id} ${row.reason}`) }))

const part = await import('../../src/daemon/run/shutdown.ts')
const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/utils/daemonBreaker.ts')

const KEEP_ALIVE = { the: 'keep-alive' } as unknown as ReturnType<typeof setInterval>
const needs = {
  keepAlive: KEEP_ALIVE,
  resolveShutdown: () => note('resolve the run'),
  spawnSuccessorDaemon: () => {
    note('spawn the successor')
    return 4242
  },
}
const planted = (controlEnabled = true): ReturnType<typeof makeDaemonRunState> => {
  const state = makeDaemonRunState({ dir: home, bootBuildTree: 'aaaaaaaaaaaa', foreground: false, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled })
  state.stopPlaneHeal = () => note('stop the plane heal')
  state.stopArmedBeat = () => note('stop the armed-restart beat')
  state.stopLockBeat = () => note('stop the handover lock beat')
  state.stopSessionlessBeat = () => note('stop the sessionless beat')
  state.stopSaturnTicker = () => note('stop the Saturn ticker')
  state.stopHostJobs = () => note('stop the host job sweep')
  state.ownerWatch = { stop: () => note('stop the owner watch'), ownerPipeClosed: () => {} } as never
  state.ownerPipe = { armed: true, close: () => note('close the owner pipe') } as never
  state.roster = {
    list: () => [
      { short: 'concourse-w1', pid: 11, via: 'runner' },
      { short: 'job-2', pid: 12, via: 'headless' },
      { short: 'done-3', pid: 13, via: 'runner', outcome: { ok: true } },
    ],
    kill: (short: string) => {
      note(`kill ${short}`)
      return true
    },
    askedSettled: async () => note('the asked runners settled'),
  } as never
  state.controlServer = { close: async () => note('close the control server'), rebind: async () => {}, leaseCount: () => 0 }
  state.releaseHeldReading = () => note(`release the held reading (teardown complete: ${state.teardownComplete})`)
  state.daemonLock = { release: async () => note('release the daemon lock') }
  return state
}
const reset = (): void => {
  did.length = 0
  timers.length = 0
  script.supersededBy = null
}
const at = (what: string): number => did.findIndex(line => line.startsWith(what))

const realError = console.error
const realExit = process.exit
const realTimeout = globalThis.setTimeout
const realClearInterval = globalThis.clearInterval
console.error = (...args: unknown[]) => note(`say: ${args.map(String).join(' ')}`)
process.exit = ((code?: number) => note(`exit ${code}`)) as never
globalThis.setTimeout = ((run: () => void, ms?: number) => {
  const timer = { ms: ms ?? 0, run, unref: false }
  timers.push(timer)
  note(`timer ${ms}`)
  return {
    unref: () => {
      timer.unref = true
    },
  }
}) as never
globalThis.clearInterval = ((timer: unknown) => {
  if (timer === KEEP_ALIVE) note('let the event loop go')
  else realClearInterval(timer as never)
}) as never

try {
  section('§1 the way out, in the order it lets go of what the boot took')
  {
    reset()
    const state = planted()
    state.restartAfterTeardown = true
    part.shutdownDaemon(state, needs, 'SIGTERM')
    const atOnce = [...did]
    await settle()
    const expected = [
      'stop the plane heal',
      'stop the armed-restart beat',
      'stop the handover lock beat',
      'stop the sessionless beat',
      'stop the Saturn ticker',
      'stop the host job sweep',
      'mark the record stopping',
      'say: [daemon] SIGTERM — shutting down',
      'stop the owner watch',
      'close the owner pipe',
      'ledger long-lived reap concourse-w1 daemon-shutdown:SIGTERM',
      'kill concourse-w1',
      'ledger headless reap job-2 daemon-shutdown:SIGTERM',
      'kill job-2',
      'close the control server',
      'timer 15000',
      'clear the control key',
      'clear the daemon record',
      'ledger daemon exit daemon shutdown:SIGTERM',
      'release the held reading (teardown complete: true)',
      'spawn the successor',
      'release the daemon lock',
      'the asked runners settled',
      'let the event loop go',
      'resolve the run',
      'timer 250',
    ]
    check('every step runs, once, in the order the daemon has always left by', JSON.stringify(did) === JSON.stringify(expected), did.map((line, i) => (line === expected[i] ? null : `${i}: ${line} (held: ${expected[i]})`)).filter(Boolean).slice(0, 4))
    check('the shutdown road marks its record before it closes the socket', at('mark the record stopping') >= 0 && at('mark the record stopping') < at('close the control server'))
    check('the teardown reaps every rostered worker that has no outcome, each with its row in the spawn ledger first, and none that has ended', at('kill concourse-w1') > at('ledger long-lived reap concourse-w1') && at('kill job-2') > at('ledger headless reap job-2') && at('kill done-3') === -1)
    check('it waits for the runners it asked to end after it has struck them and before its own exit', at('kill job-2') < at('the asked runners settled') && at('the asked runners settled') < at('timer 250'))
    check("it arms its own exit, 15 s out and unref'd, as it begins and outside the steps that can be held up", atOnce.includes('timer 15000') && !atOnce.includes('clear the control key') && timers.find(t => t.ms === 15000)?.unref === true, atOnce.slice(-3))
    check('the successor is spawned after the record is cleared and before the daemon lock is released', at('clear the daemon record') < at('spawn the successor') && at('spawn the successor') < at('release the daemon lock'))
    check('the daemon lock is released on the way out and the state lets go of it', at('release the daemon lock') >= 0 && state.daemonLock === null)
    check('the owner watch and pipe are let go, the teardown reads complete, the run resolves before the exit timer', state.ownerWatch === undefined && state.ownerPipe === undefined && state.teardownComplete === true && at('resolve the run') < at('timer 250'))
    timers.find(t => t.ms === 250)?.run()
    timers.find(t => t.ms === 15000)?.run()
    check('the exit after the teardown is 0; the bail, had it fired, is 1', did.slice(-2).join() === 'exit 0,exit 1', did.slice(-2))
  }

  section('§2 the guard, the restart that yields, the daemon with no control layer')
  {
    reset()
    const state = planted()
    part.shutdownDaemon(state, needs, 'SIGINT')
    await settle()
    const once = did.length
    part.shutdownDaemon(state, needs, 'SIGTERM')
    await settle()
    check('a second call on a daemon already leaving does nothing', did.length === once && state.shuttingDown === true)
    check('with no restart standing no successor is spawned', at('spawn the successor') === -1)

    reset()
    const yielding = planted()
    yielding.restartAfterTeardown = true
    script.supersededBy = { pid: 777, buildTree: 'bbbbbbbbbbbb', alive: true }
    part.shutdownDaemon(yielding, needs, 'restart-when-idle:armed')
    await settle()
    check('a daemon that already serves the plane cancels the restart after teardown, with its line, before the record is marked', yielding.restartAfterTeardown === false && at('spawn the successor') === -1 && at('say: [daemon] pid 777 (build bbbbbbbbbbbb) is already serving; exiting without spawning a successor') >= 0 && at('say: [daemon] pid 777') < at('mark the record stopping'), did)

    reset()
    const bare = planted(false)
    bare.controlServer = null
    bare.roster = null
    bare.daemonLock = null
    script.supersededBy = { pid: 777, buildTree: null, alive: true }
    bare.restartAfterTeardown = true
    part.shutdownDaemon(bare, needs, 'SIGTERM')
    await settle()
    check('with the control layer off nothing of the plane is touched: no mark, no key, no record, and the plane owner is not read', at('mark the record stopping') === -1 && at('clear the control key') === -1 && at('clear the daemon record') === -1 && bare.restartAfterTeardown === true && at('spawn the successor') >= 0, did)
    check('the rest of the way out still runs to its exit timer', at('ledger daemon exit daemon shutdown:SIGTERM') >= 0 && at('let the event loop go') >= 0 && at('resolve the run') < at('timer 250'))
  }
} finally {
  console.error = realError
  process.exit = realExit
  globalThis.setTimeout = realTimeout
  globalThis.clearInterval = realClearInterval
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-daemon-run-shutdown-part: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
