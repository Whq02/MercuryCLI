#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-run-sweep-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const PART = 'src/daemon/run/sweep.ts'

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const realImmediate = globalThis.setImmediate
const settle = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await new Promise<void>(done => realImmediate(() => done()))
}

const did: string[] = []
const note = (what: string): void => void did.push(what)
const WARM_DOORS = { roster: () => undefined }
const INSTANT = 'Tue Nov 10 11:59:11 2026'
const rows = [{ short: 'concourse-w1', pid: 11 }, { short: 'done-3', pid: 13, outcome: { ok: true } }]
const immediates: Array<() => void> = []

const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const daemonHome = await import('../../src/daemon/control/daemonHome.ts')
const idleRetirement = await import('../../src/daemon/control/idleRetirement.ts')
const ownerWatch = await import('../../src/daemon/control/ownerWatch.ts')
const sweepRun = await import('../../src/daemon/process-sweep/processSweepRun.ts')
const saturnTicker = await import('../../src/daemon/saturn/saturnTicker.ts')
const warmRunner = await import('../../src/daemon/runner-link/warmRunner.ts')
const debug = await import('../../src/platform/logs/debugLog.ts')
mock.module('../../src/daemon/concourse-workers/concourseWorkers.ts', () => ({
  ...workers,
  concourseWorkersPath: () => '/the/home/daemon/concourse-workers.json',
  readSessionWorkersSnapshot: () => ({ state: 'known', workers: { 'concourse-w1': { pid: 11, procStart: INSTANT, parkedAt: 3 } } }),
  reconcileConcourseWorkers: (live: ReadonlySet<string>) => {
    note(`reconcile the records against ${[...live].sort().join(' ') || 'nobody'}`)
    return { settled: [], live: [], newbornsReleased: [], parked: [] }
  },
}))
mock.module('../../src/daemon/control/daemonHome.ts', () => ({ ...daemonHome, daemonHomeStands: () => true }))
mock.module('../../src/daemon/control/idleRetirement.ts', () => ({ ...idleRetirement, sweepIdleEmptyConcourseSessions: () => (note('retire the idle empty sessions'), []) }))
mock.module('../../src/daemon/control/ownerWatch.ts', () => ({ ...ownerWatch, isProcessAlive: () => false }))
mock.module('../../src/daemon/process-sweep/processSweepRun.ts', () => ({ ...sweepRun, recordProcessCensusAtBoot: async () => (note('take the boot census'), { entries: [] }) }))
mock.module('../../src/daemon/saturn/saturnTicker.ts', () => ({ ...saturnTicker, fileMoveStamp: (path: string) => (note(`stamp of ${basename(path)}`), 'stamp-1') }))
mock.module('../../src/daemon/runner-link/warmRunner.ts', () => ({ ...warmRunner, sweepIdleWarmRunners: (doors: unknown) => (note(`sweep the idle warm runners${doors === WARM_DOORS ? '' : ' through other doors'}`), 0), warmRunnerShorts: () => [] }))
mock.module('../../src/platform/logs/debugLog.ts', () => ({ ...debug, logForDebugging: () => {} }))

const part = await import('../../src/daemon/run/sweep.ts')
const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')

const state = makeDaemonRunState({ dir: home, bootBuildTree: 'aaaaaaaaaaaa', foreground: false, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled: true })
state.currentOwnerPid = 4242
state.roster = { list: () => rows, liveWorkerFacts: () => [], kill: () => false } as never
state.handover = { heldRunners: () => new Set(['concourse-w9']) } as never
let tick: (() => void) | null = null
const realSetImmediate = globalThis.setImmediate
globalThis.setImmediate = ((run: () => void) => {
  immediates.push(run)
  return {} as never
}) as never

try {
  part.armReconcile(state, {
    warmDeps: WARM_DOORS,
    armPeriodic: ((name: string, work: () => void) => {
      note(`arm "${name}"`)
      tick = work
      return {} as never
    }) as never,
  })
  await settle()
  check('the boot reconciles the records against the runners the daemon rosters or an older daemon hosts, takes the census and the stamp of the records file, and arms the reconcile tick', did.join(' · ') === ['reconcile the records against concourse-w1 concourse-w9', 'take the boot census', 'stamp of concourse-workers.json', 'arm "the reconcile tick"'].join(' · '), `${JSON.stringify(did)} — compare with the order of steps in armReconcile in src/daemon/run/sweep.ts (reconcile, boot census, stamp, armPeriodic)`)

  did.length = 0
  rows.push({ short: 'concourse-w4', pid: 14 })
  ;(tick as (() => void) | null)?.()
  check('a tick after the roster moved reconciles against the new set, retires the idle empty sessions, takes the stamp again and sweeps the idle warm runners through the daemon\'s warm doors', did.join(' · ') === ['stamp of concourse-workers.json', 'reconcile the records against concourse-w1 concourse-w4 concourse-w9', 'retire the idle empty sessions', 'stamp of concourse-workers.json', 'sweep the idle warm runners'].join(' · '), `${JSON.stringify(did)} — compare with reconcileTick inside armReconcile in src/daemon/run/sweep.ts (stamp, reconcile, idle retirement, stamp, sweepIdleWarmRunners with the warmDeps it was given)`)

  const needs = { liveWorkers: () => ({ live: 0, liveSessions: 0 }), requestShutdown: (signal: string) => note(`ask the way out: ${signal}`), bootStartInstant: INSTANT }
  const facts = (await part.processSweep(state, needs, { action: 'facts' })) as { action: string; facts: { pid: number; ownerPid: number | null; runners: unknown[] } }
  check('the door answers the facts: this daemon\'s pid, its owner, a row a session record', facts.action === 'facts' && facts.facts.pid === process.pid && facts.facts.ownerPid === 4242 && facts.facts.runners.length === 1, `${JSON.stringify(facts)} — see the facts answer built by processSweep in src/daemon/run/sweep.ts (pid, state.currentOwnerPid, one runner per record)`)
  did.length = 0
  const ended = (await part.processSweep(state, needs, { action: 'end', expected: { kind: 'daemon', process: { pid: process.pid }, startToken: INSTANT } as never })) as { ended?: boolean; road?: string }
  immediates.shift()?.()
  check('asked to end, a daemon nothing uses answers that it ended and then asks the way out as control:processSweep', ended.ended === true && ended.road === 'daemon' && did.join() === 'ask the way out: control:processSweep', `${JSON.stringify([ended, did])} — see the daemon branch of the end action in processSweep in src/daemon/run/sweep.ts: a refusal there (owner alive, live workers, open session record, identity unbound) answers ended false`)
} finally {
  globalThis.setImmediate = realSetImmediate
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-daemon-run-sweep-part: ${failures === 0 ? 'green' : `${failures} failed`} (${PART})`)
process.exit(failures === 0 ? 0 : 1)
