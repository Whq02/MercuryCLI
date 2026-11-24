#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mock } from 'bun:test'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'
import type { ControlServerDeps } from '../../src/daemon/control/controlServer.ts'
import type { TaskRoster } from '../../src/daemon/roster/roster.ts'
import type { DaemonRunState } from '../../src/daemon/run/state.ts'
import type { makeConcourseDispatchHandler } from '../../src/daemon/concourse-workers/concourseDispatch.ts'
import { refused as refusedByRunner } from '../../src/daemon/runner-wire/errors.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH = mkdtempSync(join(tmpdir(), 'clear-park-held-'))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
const PROJECT = join(SCRATCH, 'project')
for (const dir of [HOME, DAEMON_DIR, PROJECT]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_FAULT_INJECT
delete process.env.MERCURY_CONCOURSE_WORKER

const PLAIN = 'the cleared session is still running — park it from the Session Concourse'
const HINT =
  'change: the park road in src/daemon/concourse-workers/park.ts (retireConcourseSession, parkConcourseSession) and its own retry of a refused save in src/daemon/concourse-workers/store.ts, the fence in src/daemon/runner-link/runnerQuiescence.ts, or the receipt of clearFocusedSession in src/daemon/switchboard/hopIntoSession.ts'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${[detail, HINT].filter(Boolean).join(' | ')}`}`)
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
const { makeConcourseControl } = await import('../../src/daemon/run/concourseControl.ts')
const server = await import('../../src/daemon/control/controlServer.ts')
const sock = await import('../../src/daemon/control/controlSocket.ts')
const publish = await import('../../src/platform/substrate/durablePublish.ts')
const receipts = await import('../../src/models/facts/seatReceipts.ts')
const focused = await import('../../src/engine/connector/focusedConnector.ts')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { isProcessAlive } = await import('../../src/daemon/control/ownerWatch.ts')
mock.module(join(HERE, '../../src/daemon/switchboard/bornSession.ts'), () => ({ bornSession: async () => ({ ok: true }) }))
const hop = await import('../../src/daemon/switchboard/hopIntoSession.ts')

type Quiesce = { action: 'prepare' | 'commit' | 'cancel'; token: string }
type SeatReceipt = Parameters<Parameters<typeof receipts.subscribeSeatReceipts>[0]>[0]
type Scene = { sessionId: string; runnerId: string; runner: ChildProcess; pid: number; asked: string[] }

const scenes = new Map<string, Scene>()
const stands = new Map<string, ReturnType<typeof standInRunner>>()
const runnerLives = (scene: Scene | undefined): boolean => scene !== undefined && scene.runner.exitCode === null && scene.runner.signalCode === null
const rec = (runnerId: string): ConcourseWorkerRecordV1 | undefined => sup.readSessionWorkers()[runnerId]

function refuseTheSave(forMs: number | null, file = 'concourse-workers.json'): void {
  process.env.MERCURY_FAULT_INJECT = `rename@${file}:eperm`
  publish._resetFaultInjectionCountersForTests()
  if (forMs !== null) setTimeout(letTheSaveThrough, forMs)
}
function letTheSaveThrough(): void {
  delete process.env.MERCURY_FAULT_INJECT
}
const saveRefused = (): boolean => process.env.MERCURY_FAULT_INJECT !== undefined
const savesSoFar = (): number => (JSON.parse(readFileSync(join(DAEMON_DIR, 'concourse-delta.json'), 'utf8')) as { revision: number }).revision

function stage(tail: string, atCommit: () => void = () => {}, busy?: string): Scene {
  const runnerId = `concourse-w${tail}`
  const sessionId = `00000000-dddd-4000-8000-${tail.padStart(12, '0')}`
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const scene: Scene = { sessionId, runnerId, runner, pid: runner.pid ?? -1, asked: [] }
  scenes.set(runnerId, scene)
  stands.set(runnerId, standInRunner({
    autoAnswer: {
      'session/quiesce': (params: unknown) => {
        const request = params as Quiesce
        scene.asked.push(request.action)
        if (request.action === 'prepare' && busy !== undefined) throw refusedByRunner(busy, 'quiesce')
        if (request.action === 'commit') {
          atCommit()
          setTimeout(() => runner.kill('SIGKILL'), 20)
        }
        return { token: request.token, phase: request.action === 'prepare' ? 'prepared' : request.action === 'commit' ? 'committed' : 'cancelled' }
      },
    },
  }))
  const now = Date.now()
  sup.updateConcourseWorkers(workers => {
    workers[runnerId] = {
      schema: 1,
      runnerId,
      sessionId,
      workspaceId: PROJECT,
      isolation: 'exclusive',
      modelKey: 'claude-sonnet-5',
      spawnedAt: now - 60_000,
      lastLiveAt: now,
      pid: scene.pid,
      lastDeliveryAt: now - 30_000,
      lastTurnSettledAt: now - 29_000,
    } as ConcourseWorkerRecordV1
  })
  return scene
}

async function until(cond: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return cond()
}

async function clear(scene: Scene): Promise<{ warnings: SeatReceipt[]; all: SeatReceipt[]; tookMs: number }> {
  const all: SeatReceipt[] = []
  const unsubscribe = receipts.subscribeSeatReceipts(receipt => all.push(receipt))
  focused.setFocusedSessionConnector(new Proxy(noSessionConnector(), {
    get(target, prop, receiver) {
      if (prop === 'sessionId') return () => scene.sessionId
      if (prop === 'turnActive') return () => false
      if (prop === 'workspace') return () => ({ cwd: PROJECT, originalCwd: PROJECT })
      if (prop === 'modelFacts') return () => ({ effective: null })
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))
  const started = Date.now()
  try {
    await hop.clearFocusedSession()
  } finally {
    unsubscribe()
    focused.releaseFocusedSessionConnector()
  }
  return { warnings: all.filter(receipt => receipt.level === 'warning'), all, tookMs: Date.now() - started }
}

const rosterStandIn = {
  kill: (short: string): boolean => {
    scenes.get(short)?.runner.kill('SIGKILL')
    return true
  },
  has: (short: string) => ({ alive: runnerLives(scenes.get(short)), present: true }),
  door: (short: string) => stands.get(short)?.connection,
}
const state: Pick<DaemonRunState, 'roster'> = { roster: rosterStandIn as TaskRoster }
const noDispatch = async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: 'no dispatch in this scene' })
const concourseDispatchHandler = Object.assign(noDispatch, { withdraw: async (): Promise<boolean> => false }) as ReturnType<typeof makeConcourseDispatchHandler>
const deps: Partial<ControlServerDeps> = {
  controlKey: 'k',
  isReady: () => true,
  dir: DAEMON_DIR,
  startedAt: Date.now(),
  maxInflight: 1,
  concourseControl: makeConcourseControl(state as DaemonRunState, { concourseDispatchHandler }),
}
writeFileSync(sock.controlKeyPath(), 'k\n')
const handle = await server.startControlServer(deps as ControlServerDeps)

try {
  console.log('(b) the /clear hop with the save of the park refused for 1.5 s, then free')
  {
    const scene = stage('1')
    refuseTheSave(1_500)
    const out = await clear(scene)
    check('no warning receipt is minted', out.warnings.length === 0, JSON.stringify(out.all))
    check('the records on disk say parked once the holder lets go, the intent cleared', (await until(() => rec(scene.runnerId)?.parkedAt !== undefined, 6_000)) && rec(scene.runnerId)?.parkIntent === undefined, JSON.stringify(rec(scene.runnerId)))
    check('the runner left by its own leave (prepare, then commit) and is gone', scene.asked.join(',') === 'prepare,commit' && !isProcessAlive(scene.pid), `asked ${scene.asked.join(',')}; alive ${isProcessAlive(scene.pid)}`)
  }

  console.log('(b2) the save refused for 1.5 s from the moment the runner commits: the park is held in memory and saved by the daemon itself')
  {
    const scene = stage('2', () => refuseTheSave(1_500))
    const out = await clear(scene)
    const answeredWhileRefused = saveRefused()
    check('the verb answers while the file is still refused, and no warning receipt is minted', answeredWhileRefused && out.warnings.length === 0, `answered after ${out.tookMs}ms, still refused: ${answeredWhileRefused}; receipts ${JSON.stringify(out.all)}`)
    check('what it answered is true: the runner is gone', !isProcessAlive(scene.pid) && scene.asked.join(',') === 'prepare,commit', `asked ${scene.asked.join(',')}; alive ${isProcessAlive(scene.pid)}`)
    check('the daemon saves again by itself: the records on disk say parked once the holder lets go', (await until(() => rec(scene.runnerId)?.parkedAt !== undefined, 6_000)) && rec(scene.runnerId)?.parkIntent === undefined, JSON.stringify(rec(scene.runnerId)))
  }

  console.log('(b3) a park that ends the runner (the quit road) with the save refused for 1.5 s')
  {
    const scene = stage('4')
    refuseTheSave(1_500)
    let threw = ''
    let outcome = ''
    try {
      outcome = sup.parkConcourseSession(scene.sessionId, 'operator:test', rosterStandIn, undefined, { afterTurn: false }).outcome
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check('the park answers applied, not an error, while the file is refused', outcome === 'applied' && threw === '' && saveRefused(), threw || outcome)
    check('the records on disk say parked once the holder lets go', await until(() => rec(scene.runnerId)?.parkedAt !== undefined, 6_000), JSON.stringify(rec(scene.runnerId)))
  }

  console.log('(c) the save refused for ever')
  {
    const scene = stage('3')
    refuseTheSave(null)
    const out = await clear(scene)
    check('one plain sentence is minted', out.warnings.length === 1 && out.warnings[0]?.text === PLAIN, JSON.stringify(out.all))
    check('no path, no error code and no count of tries is in it', out.warnings.every(receipt => !receipt.text.includes(DAEMON_DIR) && !/EPERM|EBUSY|EACCES|rename|attempt|daemon error|\d/.test(receipt.text)), JSON.stringify(out.warnings))
    check("the session's true state is told: its runner is alive, its record is not parked, the retirement was called off", isProcessAlive(scene.pid) && rec(scene.runnerId)?.parkedAt === undefined && scene.asked.join(',') === 'prepare,cancel', `asked ${scene.asked.join(',')}; alive ${isProcessAlive(scene.pid)}; ${JSON.stringify(rec(scene.runnerId))}`)
    const refused = await sock.daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId: scene.sessionId, by: `operator:${process.pid}` }, { timeoutMs: 15_000 })
    check('parked from the Session Concourse while the save is still refused, the verb says why in plain words', refused.ok === true && refused.outcome === 'refused' && refused.detail === `${scene.runnerId}: its record could not be saved`, JSON.stringify(refused))
    letTheSaveThrough()
    const again = await sock.daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId: scene.sessionId, by: `operator:${process.pid}` }, { timeoutMs: 15_000 })
    check('once the file is free, parking it from the Session Concourse parks it', again.ok === true && again.outcome === 'applied' && (await until(() => rec(scene.runnerId)?.parkedAt !== undefined, 3_000)) && !isProcessAlive(scene.pid), JSON.stringify(again))
  }

  console.log('(d) a verb whose effect the daemon does not hold, with its save refused')
  {
    const scene = stage('5')
    refuseTheSave(null)
    const titled = await sock.daemonControlRpc({ op: 'sessionControl', action: 'set-title', sessionId: scene.sessionId, by: 'operator', title: 'a held title', titleSource: 'operator' }, { timeoutMs: 15_000 })
    letTheSaveThrough()
    check('the daemon answers one plain sentence, no path and no code', titled.ok === false && titled.error === 'the daemon could not save its records — try again', JSON.stringify(titled))
    check('and the title is in fact not set', rec(scene.runnerId)?.title === undefined, JSON.stringify(rec(scene.runnerId)))
  }

  console.log('(e) a verb that applied, with the save of its applied-ops ledger refused')
  {
    refuseTheSave(null, 'concourse-control-ops.json')
    const unrecorded = await sock.daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId: '00000000-dddd-4000-8000-00000000dead', by: 'operator', clientOpId: 'op-held-1' }, { timeoutMs: 15_000 })
    letTheSaveThrough()
    check('the note says not recorded with no error text in it', unrecorded.ok === true && unrecorded.detail === 'unknown-session: no live worker record owns this session — not recorded, so sending it again may apply it twice', JSON.stringify(unrecorded))
  }

  console.log('(f) a retirement called off before its intent was saved writes the records once, not twice')
  {
    const scene = stage('6', () => {}, 'the runner is busy')
    const before = savesSoFar()
    const refused = await sock.daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId: scene.sessionId, by: `operator:${process.pid}` }, { timeoutMs: 15_000 })
    const saves = savesSoFar() - before
    check('the park is refused with the runner alive and the refusal on its record', refused.ok === true && refused.outcome === 'refused' && isProcessAlive(scene.pid) && rec(scene.runnerId)?.parkRefused !== undefined && rec(scene.runnerId)?.parkIntent === undefined, JSON.stringify({ refused, record: rec(scene.runnerId) }))
    check('the whole records file was saved once for it (the refusal), with no save to clear an intent that never landed', saves === 1, `${saves} saves`)
  }
} finally {
  letTheSaveThrough()
  for (const scene of scenes.values()) scene.runner.kill('SIGKILL')
  for (const stand of stands.values()) stand.close()
  await handle.close()
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS prove-clear-park-held-save' : `\nFAIL prove-clear-park-held-save (${failures})`)
process.exit(failures === 0 ? 0 : 1)
