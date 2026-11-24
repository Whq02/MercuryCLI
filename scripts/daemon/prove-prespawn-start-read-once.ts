#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mock } from 'bun:test'

const scratch = mkdtempSync(join(tmpdir(), 'prespawn-read-once-'))
const work = join(scratch, 'work')
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
for (const dir of [process.env.MERCURY_CONFIG_DIR, process.env.MERCURY_DAEMON_DIR, work]) mkdirSync(dir, { recursive: true })
writeFileSync(
  join(process.env.MERCURY_CONFIG_DIR, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'proof-token-not-a-real-one', refreshToken: 'proof-refresh-not-a-real-one', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
for (const name of ['MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES', 'MERCURY_WARM_RUNNER', 'MERCURY_DAEMON_NO_SELF_WARM']) delete process.env[name]

const watch = { ...(await import('../../src/daemon/control/ownerWatch.ts')) }
const asked: number[] = []
const blocking: number[] = []
const answer: Array<(token: string | null) => void> = []
mock.module('../../src/daemon/control/ownerWatch.ts', () => ({
  ...watch,
  getProcessStartInstant: (pid: number): string | null => {
    blocking.push(pid)
    return watch.getProcessStartInstant(pid)
  },
  getProcessStartInstantAsync: (pid: number): Promise<string | null> => {
    asked.push(pid)
    return new Promise(resolve => answer.push(resolve))
  },
}))

type FakeChild = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
const sleeper = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 120_000)'], { stdout: 'ignore', stderr: 'ignore' })
const child: FakeChild = Object.assign(new EventEmitter(), { pid: sleeper.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
let spawned = 0
const childModule = { ...(await import('../../src/daemon/runner-link/headlessRun.ts')) }
mock.module('../../src/daemon/runner-link/headlessRun.ts', () => ({
  ...childModule,
  spawnRunnerChild: () => {
    spawned++
    return { child, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }
  },
}))

const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const { TaskRoster } = await import('../../src/daemon/roster/roster.ts')
const warm = await import('../../src/daemon/runner-link/warmRunner.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${[detail, 'change: the roster reads a runner’s start once where it spawns it (spawnLongLived, src/daemon/roster/spawn.ts) and registerLongLived hands that read to its caller; the warm pool (ensureWarmRunnerFlight, src/daemon/runner-link/warmRunner.ts) keeps the roster’s read and makes none of its own'].filter(Boolean).join(' | ')}`}`)
}

console.log('============================================================')
console.log(' a warm runner is pre-spawned: its start is read once, for the roster’s mark and for the pool')
console.log('============================================================')
try {
  const roster = new TaskRoster({ dir: scratch, breaker: {} as never, maxInflight: 4 })
  const outcome = await warm.ensureWarmRunner({ workspaceDir: work }, { roster: () => roster as never })
  check('the warm runner is pre-spawned by the roster', outcome.state === 'warmed' && spawned === 1 && warm.warmRunnerCount() === 1, JSON.stringify({ outcome, spawned }))
  const ofRunner = asked.filter(pid => pid === child.pid).length
  check('its start is asked once: one process read for one fact', ofRunner === 1, `${ofRunner} read(s) of pid ${child.pid} launched at the pre-spawn`)
  check('no read stood the daemon still', blocking.length === 0, `${blocking.length} blocking read(s)`)
  if (outcome.short !== undefined) roster.kill(outcome.short)
} finally {
  for (const resolve of answer) resolve(null)
  sleeper.kill()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-prespawn-start-read-once: all green' : `\nprove-prespawn-start-read-once: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
