#!/usr/bin/env bun
// gate-class: cpu
// ============================================================================
//  scripts/notifications/prove-concourse-workers-live.ts —.8: the LIVE
//  five-worker battery against the REAL supervisor over the real control
//  socket, end to end on dist (the prove-worker-census discipline: fixture
//  API only — no paid calls; generous completion backstops, never
//  event-race budgets).
//
//  §1  five session workers admit through op concourseAdmit across five
//      canonical workspaces and are SIMULTANEOUSLY LIVE (real processes,
//      distinct pids, no controlling terminal — headless by construction).
//  §2  the SIXTH request refuses at the REAL socket (runtime-ceiling) with
//      zero new processes; a SYMLINK-ALIASED workspace refuses as a
//      collision (RR-01 canonicalization at the live admission seam).
//  §3  op concourseDispatch drives prompt-to-session end to end: the worker
//      processes the turn against the fixture provider (the prompt reaches
//      the provider boundary exactly once), receipt state 'working'.
//  §4  crash convergence: SIGKILL one worker — the roster's capped-backoff
//      respawn brings the SAME durable session back (respawnExtraArgv
//      '--resume <id>' — the first live drive of the respawn-resume
//      asymmetry) while the other workers' pids are untouched.
//  §5  release + shutdown: concourseRelease kills + settles exactly one
//      record; daemon shutdown reaps everything; nothing references the
//      scratch world afterward.
// ============================================================================
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
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
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
// (the same-repo half): ws-3 becomes a REAL git repo —
// TWO of the five sessions claim it worktree-isolated (lawful
// same-repository concurrency), live. Hermetic git identity (the bun
// spawnSync-env lesson: pass env explicitly).
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
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — live battery exceeded 300s')
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
  'the supervisor answers ping on its control socket',
  await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000),
)

type AdmitReply = {
  ok: boolean
  workerId?: string
  sessionId?: string
  workspaceId?: string
  pid?: number
  error?: string
  refusal?: string
}
const admit = async (workspaceDir: string, extra: Record<string, unknown> = {}): Promise<AdmitReply> =>
  (await daemonControlRpc({ op: 'concourseAdmit', workspaceDir, ...extra } as never)) as AdmitReply

console.log('\n§1 — five real workers admit and run simultaneously (two isolated in ONE repo)')
const admitted: Required<Pick<AdmitReply, 'workerId' | 'sessionId' | 'pid'>>[] = []
for (let i = 0; i < 4; i++) {
  // Sessions 3 and 4 SHARE the git repo through isolated worktrees (the
  // live — lawful same-repository concurrency).
  const r =
    i >= 2
      ? await admit(sharedRepo, { isolation: 'worktree-isolated' })
      : await admit(workspaces[i]!)
  if (r.ok && r.workerId && r.sessionId && r.pid !== undefined) {
    admitted.push({ workerId: r.workerId, sessionId: r.sessionId, pid: r.pid })
  } else {
    check(`admission ${i + 1} succeeded`, false, JSON.stringify(r))
  }
}
{
  const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const recs = Object.values(readSessionWorkers(daemonDir)).filter(
    r => r.endedAt === undefined && r.worktreePath !== undefined,
  )
  check(
    'the two isolated sessions carved DISTINCT live worktrees in the one repository',
    recs.length === 2 && new Set(recs.map(r => r.worktreePath)).size === 2 && recs.every(r => r.workspaceId === recs[0]!.workspaceId),
    JSON.stringify(recs.map(r => r.worktreePath)),
  )
  check(
    '…each a REAL linked worktree on disk',
    recs.every(r => existsSync(join(r.worktreePath!, '.git')) && existsSync(join(r.worktreePath!, 'seed.txt'))),
  )
}
// RR-01 at the live seam — checked while capacity REMAINS (on a full board
// the ceiling refusal correctly wins; the fold-ordering law).
const aliasPath = join(SCRATCH, 'ws-1-alias')
symlinkSync(workspaces[0]!, aliasPath)
const aliased = await admit(aliasPath)
check(
  // Re-pin: a DEFAULTED second claim on a held PLAIN
  // folder holds on the git OFFER now — the alias still collided (RR-01
  // canonicalization is exactly why the offer fired instead of a second
  // exclusive admit), but the refusal is the offer, never a silent queue.
  'a symlink-aliased workspace COLLIDES through the alias (RR-01 live) — the git offer answers it',
  aliased.ok === false && aliased.refusal === 'no-repository' && /git offer/.test(aliased.error ?? ''),
  JSON.stringify(aliased),
)
type DispatchReply = AdmitReply & { state?: string; clientMessageId?: string }
const dispatched = (await daemonControlRpc({
  op: 'concourseDispatch',
  clientMessageId: 'cm-live-1',
  prompt: 'summarize this workspace in one line',
  workspaceDir: workspaces[4]!,
} as never)) as DispatchReply
check(
  'the fifth session enters via concourseDispatch (prompt-to-session)',
  dispatched.ok === true && dispatched.state === 'working' && !!dispatched.workerId,
  JSON.stringify(dispatched),
)
type ListReply = { ok: boolean; workers?: Array<{ workerId: string; sessionId: string; pid?: number }> }
const listed = async (): Promise<Array<{ workerId: string; sessionId: string; pid?: number }>> => {
  const r = (await daemonControlRpc({ op: 'concourseList' } as never)) as ListReply
  return r.ok ? (r.workers ?? []) : []
}
check(
  'five workers are simultaneously LIVE on the supervisor summary',
  await untilAsync(async () => (await listed()).length === 5, 60_000),
  JSON.stringify(await listed()),
)
const rows = await listed()
const pids = rows.map(r => r.pid).filter((p): p is number => p !== undefined)
check('five distinct real processes', new Set(pids).size === 5 && pids.every(alive), JSON.stringify(pids))
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
  JSON.stringify(rows.map(r => r.sessionId)),
)

console.log('\n§2 — refusals at the real socket')
const sixth = await admit(workspaces[5]!)
check(
  'the SIXTH request refuses (runtime-ceiling) before any worker use',
  // Copy re-pin: held-not-failed queues the reservation (the
  // draft survives by construction) — the copy says the seats truth.
  sixth.ok === false && sixth.refusal === 'runtime-ceiling' && /every seat is taken/.test(sixth.error ?? ''),
  JSON.stringify(sixth),
)
check('refusals spawned nothing (still five)', (await listed()).length === 5)

console.log('\n§3 — the dispatched prompt reaches the provider boundary')
check(
  'the worker processed the turn against the fixture provider',
  await untilAsync(() => api.messageRequests().length >= 1, 90_000),
  `messageRequests=${api.messageRequests().length}`,
)

console.log('\n§4 — crash convergence: SIGKILL → respawn RESUMES the same session')
if (rows.length < 5) {
  console.log('  ✗ §4/§5 unreachable — the board never reached five (see failures above)')
  const { readFileSync } = await import('node:fs')
  try {
    console.log('---- daemon.log tail ----')
    console.log(readFileSync(join(SCRATCH, 'daemon.log'), 'utf8').split('\n').slice(-40).join('\n'))
  } catch {
    /* no log */
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
)
const after = await listed()
const back = after.find(r => r.workerId === victim.workerId)
check(
  'the respawned worker carries the SAME durable session id (--resume, not a re-mint)',
  back?.sessionId === victim.sessionId,
  JSON.stringify({ was: victim.sessionId, now: back?.sessionId }),
)
check(
  "the other workers' pids were untouched by the crash",
  survivors.every(s => after.find(r => r.workerId === s.workerId)?.pid === s.pid),
  JSON.stringify({ survivors, after }),
)

console.log('\n§5 — release + shutdown leave nothing behind')
type ReleaseReply = { ok: boolean; settled?: boolean; killed?: boolean }
const released = (await daemonControlRpc({ op: 'concourseRelease', workerId: victim.workerId } as never)) as ReleaseReply
check('concourseRelease kills + settles exactly one record', released.ok === true && released.settled === true && released.killed === true, JSON.stringify(released))
check(
  'the summary drops the released worker (four remain)',
  await untilAsync(async () => (await listed()).length === 4, 30_000),
)
const releasedPid = back?.pid
check(
  'the released worker process is gone (intentional stop — no respawn)',
  await untilAsync(() => (releasedPid === undefined ? true : !alive(releasedPid)), 30_000),
)
// LIVE: release an ISOLATED worker — its clean worktree reaps with
// the settle (dirt law inside; two isolated sessions exist, at least one
// survives the §4/§5 victim arithmetic).
{
  const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const isoLive = Object.values(readSessionWorkers(daemonDir)).find(
    r => r.endedAt === undefined && r.worktreePath !== undefined,
  )
  check('an isolated worker is still live for the reap leg', isoLive !== undefined)
  if (isoLive) {
    const wtPath = isoLive.worktreePath!
    // The record file speaks runnerId (the session-is-the-unit rename; the
    // reader folds legacy workerId INTO it, so a fresh record has no
    // workerId field — the old spelling sent `undefined` and the verb
    // refused).
    const rel2 = (await daemonControlRpc({ op: 'concourseRelease', runnerId: isoLive.runnerId } as never)) as ReleaseReply
    check('the isolated worker releases + settles', rel2.ok === true && rel2.settled === true, JSON.stringify(rel2))
    check(
      'its CLEAN worktree was REAPED with the settle (live)',
      await untilAsync(() => !existsSync(wtPath), 30_000),
      wtPath,
    )
    check(
      '…and the repository registration was pruned',
      !execFileSync('git', ['-C', sharedRepo, 'worktree', 'list'], { encoding: 'utf8', env: { ...process.env } }).includes(wtPath),
    )
  }
}
await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
check('the daemon exits on shutdown', await untilAsync(() => daemon.exitCode !== null, 30_000))
await daemonExited
check(
  'every worker process is reaped',
  await untilAsync(() => pids.every(p => !alive(p)) && (back?.pid === undefined || !alive(back.pid)), 30_000),
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
    /* no log */
  }
  console.log(`scratch preserved for diagnosis: ${SCRATCH}`)
}
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-concourse-workers-live — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 3)
