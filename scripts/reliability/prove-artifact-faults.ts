
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')

if (process.env.MERCURY_GATE_PREBUILT !== '1') {
  console.log('  (building dist/mercury.mjs — standalone run)')
  const b = spawnSync(process.execPath, ['run', join(REPO, 'build.ts')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (b.status !== 0) {
    console.error(b.stderr || b.stdout)
    console.error('❌ artifact faults: dist build failed')
    process.exit(1)
  }
}
if (!existsSync(DIST)) {
  console.error('❌ artifact faults: dist/mercury.mjs missing')
  process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'mercury-artifact-faults-'))
const home = join(tmp, 'home')
const teams = join(tmp, 'teams')
const daemon = join(tmp, 'daemon')
const project = join(tmp, 'project')
for (const d of [home, teams, daemon, project]) mkdirSync(d, { recursive: true })

const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_TEAMS_DIR: teams,
  MERCURY_DAEMON_DIR: daemon,
  MERCURY_PARTY: '0',
  MERCURY_CREW: '0',
  MERCURY_SESSION_ROOM: '',
  MERCURY_ROOM_TOKEN: '',
  MERCURY_FAULT_INJECT: '',
  ...extra,
})

const nodeArgs = (args: string[]) => [DIST, ...args]

function runDoctor(deep: boolean): { status: number | null; cert: unknown } {
  const res = spawnSync(
    'node',
    nodeArgs(['doctor', '--json', ...(deep ? ['--deep'] : [])]),
    {
      cwd: project,
      env: childEnv({ ANTHROPIC_API_KEY: 'fixture-anthropic-key' }),
      encoding: 'utf8',
      timeout: deep ? 180_000 : 60_000,
    },
  )
  let cert: unknown = null
  try {
    cert = JSON.parse(res.stdout)
  } catch {
  }
  return { status: res.status, cert }
}

type Check = { id: string; status: string; evidence: string }
function checksOf(cert: unknown, sectionId: string): Check[] {
  const sections = (cert as { sections?: Array<{ id: string; checks: Check[] }> })?.sections ?? []
  return sections.find(s => s.id === sectionId)?.checks ?? []
}

const journalDir = join(teams, '.journal')
const deadPid = spawnSync('node', ['-e', ''], { timeout: 10_000 }).pid ?? 999_999

function seedDeadOp(opId: string, teamName: string): void {
  mkdirSync(join(teams, teamName), { recursive: true })
  writeFileSync(
    join(teams, teamName, 'config.json'),
    JSON.stringify({
      name: teamName,
      createdAt: Date.now(),
      leadAgentId: `team-lead@${teamName}`,
      leadSessionId: 'dead-owner-session',
      members: [],
    }),
    'utf8',
  )
  mkdirSync(journalDir, { recursive: true })
  writeFileSync(
    join(journalDir, `op-${opId}.json`),
    JSON.stringify({
      schema: 1,
      operationId: opId,
      ownerKey: 'dead-owner-session',
      kind: 'team-create',
      idempotencyKey: `team-create:${teamName}`,
      state: 'applying',
      steps: [
        { id: 'team-file', target: join(teams, teamName, 'config.json'), state: 'applied' },
        { id: 'task-epoch', target: teamName, state: 'pending' },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      writerPid: deadPid,
    }),
    'utf8',
  )
}

function opState(opId: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(journalDir, `op-${opId}.json`), 'utf8')) as { state: string }).state
  } catch {
    return null
  }
}

async function bootDaemon(opts: {
  fault?: string
  until?: () => boolean
  timeoutMs: number
}): Promise<{ exited: boolean; signal: string | null; converged: boolean; waitedMs: number }> {
  const startedAt = Date.now()
  const child: ChildProcess = spawn('node', nodeArgs(['daemon', 'run']), {
    cwd: project,
    env: childEnv(opts.fault ? { MERCURY_FAULT_INJECT: opts.fault } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = false
  let signal: string | null = null
  child.on('exit', (_code, sig) => {
    exited = true
    signal = sig
  })
  const deadline = Date.now() + opts.timeoutMs
  let converged = false
  while (Date.now() < deadline) {
    if (opts.until?.()) {
      converged = true
      break
    }
    if (exited) break
    await sleep(150)
  }
  if (!exited) {
    child.kill('SIGKILL')
    const killDeadline = Date.now() + 5_000
    while (!exited && Date.now() < killDeadline) await sleep(50)
  }
  return { exited, signal, converged, waitedMs: Date.now() - startedAt }
}

const terminal = (s: string | null) => s === 'aborted' || s === 'committed'

console.log('— A. doctor --json --deep on the artifact —')
{
  const { status, cert } = runDoctor(true)
  ok(status === 0 && cert !== null, `deep doctor emitted a certificate with a credential present (exit ${status})`)
  const durability = checksOf(cert, 'durability')
  const txn = durability.find(c => c.id === 'durable-transaction')
  ok(txn?.status === 'ok', `durable-transaction probe ok in the bundle (${txn?.evidence?.slice(0, 80) ?? 'MISSING'})`)
  for (const id of ['durable-journals', 'store-quarantines', 'orphan-temps'] as const) {
    const c = durability.find(x => x.id === id)
    ok(c?.status === 'ok', `${id} ok on a pristine home (${c?.status ?? 'MISSING'})`)
  }
  const kernel = checksOf(cert, 'run-kernel').find(c => c.id === 'run-kernel-roundtrip')
  ok(kernel?.status === 'ok', `run-kernel deep probe still ok beside the durability section (${kernel?.status})`)
}

console.log('— B. seeded dead op → diagnose-only doctor —')
{
  seedDeadOp('af-b', 'af-team-b')
  const { cert } = runDoctor(false)
  const row = checksOf(cert, 'durability').find(c => c.id === 'durable-journals')
  ok(row?.status === 'warn', `durable-journals warns (${row?.status})`)
  ok(row?.evidence.includes('1 interrupted awaiting recovery') === true, `evidence counts the op (${row?.evidence})`)
  ok(opState('af-b') === 'applying', 'doctor did NOT touch the op (diagnose-only)')
  ok(existsSync(join(teams, 'af-team-b', 'config.json')), 'doctor did NOT touch the half-team')
}

console.log('— C. daemon boot recovery on the artifact —')
{
  const r = await bootDaemon({ until: () => terminal(opState('af-b')), timeoutMs: 30_000 })
  ok(r.converged, `daemon boot terminal-ized the op (state ${opState('af-b')})`)
  ok(opState('af-b') === 'aborted', 'partial op ABORTED (compensated, not committed)')
  ok(!existsSync(join(teams, 'af-team-b')), 'half-team compensated away by the artifact boot')
  const { cert } = runDoctor(false)
  const row = checksOf(cert, 'durability').find(c => c.id === 'durable-journals')
  ok(row?.status === 'ok', `doctor green after recovery (${row?.evidence})`)
}

console.log('— D. kill-at-every-boundary (recovery is resumable) —')
const BOUNDARIES = [
  'journal-recover-op',
  'create-temp',
  'write',
  'flush-file',
  'rename',
  'flush-dir',
] as const
for (const [i, phase] of BOUNDARIES.entries()) {
  const opId = `af-d${i}`
  const teamName = `af-team-d${i}`
  seedDeadOp(opId, teamName)
  const kill = await bootDaemon({ fault: `${phase}@op-${opId}:kill`, timeoutMs: 20_000 })
  const stateAfterKill = opState(opId)
  const died = kill.exited && !kill.converged
  const reboot = await bootDaemon({ until: () => terminal(opState(opId)), timeoutMs: 60_000 })
  const convergedState = opState(opId)
  ok(
    died && reboot.converged && convergedState === 'aborted' && !existsSync(join(teams, teamName)),
    `${phase}: killed at the boundary (mid-kill state ${stateAfterKill ?? 'unreadable'}) → clean reboot converged (${convergedState}, team compensated) in ${reboot.waitedMs}ms`,
  )
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ artifact faults: ALL PASS' : `\n❌ artifact faults: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
