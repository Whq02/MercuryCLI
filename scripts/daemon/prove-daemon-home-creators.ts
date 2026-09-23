#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-home-creators-')))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.GIT_CONFIG_GLOBAL = join(SCRATCH, 'gitconfig-empty')
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.XDG_CONFIG_HOME = join(SCRATCH, 'xdg')
for (const key of ['MERCURY_HOME', 'MERCURY_WORKER_PARENT_PID', 'MERCURY_SPAWNED_BY', 'MERCURY_SPAWNED_ENV', 'MERCURY_SPAWN_AUDIT', 'MERCURY_SPAWN_LEDGER']) delete process.env[key]
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
mkdirSync(HOME, { recursive: true })
mkdirSync(DAEMON_DIR, { recursive: true })
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const text = (v: unknown): string => JSON.stringify(v)
const listing = (dir: string, rel = ''): string[] => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const entry = rel === '' ? name : `${rel}/${name}`
    out.push(entry)
    if (statSync(path).isDirectory()) out.push(...listing(path, entry))
  }
  return out.sort()
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const homeWatch = await import('../../src/daemon/daemonHome.ts')
const boxMod = await import('../../src/daemon/saturnBoxSchedules.ts')
const wt = await import('../../src/daemon/concourseWorktrees.ts')

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
const repo = join(SCRATCH, 'repo')
mkdirSync(repo, { recursive: true })
git(repo, 'init', '-q')
git(repo, 'config', 'user.email', 'prover@mercury.local')
git(repo, 'config', 'user.name', 'Prover')
writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
git(repo, 'add', '.')
git(repo, 'commit', '-qm', 'seed')

const held = {
  scheduleId: '0badf00d',
  dueAt: Date.parse('2026-03-01T09:00:00Z'),
  reason: 'signed-out' as const,
  heldAt: Date.parse('2026-03-01T09:00:01Z'),
  envelope: { scheduleId: '0badf00d', kind: 'birth' as const, dueAt: Date.parse('2026-03-01T09:00:00Z'), birth: { workspaceDir: repo, modelKey: 'claude-fable-5', presence: 'headless' as const } },
}

const WORKER_SCRIPT = join(SCRATCH, 'worker-audit.ts')
writeFileSync(WORKER_SCRIPT, [
  "import { existsSync } from 'node:fs'",
  `const led = await import(${text(join(ROOT, 'src', 'utils', 'spawnLedger.ts'))})`,
  `const watch = await import(${text(join(ROOT, 'src', 'daemon', 'workerParentWatch.ts'))})`,
  "led.recordBashAudit('echo from a daemon-spawned worker', 0, false)",
  `console.log(JSON.stringify({ marker: watch.parseWorkerParentPid(), auditPath: led.bashAuditPath(), daemonDirStands: existsSync(${text(DAEMON_DIR)}) }))`,
  '',
].join('\n'))
type WorkerReport = { marker: number | null; auditPath: string; daemonDirStands: boolean }
function runSpawnedChild(marked: boolean): { report: WorkerReport | null; status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_SPAWNED_BY: `daemon-worker:w-gone#${process.pid}` }
  if (marked) env.MERCURY_WORKER_PARENT_PID = String(process.pid)
  const r = spawnSync(process.execPath, ['run', WORKER_SCRIPT], { cwd: SCRATCH, encoding: 'utf8', env, timeout: 60_000 })
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? ''
  let report: WorkerReport | null = null
  try {
    report = JSON.parse(line) as WorkerReport
  } catch {
    report = null
  }
  return { report, status: r.status, stderr: (r.stderr ?? '').slice(-600) }
}

console.log('============================================================')
console.log(' the daemon home, once gone, is never recreated by its own creator seams')
console.log('============================================================')

console.log("\nC1 a daemon-marked worker's audit row under a standing daemon directory")
{
  const standing = runSpawnedChild(true)
  check('C1 the worker carries the daemon marker and writes its audit at the daemon directory', standing.status === 0 && standing.report !== null && standing.report.marker === process.pid && standing.report.auditPath === join(DAEMON_DIR, 'bash-audit.jsonl') && existsSync(join(DAEMON_DIR, 'bash-audit.jsonl')), text(standing))
  check('C1 the row names the spawner and the command', existsSync(join(DAEMON_DIR, 'bash-audit.jsonl')) && readFileSync(join(DAEMON_DIR, 'bash-audit.jsonl'), 'utf8').includes('"spawnedBy":"daemon-worker:w-gone#') && readFileSync(join(DAEMON_DIR, 'bash-audit.jsonl'), 'utf8').includes('echo from a daemon-spawned worker'))
}

console.log("\nC2 the daemon directory removed under the worker: the marked worker's audit recreates nothing")
{
  rmSync(DAEMON_DIR, { recursive: true, force: true })
  const gone = runSpawnedChild(true)
  check('C2 the audit call never throws in the worker (the swallow-all law) and still reports the daemon marker', gone.status === 0 && gone.report !== null && gone.report.marker === process.pid, text(gone))
  check('C2 the worker saw no daemon directory after its write, and none stands afterwards (the base recreated it for one audit row)', gone.report !== null && gone.report.daemonDirStands === false && !existsSync(DAEMON_DIR), text({ report: gone.report, files: listing(DAEMON_DIR) }))
}

console.log('\nC3 the same write from a spawned child that carries NO daemon marker keeps the operator-session shape')
{
  rmSync(DAEMON_DIR, { recursive: true, force: true })
  const unmarked = runSpawnedChild(false)
  check('C3 an unmarked spawned child reads no marker', unmarked.status === 0 && unmarked.report !== null && unmarked.report.marker === null, text(unmarked))
  check('C3 its forensics directory is created for the row, as the spawn-ledger proof pins for an operator session', unmarked.report !== null && unmarked.report.daemonDirStands === true && existsSync(join(DAEMON_DIR, 'bash-audit.jsonl')), text({ report: unmarked.report, files: listing(DAEMON_DIR) }))
}

console.log('\nU1 unarmed control: with no daemon-home watch (the screen process), the box lock still recreates its parent')
{
  rmSync(DAEMON_DIR, { recursive: true, force: true })
  const outcome = boxMod.holdBoxFire(held, DAEMON_DIR)
  check('U1 the unarmed writer holds the fire and the file lands under a recreated directory', outcome === 'held' && existsSync(boxMod.saturnBoxSchedulesPath(DAEMON_DIR)) && boxMod.readBoxSchedules(DAEMON_DIR).heldFires.length === 1, text({ outcome, files: listing(DAEMON_DIR) }))
  check('U1 the lock is released', !existsSync(boxMod.saturnBoxLockPath(DAEMON_DIR)))
}

console.log('\nA1 the armed daemon: the box lock meets ENOENT after the home is gone')
{
  rmSync(DAEMON_DIR, { recursive: true, force: true })
  mkdirSync(DAEMON_DIR, { recursive: true })
  const noticed: string[] = []
  homeWatch.armDaemonHomeWatch(DAEMON_DIR, where => noticed.push(where))
  check('A1 the watch stands while the directory stands', homeWatch.daemonHomeStands('the fixture', DAEMON_DIR) && noticed.length === 0)
  rmSync(DAEMON_DIR, { recursive: true, force: true })
  boxMod.holdBoxFire(held, DAEMON_DIR)
  check('A1 the daemon directory is NOT recreated for the lock (the base made the lock parent, took the lock and then published the box file into the recreated home)', !existsSync(DAEMON_DIR) && !existsSync(boxMod.saturnBoxSchedulesPath(DAEMON_DIR)), text(listing(DAEMON_DIR)))
  check("A1 the daemon's home-gone callback fired once, at the box lock", noticed.length === 1 && noticed[0] === 'the box lock', text(noticed))
  const again = boxMod.markBoxScheduleFired('0badf00d', Date.now(), DAEMON_DIR)
  check('A1 a later pen answers from an empty read without touching the disk or the callback again', again === 'missing' && !existsSync(DAEMON_DIR) && noticed.length === 1, text({ again, noticed }))
}

console.log('\nB1 the armed daemon: a worktree carve after the home is gone')
{
  rmSync(DAEMON_DIR, { recursive: true, force: true })
  mkdirSync(DAEMON_DIR, { recursive: true })
  const noticed: string[] = []
  homeWatch.armDaemonHomeWatch(DAEMON_DIR, where => noticed.push(where))
  rmSync(DAEMON_DIR, { recursive: true, force: true })
  const carve = await wt.ensureWorkerWorktree(repo, 'concourse-gone', DAEMON_DIR)
  check('B1 the carve refuses through the existing typed worktree failure', !carve.ok && carve.code === 'worktree-create-failed' && /is gone/.test(carve.error), text(carve))
  check('B1 the daemon directory is NOT recreated for the worktree root (the base made <daemon>/worktrees and carved a worktree into the gone home)', !existsSync(DAEMON_DIR), text(listing(DAEMON_DIR)))
  check('B1 no worktree was registered with the repository', !git(repo, 'worktree', 'list').includes('concourse-gone'), git(repo, 'worktree', 'list'))
  check("B1 the daemon's home-gone callback fired once, at the worktree root", noticed.length === 1 && noticed[0] === 'the worktree root', text(noticed))
}

console.log('\nB2 the armed daemon with its home standing still carves (the guard reads presence, never a stale flag)')
{
  rmSync(DAEMON_DIR, { recursive: true, force: true })
  mkdirSync(DAEMON_DIR, { recursive: true })
  const noticed: string[] = []
  homeWatch.armDaemonHomeWatch(DAEMON_DIR, where => noticed.push(where))
  const carve = await wt.ensureWorkerWorktree(repo, 'concourse-stands', DAEMON_DIR)
  check('B2 the carve lands under the standing home and the callback stays quiet', carve.ok && carve.created && existsSync(join(carve.path, '.git')) && noticed.length === 0, text({ carve, noticed }))
  const outcome = boxMod.holdBoxFire(held, DAEMON_DIR)
  check('B2 the box pen publishes under the standing home', outcome === 'held' && boxMod.readBoxSchedules(DAEMON_DIR).heldFires.length === 1 && noticed.length === 0, text({ outcome, noticed }))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-daemon-home-creators: ALL LAWS HOLD' : `\nprove-daemon-home-creators: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
