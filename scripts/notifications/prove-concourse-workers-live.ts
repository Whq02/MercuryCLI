#!/usr/bin/env bun
// gate-class: cpu
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'concourse-live-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const workspaces: string[] = []
for (let i = 1; i <= 6; i++) {
  const ws = join(SCRATCH, `ws-${i}`)
  mkdirSync(ws, { recursive: true })
  workspaces.push(ws)
}
process.env.GIT_CONFIG_GLOBAL = join(SCRATCH, 'gitconfig-empty')
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.XDG_CONFIG_HOME = join(SCRATCH, 'xdg')
execFileSync('sh', ['-c', `: > ${JSON.stringify(process.env.GIT_CONFIG_GLOBAL)}`])
const sharedRepo = workspaces[2]!
{
  const g = (...a: string[]) => execFileSync('git', ['-C', sharedRepo, ...a], { encoding: 'utf8', env: { ...process.env } })
  g('init', '-q')
  g('config', 'user.email', 'battery@mercury.local')
  g('config', 'user.name', 'battery')
  execFileSync('sh', ['-c', `echo seed > ${JSON.stringify(join(sharedRepo, 'seed.txt'))}`])
  g('add', '.')
  g('commit', '-qm', 'seed')
}
seedFirstRun(home, [work, ...workspaces])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'text', text: 'concourse worker turn 1 done' },
  { kind: 'text', text: 'slack 2' },
  { kind: 'text', text: 'slack 3' },
])
const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — live battery exceeded 300s; the scratch daemon.log under the concourse-live temp folder shows the check that was still waiting')
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
    await wait(250)
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
const ttyOf = (pid: number): string => {
  try {
    return execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return 'gone'
  }
}

console.log('concourse live battery — five real workers, refusals, crash-resume, release, teardown')

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
const daemonExited = new Promise<void>(r => daemon.once('exit', () => r()))

check(
  'the daemon answers ping on its control socket',
  await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000),
  'the daemon started by node dist/mercury.mjs daemon run never answered ping on its control socket; rebuild with bun run build.ts and read the scratch daemon.log',
)

const { WARM_BOOT_ALLOWANCE_MS } = await import('../../src/daemon/runner-link/warmRunner.ts')
const ADMISSION_ANSWER_MS = WARM_BOOT_ALLOWANCE_MS
type AdmitReply = {
  ok: boolean
  code?: string
  workerId?: string
  sessionId?: string
  workspaceId?: string
  pid?: number
  error?: string
  refusal?: string
}
type RosterRow = { workerId: string; sessionId: string; pid?: number }
type ListReply = { ok: boolean; workers?: RosterRow[] }
const listed = async (): Promise<RosterRow[]> => {
  const r = (await daemonControlRpc({ op: 'concourseList' } as never)) as ListReply
  return r.ok ? (r.workers ?? []) : []
}
const admit = async (workspaceDir: string, extra: Record<string, unknown> = {}): Promise<AdmitReply> => {
  const before = new Set((await listed()).map(r => r.workerId))
  const reply = (await daemonControlRpc({ op: 'concourseAdmit', workspaceDir, ...extra } as never, { timeoutMs: ADMISSION_ANSWER_MS })) as AdmitReply
  if (reply.ok || reply.code !== 'ETIMEOUT') return reply
  let joined: RosterRow | undefined
  await untilAsync(async () => {
    joined = (await listed()).find(r => !before.has(r.workerId) && r.pid !== undefined && alive(r.pid))
    return joined !== undefined
  }, ADMISSION_ANSWER_MS)
  return joined === undefined ? reply : { ok: true, workerId: joined.workerId, sessionId: joined.sessionId, pid: joined.pid }
}

console.log('\n§1 — five real workers admit and run simultaneously (two isolated in ONE repo)')
const admitted: Required<Pick<AdmitReply, 'workerId' | 'sessionId' | 'pid'>>[] = []
for (let i = 0; i < 4; i++) {
  const r =
    i >= 2
      ? await admit(sharedRepo, { isolation: 'worktree-isolated' })
      : await admit(workspaces[i]!)
  if (r.ok && r.workerId && r.sessionId && r.pid !== undefined) {
    admitted.push({ workerId: r.workerId, sessionId: r.sessionId, pid: r.pid })
  } else {
    check(`admission ${i + 1} succeeded`, false, JSON.stringify(r) + ' | the concourseAdmit op in src/daemon/control/controlServer.ts refused or timed out; the reply error and the scratch daemon.log name the reason')
  }
}
{
  const { readSessionWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const recs = Object.values(readSessionWorkers(daemonDir)).filter(
    r => r.endedAt === undefined && r.worktreePath !== undefined,
  )
  check(
    'the two isolated sessions carved DISTINCT live worktrees in the one repository',
    recs.length === 2 && new Set(recs.map(r => r.worktreePath)).size === 2 && recs.every(r => r.workspaceId === recs[0]!.workspaceId),
    JSON.stringify(recs.map(r => r.worktreePath)) + ' | a worktree-isolated admission must record its own live worktreePath in the session-worker records (src/daemon/concourse-workers/concourseWorkers.ts)',
  )
  check(
    '…each a REAL linked worktree on disk',
    recs.every(r => existsSync(join(r.worktreePath!, '.git')) && existsSync(join(r.worktreePath!, 'seed.txt'))),
    'a recorded worktreePath must be a real git worktree checkout of the shared repository',
  )
}
const aliasPath = join(SCRATCH, 'ws-1-alias')
symlinkSync(workspaces[0]!, aliasPath)
const aliased = await admit(aliasPath)
check(
  'a symlink-aliased workspace COLLIDES through the alias (RR-01 live) — the git offer answers it',
  aliased.ok === false && aliased.refusal === 'no-repository' && /git offer/.test(aliased.error ?? ''),
  JSON.stringify(aliased) + ' | admitting a symlink alias of an occupied workspace must refuse with refusal no-repository and the git offer in the error; see src/daemon/concourse-workers/admission.ts',
)
type DispatchReply = AdmitReply & { state?: string; clientMessageId?: string }
const dispatched = (await daemonControlRpc({
  op: 'concourseDispatch',
  clientMessageId: 'cm-live-1',
  prompt: 'summarize this workspace in one line',
  workspaceDir: workspaces[4]!,
} as never, { timeoutMs: ADMISSION_ANSWER_MS })) as DispatchReply
check(
  'the fifth session enters via concourseDispatch (prompt-to-session)',
  dispatched.ok === true && dispatched.state === 'working' && !!dispatched.workerId,
  JSON.stringify(dispatched) + ' | the concourseDispatch op (src/daemon/concourse-workers/concourseDispatch.ts) must start a worker and answer state working',
)
check(
  'five workers are simultaneously LIVE on the daemon summary',
  await untilAsync(async () => (await listed()).length === 5, 60_000),
  JSON.stringify(await listed()) + ' | the concourseList roster must show five workers; earlier admission failures above say which one is missing',
)
const rows = await listed()
const pids = rows.map(r => r.pid).filter((p): p is number => p !== undefined)
check('five distinct real processes', new Set(pids).size === 5 && pids.every(alive), JSON.stringify(pids) + ' | each roster row needs its own live pid; read the scratch daemon.log for a worker that exited')
check(
  'every worker is headless — no controlling terminal',
  pids.every(p => {
    const t = ttyOf(p)
    return t === '??' || t === '?' || t === ''
  }),
  JSON.stringify(pids.map(p => ttyOf(p))),
)
check(
  'five distinct minted session identities',
  new Set(rows.map(r => r.sessionId)).size === 5,
  JSON.stringify(rows.map(r => r.sessionId)) + ' | each admitted worker must be given its own freshly minted session id',
)

console.log('\n§2 — refusals at the real socket')
const sixth = await admit(workspaces[5]!)
check(
  'the SIXTH request refuses (runtime-ceiling) before any worker use',
  sixth.ok === false && sixth.refusal === 'runtime-ceiling' && /every seat is taken/.test(sixth.error ?? ''),
  JSON.stringify(sixth) + ' | a sixth admission must refuse with refusal runtime-ceiling and the every-seat-is-taken error; see src/daemon/concourse-workers/admission.ts',
)
check('refusals spawned nothing (still five)', (await listed()).length === 5, 'a refused admission must not start a worker; see src/daemon/concourse-workers/admission.ts')

console.log('\n§3 — the dispatched prompt reaches the provider boundary')
check(
  'the worker processed the turn against the fixture provider',
  await untilAsync(() => api.messageRequests().length >= 1, 90_000),
  `messageRequests=${api.messageRequests().length} | the dispatched worker never called the fixture provider; read the scratch daemon.log`,
)

console.log('\n§4 — crash convergence: SIGKILL → respawn RESUMES the same session')
if (rows.length < 5) {
  console.log('  ✗ §4/§5 unreachable — the board never reached five (see failures above)')
  const { readFileSync } = await import('node:fs')
  try {
    console.log('---- daemon.log tail ----')
    console.log(readFileSync(join(SCRATCH, 'daemon.log'), 'utf8').split('\n').slice(-40).join('\n'))
  } catch {
  }
  console.log(`scratch preserved for diagnosis: ${SCRATCH}`)
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never).catch(() => null)
  console.log(`\n❌ prove-concourse-workers-live — ${failures} check(s) failed`)
  process.exit(3)
}
const victim = rows.find(r => r.workerId !== dispatched.workerId)!
const survivors = rows.filter(r => r.workerId !== victim.workerId)
process.kill(victim.pid!, 'SIGKILL')
check(
  'the crashed worker respawns with a NEW pid on the roster',
  await untilAsync(async () => {
    const now = await listed()
    const back = now.find(r => r.workerId === victim.workerId)
    return !!back && back.pid !== undefined && back.pid !== victim.pid && alive(back.pid)
  }, 90_000),
  'a worker killed with SIGKILL must be respawned by the daemon with a new pid; read the scratch daemon.log',
)
const after = await listed()
const back = after.find(r => r.workerId === victim.workerId)
check(
  'the respawned worker carries the SAME durable session id (--resume, not a re-mint)',
  back?.sessionId === victim.sessionId,
  JSON.stringify({ was: victim.sessionId, now: back?.sessionId }) + ' | a respawn must resume the recorded session id and not mint a new one',
)
check(
  "the other workers' pids were untouched by the crash",
  survivors.every(s => after.find(r => r.workerId === s.workerId)?.pid === s.pid),
  JSON.stringify({ survivors, after }) + ' | a crash respawn must touch only the crashed worker',
)

console.log('\n§5 — release + shutdown leave nothing behind')
type ReleaseReply = { ok: boolean; settled?: boolean; killed?: boolean }
const released = (await daemonControlRpc({ op: 'concourseRelease', workerId: victim.workerId } as never)) as ReleaseReply
check('concourseRelease kills + settles exactly one record', released.ok === true && released.settled === true && released.killed === true, JSON.stringify(released) + ' | the concourseRelease op in the daemon must kill the worker and settle its record')
check(
  'the summary drops the released worker (four remain)',
  await untilAsync(async () => (await listed()).length === 4, 30_000),
  'a released worker must leave the concourseList roster',
)
const releasedPid = back?.pid
check(
  'the released worker process is gone (intentional stop — no respawn)',
  await untilAsync(() => (releasedPid === undefined ? true : !alive(releasedPid)), 30_000),
  'a released worker must stay stopped; the daemon must not respawn it',
)
{
  const { readSessionWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const isoLive = Object.values(readSessionWorkers(daemonDir)).find(
    r => r.endedAt === undefined && r.worktreePath !== undefined,
  )
  check('an isolated worker is still live for the reap leg', isoLive !== undefined, 'a worktree-isolated worker must still be live with an unended record in src/daemon/concourse-workers/concourseWorkers.ts')
  if (isoLive) {
    const wtPath = isoLive.worktreePath!
    const rel2 = (await daemonControlRpc({ op: 'concourseRelease', runnerId: isoLive.runnerId } as never)) as ReleaseReply
    check('the isolated worker releases + settles', rel2.ok === true && rel2.settled === true, JSON.stringify(rel2) + ' | concourseRelease by runnerId must settle the isolated worker')
    check(
      'its CLEAN worktree was REAPED with the settle (live)',
      await untilAsync(() => !existsSync(wtPath), 30_000),
      wtPath + ' | settling an isolated worker with a clean worktree must remove that worktree',
    )
    check(
      '…and the repository registration was pruned',
      !execFileSync('git', ['-C', sharedRepo, 'worktree', 'list'], { encoding: 'utf8', env: { ...process.env } }).includes(wtPath),
      'removing the worktree must also prune its git worktree registration in the shared repository',
    )
  }
}
await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
check('the daemon exits on shutdown', await untilAsync(() => daemon.exitCode !== null, 30_000), 'the daemon must exit after a shutdown op; read the scratch daemon.log')
await daemonExited
check(
  'every worker process is reaped',
  await untilAsync(() => pids.every(p => !alive(p)) && (back?.pid === undefined || !alive(back.pid)), 30_000),
  'shutdown with reapWorkers true must stop every worker process; the live pids are the ones left',
)
const strays = (() => {
  try {
    return execFileSync('pgrep', ['-f', SCRATCH], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()
check('nothing references the scratch world', strays === '', strays)

await api.close()
if (failures === 0) {
  rmSync(SCRATCH, { recursive: true, force: true })
} else {
  const { readFileSync } = await import('node:fs')
  try {
    console.log('---- daemon.log tail ----')
    console.log(readFileSync(join(SCRATCH, 'daemon.log'), 'utf8').split('\n').slice(-40).join('\n'))
  } catch {
  }
  console.log(`scratch preserved for diagnosis: ${SCRATCH}`)
}
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-concourse-workers-live — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 3)
