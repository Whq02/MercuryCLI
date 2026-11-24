#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mock } from 'bun:test'

const scratch = mkdtempSync(join(tmpdir(), 'spawn-never-blocks-'))
const daemonDir = join(scratch, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

const watch = { ...(await import('../../src/daemon/control/ownerWatch.ts')) }
type Ask = { how: 'blocking' | 'in the background'; pid: number }
const asks: Ask[] = []
const held = new Map<number, (token: string | null) => void>()
const hold = new Set<number>()
mock.module('../../src/daemon/control/ownerWatch.ts', () => ({
  ...watch,
  getProcessStartInstant: (pid: number): string | null => {
    asks.push({ how: 'blocking', pid })
    return watch.getProcessStartInstant(pid)
  },
  getProcessStartInstantAsync: (pid: number): Promise<string | null> => {
    asks.push({ how: 'in the background', pid })
    if (!hold.has(pid)) return watch.getProcessStartInstantAsync(pid)
    return new Promise(resolve => held.set(pid, resolve))
  },
}))

type FakeChild = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
const sleepers = [0, 1, 2].map(() => Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 120_000)'], { stdout: 'ignore', stderr: 'ignore' }))
const children: FakeChild[] = sleepers.map(sleeper => Object.assign(new EventEmitter(), { pid: sleeper.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }))
let spawned = 0
const childModule = { ...(await import('../../src/daemon/runner-link/headlessRun.ts')) }
mock.module('../../src/daemon/runner-link/headlessRun.ts', () => ({ ...childModule, spawnRunnerChild: () => ({ child: children[spawned++], capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }) }))

const { TaskRoster } = await import('../../src/daemon/roster/roster.ts')
const { readSessionWorkers, updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 3 } }))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${[detail, 'change: where the roster stamps a spawned runner on its session record (spawnLongLived, src/daemon/roster/spawn.ts): the start instant is read in the background and handed to markConcourseWorkerRespawn (src/daemon/concourse-workers/marks.ts), and a read that comes back after the seat was spawned again stamps nothing'].filter(Boolean).join(' | ')}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(pred: () => boolean, ms = 10_000): Promise<boolean> {
  const stop = Date.now() + ms
  for (;;) {
    if (pred()) return true
    if (Date.now() > stop) return false
    await sleep(10)
  }
}
const SHORT = 'concourse-w7'
const record = (): { pid?: number; procStart?: string } | undefined => readSessionWorkers()[SHORT]
const instants = await Promise.all(children.map(child => watch.getProcessStartInstantAsync(child.pid)))

console.log('============================================================')
console.log(' the roster spawns a session runner and stamps its record without one blocking process read')
console.log('============================================================')
try {
  updateConcourseWorkers(workers => {
    workers[SHORT] = { runnerId: SHORT, sessionId: '55555555-5555-4555-8555-555555555555', workspaceId: scratch, modelKey: 'fixture-model', effort: 'high', spawnedAt: Date.now(), lastLiveAt: Date.now() } as never
  })
  const roster = new TaskRoster({ dir: scratch, breaker: {} as never, maxInflight: 3 })
  const registered = roster.registerLongLived(SHORT, { cwd: scratch, model: 'fixture-model', effort: 'high', role: 'MERCURY_CONCOURSE_WORKER', agentId: 'fixture', agentName: SHORT } as never, { backoffBaseMs: 1, backoffCapMs: 5 })
  check('the runner is spawned', registered.ok && registered.pid === children[0]!.pid, JSON.stringify(registered))
  const stamped = await until(() => record()?.pid === children[0]!.pid)
  check('its session record names the new pid and the start instant the system gives for it', stamped && typeof instants[0] === 'string' && instants[0] !== '' && record()?.procStart === instants[0], `record ${JSON.stringify(record())} against ${JSON.stringify(instants[0])}`)
  const blocking = asks.filter(ask => ask.how === 'blocking')
  check('no start instant was read while the daemon stood still for it', blocking.length === 0, `${blocking.length} blocking read(s) of pid ${blocking.map(ask => ask.pid).join(', ')}`)
  check('the start instant was read once, in the background', asks.filter(ask => ask.how === 'in the background' && ask.pid === children[0]!.pid).length === 1, JSON.stringify(asks))

  hold.add(children[1]!.pid)
  children[0]!.emit('exit', 1, null)
  const second = await until(() => spawned === 2 && held.has(children[1]!.pid))
  children[1]!.emit('exit', 1, null)
  const third = await until(() => spawned === 3 && record()?.pid === children[2]!.pid)
  check('the runner was spawned again twice, the second read still out', second && third, `spawned ${spawned} record ${JSON.stringify(record())}`)
  held.get(children[1]!.pid)?.(instants[1] ?? null)
  await sleep(150)
  check('a read that comes back after the seat was spawned again leaves the record on the runner that stands', record()?.pid === children[2]!.pid && record()?.procStart === instants[2], `record ${JSON.stringify(record())} against pid ${children[2]!.pid} ${JSON.stringify(instants[2])}`)
  roster.kill(SHORT)
} finally {
  for (const sleeper of sleepers) sleeper.kill()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-runner-spawn-never-blocks-on-a-read: all green' : `\nprove-runner-spawn-never-blocks-on-a-read: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
