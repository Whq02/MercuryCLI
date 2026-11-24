#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mock } from 'bun:test'

const scratch = mkdtempSync(join(tmpdir(), 'revive-never-blocks-'))
const daemonDir = join(scratch, 'daemon')
const work = join(scratch, 'work')
for (const dir of [daemonDir, work]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

const watch = { ...(await import('../../src/daemon/control/ownerWatch.ts')) }
type Ask = { how: 'blocking' | 'in the background'; pid: number }
const asks: Ask[] = []
const held = new Map<number, (token: string | null) => void>()
mock.module('../../src/daemon/control/ownerWatch.ts', () => ({
  ...watch,
  getProcessStartInstant: (pid: number): string | null => {
    asks.push({ how: 'blocking', pid })
    return watch.getProcessStartInstant(pid)
  },
  getProcessStartInstantAsync: (pid: number): Promise<string | null> => {
    asks.push({ how: 'in the background', pid })
    return new Promise(resolve => held.set(pid, resolve))
  },
}))

type FakeChild = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
const sleepers = [0, 1].map(() => Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 120_000)'], { stdout: 'ignore', stderr: 'ignore' }))
const children: FakeChild[] = sleepers.map(sleeper => Object.assign(new EventEmitter(), { pid: sleeper.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }))
let spawned = 0
const childModule = { ...(await import('../../src/daemon/runner-link/headlessRun.ts')) }
mock.module('../../src/daemon/runner-link/headlessRun.ts', () => ({ ...childModule, spawnRunnerChild: () => ({ child: children[spawned++], capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }) }))

const { TaskRoster } = await import('../../src/daemon/roster/roster.ts')
const { readSessionWorkers, updateConcourseWorkers, reviveConcourseWorker, detachRespawnConcourseSession, concourseTranscriptPath } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 4 } }))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${[detail, 'change: where a session taken up again is stamped with its new runner (reviveConcourseWorker and detachRespawnConcourseSession, src/daemon/concourse-workers/revive.ts): the record takes the pid at once and its start instant from the read the roster makes in the background (src/daemon/roster/spawn.ts)'].filter(Boolean).join(' | ')}`}`)
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
const instants = await Promise.all(children.map(child => watch.getProcessStartInstantAsync(child.pid)))
const record = (short: string): { pid?: number; procStart?: string; parkedAt?: number; attachedAt?: number } | undefined => readSessionWorkers()[short]
const seed = (short: string, sessionId: string, extra: Record<string, unknown>): void => {
  updateConcourseWorkers(workers => {
    workers[short] = { runnerId: short, sessionId, workspaceId: work, modelKey: 'fixture-model', effort: 'high', spawnedAt: Date.now() - 60_000, lastLiveAt: Date.now() - 30_000, pid: 3_999_999, procStart: 'Mon Jan  1 00:00:00 1990', ...extra } as never
  })
  const transcript = concourseTranscriptPath({ sessionId, workspaceId: work })
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(transcript, '')
}

console.log('============================================================')
console.log(' a session taken up again is stamped with its new runner without one blocking process read')
console.log('============================================================')
try {
  const roster = new TaskRoster({ dir: scratch, breaker: {} as never, maxInflight: 4 })
  const scenes = [
    { name: 'a parked session revived', short: 'concourse-w3', sessionId: '66666666-6666-4666-8666-666666666661', extra: { parkedAt: Date.now() - 20_000, parkedBy: 'operator' }, run: (sessionId: string) => reviveConcourseWorker(sessionId, 'operator', roster) },
    { name: 'a session handed back by the operator', short: 'concourse-w4', sessionId: '66666666-6666-4666-8666-666666666662', extra: { attachedAt: Date.now() - 20_000, attachedBy: 'operator' }, run: (sessionId: string) => detachRespawnConcourseSession(sessionId, 'operator', roster) },
  ] as const
  for (const [index, scene] of scenes.entries()) {
    console.log(`\n── ${scene.name} ──`)
    seed(scene.short, scene.sessionId, scene.extra)
    const before = asks.length
    const outcome = scene.run(scene.sessionId)
    const pid = children[index]!.pid
    const during = asks.slice(before)
    check('the runner is spawned and the door says applied', outcome.outcome === 'applied' && spawned === index + 1, JSON.stringify(outcome))
    check('no start instant was read while the daemon stood still for it', during.filter(ask => ask.how === 'blocking').length === 0, `${during.filter(ask => ask.how === 'blocking').length} blocking read(s) of pid ${during.filter(ask => ask.how === 'blocking').map(ask => ask.pid).join(', ')}`)
    check('the record names the new pid at once, and no longer the old runner’s start', record(scene.short)?.pid === pid && record(scene.short)?.procStart === undefined, JSON.stringify(record(scene.short)))
    const asked = await until(() => held.has(pid))
    held.get(pid)?.(instants[index] ?? null)
    const stamped = await until(() => record(scene.short)?.procStart === instants[index])
    check('the start instant follows from the one read made in the background', asked && stamped && typeof instants[index] === 'string' && instants[index] !== '' && asks.filter(ask => ask.pid === pid).length === 1, `record ${JSON.stringify(record(scene.short))} against ${JSON.stringify(instants[index])}; reads ${JSON.stringify(asks.filter(ask => ask.pid === pid))}`)
    roster.kill(scene.short)
  }
} finally {
  for (const sleeper of sleepers) sleeper.kill()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-revive-never-blocks-on-a-read: all green' : `\nprove-revive-never-blocks-on-a-read: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
