// prove-artifact-faults — the release-blocking fault gate ON THE BUILT
// ARTIFACT. Everything before this
// file proves the machinery at source; a bundler can still break what bun
// ran fine (host-harness-vs-built-binary), so this suite drives
// dist/mercury.mjs itself in fully isolated homes:
//
//   A. `doctor --json --deep` — the disposable-transaction probe (journal
//      commit → replay → died-writer compensation → fault-injected publish)
//      completes INSIDE the bundle, plus the fast DURABILITY rows;
//   B. seeded dead-writer journal op → fast doctor reports it honestly
//      (warn, awaiting recovery) WITHOUT touching it (diagnose-only);
//   C. a real daemon boot reconciles it (runBootRecovery in the artifact):
//      op terminal-ized, the half-team compensated, doctor goes green;
//   D. kill-at-every-boundary: the daemon is SIGKILLed via MERCURY_FAULT_INJECT
//      at each durable-publish phase of the recovery's own journal writes
//      (create-temp · write · flush-file · rename · flush-dir) and at the
//      recovery entry itself (journal-recover-op) — then a clean reboot must
//      CONVERGE every time (recovery is resumable at any boundary).
//
// Child daemons run with the party/crew arms stamped OFF and every home seam
// pointed at the fixture — nothing here can reach a real home or spawn a
// billed worker.

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

// The artifact under test. Under the pooled gate Phase 0 prebuilds ONCE
// (MERCURY_GATE_PREBUILT=1 — every suite tests the same build); standalone
// runs build here so the proof never silently tests a stale bundle.
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

const tmp = mkdtempSync(join(tmpdir(), 'hermes-artifact-faults-'))
const home = join(tmp, 'home')
const teams = join(tmp, 'teams')
const daemon = join(tmp, 'daemon')
const project = join(tmp, 'project') // trusted empty cwd — no .mcp.json to spawn
for (const d of [home, teams, daemon, project]) mkdirSync(d, { recursive: true })

/** Every child is hermetic: fixture homes, no party/crew arms, no rooms. */
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
  // The credential verdict follows the routed family (the auth-routed
  // verdict proof owns that law): a home with no sign-in anywhere is a FAULT
  // and the doctor exits 3 — no turn can run. This harness is about the
  // DURABILITY rows and the deep transaction probe, so the doctor child
  // carries a placeholder key (presence only — the credential check never
  // probes the network, at any depth) and the certificate is read whole
  // under a verdict that is not the credential's. The placeholder also
  // overrides any real key in the parent shell: the verdict is the
  // harness's, never the box's.
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
    /* asserted below */
  }
  return { status: res.status, cert }
}

type Check = { id: string; status: string; evidence: string }
function checksOf(cert: unknown, sectionId: string): Check[] {
  const sections = (cert as { sections?: Array<{ id: string; checks: Check[] }> })?.sections ?? []
  return sections.find(s => s.id === sectionId)?.checks ?? []
}

// ── Fixture: one interrupted team-create with a provably-dead writer ─────────
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

/** Boot the real daemon from the artifact; resolve when `until` returns true
 *  (daemon then killed) or when the daemon exits on its own (fault legs). */
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

// ── A. the deep disposable-transaction probe INSIDE the bundle ───────────────
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

// ── B. honest diagnosis: doctor sees the dead op, touches nothing ────────────
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

// ── C. a real daemon boot reconciles it in the artifact ─────────────────────
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

// ── D. kill at EVERY durable boundary, then converge on a clean reboot ───────
console.log('— D. kill-at-every-boundary (recovery is resumable) —')
const BOUNDARIES = [
  'journal-recover-op', // entering recovery of this op
  'create-temp', // each publishOp transition rides durableAtomicPublish…
  'write',
  'flush-file',
  'rename',
  'flush-dir',
] as const
for (const [i, phase] of BOUNDARIES.entries()) {
  const opId = `af-d${i}`
  const teamName = `af-team-d${i}`
  seedDeadOp(opId, teamName)
  // Path-scoped to THIS op's file so the daemon's own unrelated publishes
  // never trip it; the kill action is a self-SIGKILL at the exact boundary.
  const kill = await bootDaemon({ fault: `${phase}@op-${opId}:kill`, timeoutMs: 20_000 })
  const stateAfterKill = opState(opId)
  const died = kill.exited && !kill.converged
  // RECOVERY BUDGET. The loop exits the moment the op reaches a terminal
  // state, so this ceiling costs nothing when recovery works — it only decides
  // how much daemon-boot SCHEDULING DELAY is read as a failure to converge.
  // 30_000 was tuned on an idle machine and reported the recovery as broken
  // under the 129-suite pool: pool 17 saw flush-dir stay `compensating`
  // at the ceiling while the same phase, from the SAME mid-kill state,
  // converged to `aborted` solo. `reliability` is gate-class cpu, so it is
  // never retried and a load-stretched boot sinks the whole verdict.
  const reboot = await bootDaemon({ until: () => terminal(opState(opId)), timeoutMs: 60_000 })
  const convergedState = opState(opId)
  ok(
    died && reboot.converged && convergedState === 'aborted' && !existsSync(join(teams, teamName)),
    // The observed wait is printed either way: a genuine convergence
    // regression sits near the ceiling, a load stretch sits well under it, and
    // without the number the next failure is indistinguishable from this one.
    `${phase}: killed at the boundary (mid-kill state ${stateAfterKill ?? 'unreadable'}) → clean reboot converged (${convergedState}, team compensated) in ${reboot.waitedMs}ms`,
  )
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ artifact faults: ALL PASS' : `\n❌ artifact faults: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
