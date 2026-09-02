#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'daemon-census-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_CONFIG_DIR
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'text', text: 'census worker says hi' },
  { kind: 'text', text: 'aux slack 1' },
  { kind: 'text', text: 'aux slack 2' },
])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — census exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => Promise<boolean> | boolean, ms = 120_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return true
    if (Date.now() > deadline) return false
    await wait(200)
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const childrenOf = (pid: number): number[] => {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}
const referencesScratch = (): string => {
  try {
    return execFileSync('pgrep', ['-f', daemonDir], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

console.log('daemon worker census — counted, reaped, retained, nothing left behind')

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: api.url,
    MERCURY_CACHE_CLOCK: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
const daemonExit = new Promise<void>(r => daemon.once('exit', () => r()))

check(
  'the supervisor answers ping on its control socket',
  await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000),
)

type Status = { ok: boolean; status?: { pid: number; workersLive: number; workersTotal: number } }
const statusOf = async (): Promise<Status['status'] | null> => {
  const r = (await daemonControlRpc({ op: 'status', proto: 0 } as never)) as Status
  return r.ok ? (r.status ?? null) : null
}

let before = await statusOf()
check(
  'boot settles to a stable baseline census',
  await untilAsync(async () => {
    const a = await statusOf()
    await wait(1000)
    const b = await statusOf()
    if (a && b && a.workersTotal === b.workersTotal && a.workersLive === b.workersLive) {
      before = b
      return true
    }
    return false
  }, 60_000),
  JSON.stringify(before),
)
const baseLive = before!.workersLive
const baseTotal = before!.workersTotal
const daemonPid = before?.pid ?? daemon.pid!
const baselineChildren = childrenOf(daemonPid).length

const dispatched = (await daemonControlRpc({
  op: 'dispatch',
  proto: 0,
  d: { prompt: 'say the fixture line and stop', cwd: work },
} as never)) as { ok: boolean; short?: string; pid?: number; error?: string }
check('dispatch accepted (short + pid returned)', dispatched.ok === true && typeof dispatched.pid === 'number', JSON.stringify(dispatched))

check(
  'the roster counts the worker (workersTotal +1)',
  await untilAsync(async () => (await statusOf())?.workersTotal === baseTotal + 1, 30_000),
)

check(
  'the worker settles (workersLive returns to baseline)',
  await untilAsync(async () => (await statusOf())?.workersLive === baseLive),
)
check('the settled record is retained (workersTotal stays +1)', (await statusOf())?.workersTotal === baseTotal + 1)
{
  const list = (await daemonControlRpc({ op: 'list', proto: 0 } as never)) as {
    ok: boolean
    jobs?: Array<{ short: string; outcome?: string }>
  }
  const entry = list.jobs?.find(w => w.short === dispatched.short)
  check('the roster entry carries a settled outcome', entry !== undefined && typeof entry.outcome === 'string', JSON.stringify(entry ?? null))
}

check(
  'the worker PROCESS is reaped (pid gone)',
  await untilAsync(() => !alive(dispatched.pid!), 30_000),
)
check(
  'the daemon has no surviving children beyond its boot baseline',
  await untilAsync(() => childrenOf(daemonPid).length <= baselineChildren, 30_000),
  `now=${childrenOf(daemonPid).length} baseline=${baselineChildren}`,
)

const bye = await daemonControlRpc({ op: 'shutdown', reapWorkers: true })
check('shutdown acknowledged', bye.ok === true, JSON.stringify(bye))
await Promise.race([daemonExit, wait(30_000)])
check('the daemon process exited', !alive(daemonPid))
check(
  'the control socket stopped answering',
  await untilAsync(async () => !(await daemonControlRpc({ op: 'ping' })).ok, 15_000),
)
check('no process anywhere still references the scratch daemon dir', referencesScratch() === '', referencesScratch())

rmSync(SCRATCH, { recursive: true, force: true })

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log('✅ WORKER CENSUS: green')
  process.exit(0)
} else {
  console.log(`❌ WORKER CENSUS: ${failures} check(s) failed`)
  process.exit(1)
}
