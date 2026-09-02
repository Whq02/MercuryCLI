#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-newborn-grace.ts — THE BIRTH GRACE and the dead-
//  newborn release at the daemon's record seams (the one-door lifecycle
//  law). Pure + file-level; no daemon, no child.
//
//   N1  the sweep over the durable records: a LIVE blank newborn (born
//       through New Session — bornBlankAt, no lastDeliveryAt) idle far past
//       the threshold is NOT retired; the same record without the birth
//       stamp IS (the poison control — today's reap, reddened);
//   N2  the sweep honours a bounded grace (the registered knob's ms) —
//       inside the window kept, past it retired;
//   N3  the reconcile: a blank newborn found DEAD settles RELEASED (endedAt
//       stamped, no crash fact, off the live board — nothing to bring
//       back), while a dead MESSAGED record next to it is painted CRASHED
//       exactly as before (the visibility law untouched);
//   N4  the wire: the admit request's `bornBlank` crosses the control
//       server into the admit handler (source pins), and both record mints
//       (the warm claim and the cold spawn) stamp bornBlankAt.
//  Hermetic: a scratch daemon dir + config home; the "alive" pid is this
//  process's own (never killed), the "dead" pid is one no process owns.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'newborn-grace-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SESSION_NEWBORN_GRACE_MINUTES
delete process.env.MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
// The parked-room admission legs ride the account-scoped model gate —
// keyless the scratch home refuses (no-credential:any) before the room and
// id-mint laws under test ever run. A fixture sign-in row satisfies
// resolution offline (the prove-daemon-env-scrub / prove-credential-wall
// fixture shape); the roster here is scripted, so no child runs and the
// token can never reach a wire.
writeFileSync(
  join(process.env.MERCURY_CONFIG_DIR, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const sup = await import('../../src/daemon/concourseSupervisor.ts')
const idle = await import('../../src/daemon/idleRetirement.ts')
const dir = process.env.MERCURY_DAEMON_DIR!

/** A pid no process owns (a dead runner): the largest pid space is well
 *  under this on every platform Mercury runs on. */
const DEAD_PID = 2_147_000_000
const T = 10 * 60_000
const now = Date.now()

function seed(records: Array<Partial<ConcourseWorkerRecordV1> & { runnerId: string; sessionId: string }>): void {
  sup.updateConcourseWorkers(workers => {
    for (const key of Object.keys(workers)) delete workers[key]
    for (const r of records) {
      workers[r.runnerId] = {
        schema: 1,
        workspaceId: SCRATCH,
        isolation: 'exclusive',
        modelKey: 'claude-sonnet-5',
        spawnedAt: now - 3 * T,
        lastLiveAt: now - 3 * T,
        ...r,
      } as ConcourseWorkerRecordV1
    }
  }, dir)
}
const killed: string[] = []
const roster = { kill: (short: string): boolean => (killed.push(short), true) }
const rec = (runnerId: string): ConcourseWorkerRecordV1 | undefined => sup.readSessionWorkers(dir)[runnerId]

// ── N1: the live newborn survives the sweep; the poison control retires ─────
console.log('N1 the birth grace at the sweep')
{
  seed([
    { runnerId: 'concourse-w1', sessionId: '11111111-1111-4111-8111-111111111111', pid: process.pid, bornBlankAt: now - 3 * T },
    { runnerId: 'concourse-w2', sessionId: '22222222-2222-4222-8222-222222222222', pid: process.pid },
  ])
  killed.length = 0
  const retired = idle.sweepIdleEmptyConcourseSessions(roster, { dir, nowMs: now, thresholdMs: T })
  check('N1 the blank newborn is NOT retired (idle 30 min past a 10 min threshold)', !retired.some(r => r.runnerId === 'concourse-w1') && rec('concourse-w1')?.stoppedAt === undefined, JSON.stringify(retired))
  check('N1 the poison control: the same empty idle record WITHOUT the birth stamp IS retired', retired.some(r => r.runnerId === 'concourse-w2') && rec('concourse-w2')?.stoppedAt !== undefined && killed.includes('concourse-w2'))
  check('N1 the retired row carries the typed idle-empty fact (the existing wording stands)', rec('concourse-w2')?.retired?.reason === 'idle-empty')
}

// ── N2: a bounded grace ─────────────────────────────────────────────────────
console.log('N2 a bounded grace window')
{
  seed([
    { runnerId: 'concourse-w3', sessionId: '33333333-3333-4333-8333-333333333333', pid: process.pid, bornBlankAt: now - T },
    { runnerId: 'concourse-w4', sessionId: '44444444-4444-4444-8444-444444444444', pid: process.pid, bornBlankAt: now - 5 * T },
  ])
  const retired = idle.sweepIdleEmptyConcourseSessions(roster, { dir, nowMs: now, thresholdMs: T, newbornGraceMs: 2 * T })
  check('N2 inside the window the newborn is kept', !retired.some(r => r.runnerId === 'concourse-w3'))
  check('N2 past the window the newborn is judged like any empty idle session', retired.some(r => r.runnerId === 'concourse-w4'))
  check('N2 the knob reads 0 ⇒ never (the default)', idle.concourseNewbornGraceMs() === 0)
  process.env.MERCURY_SESSION_NEWBORN_GRACE_MINUTES = '45'
  check('N2 the knob reads minutes', idle.concourseNewbornGraceMs() === 45 * 60_000)
  delete process.env.MERCURY_SESSION_NEWBORN_GRACE_MINUTES
  // The legacy concourse spelling (the knob's first-day name) is tolerated
  // one rung below the canonical session spelling — never a silent break.
  process.env.MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES = '30'
  check('N2 the legacy spelling alone still sets the grace', idle.concourseNewbornGraceMs() === 30 * 60_000)
  process.env.MERCURY_SESSION_NEWBORN_GRACE_MINUTES = '45'
  check('N2 the canonical spelling wins one rung above the legacy', idle.concourseNewbornGraceMs() === 45 * 60_000)
  delete process.env.MERCURY_SESSION_NEWBORN_GRACE_MINUTES
  delete process.env.MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES
}

// ── N3: the reconcile releases a dead newborn, crashes a dead session ───────
console.log('N3 the reconcile: a dead newborn is released, a dead session is a crash')
{
  seed([
    { runnerId: 'concourse-w5', sessionId: '55555555-5555-4555-8555-555555555555', pid: DEAD_PID, bornBlankAt: now - T },
    { runnerId: 'concourse-w6', sessionId: '66666666-6666-4666-8666-666666666666', pid: DEAD_PID, lastDeliveryAt: now - T, lastTurnSettledAt: now - T + 5 },
    { runnerId: 'concourse-w7', sessionId: '77777777-7777-4777-8777-777777777777', pid: DEAD_PID, bornBlankAt: now - 2 * T, lastDeliveryAt: now - T },
  ])
  const receipt = sup.reconcileConcourseWorkers(new Set(), dir)
  check('N3 the dead blank newborn is RELEASED (endedAt stamped, no crash fact)', receipt.newbornsReleased.includes('concourse-w5') && rec('concourse-w5')?.endedAt !== undefined && rec('concourse-w5')?.crash === undefined, JSON.stringify(receipt))
  const onBoard = Object.values(sup.readSessionWorkers(dir)).filter(r => r.endedAt === undefined).map(r => r.runnerId).sort()
  check('N3 the dead newborn leaves the board (poison: a NEEDS-YOU row for a boot-and-quit); the crashed rows stay', onBoard.join(',') === 'concourse-w6,concourse-w7', onBoard.join(','))
  check('N3 the dead MESSAGED session is painted CRASHED exactly as before (the visibility law untouched)', receipt.settled.includes('concourse-w6') && rec('concourse-w6')?.crash !== undefined && rec('concourse-w6')?.endedAt === undefined)
  check('N3 a newborn that received words is a session — found dead it is a crash, never released', receipt.settled.includes('concourse-w7') && rec('concourse-w7')?.crash !== undefined && rec('concourse-w7')?.endedAt === undefined)
  const again = sup.reconcileConcourseWorkers(new Set(), dir)
  check('N3 the re-run is idempotent (nothing settles twice)', again.newbornsReleased.length === 0 && again.settled.length === 0)
}

// ── N4: the wire + the two mints (source pins) ──────────────────────────────
console.log('N4 the birth crosses the wire and stamps both mints')
{
  const server = read('src/daemon/controlServer.ts')
  const admitAt = server.indexOf("case 'sessionAdmit': {")
  const admitBody = server.slice(admitAt, server.indexOf("case 'concourseWithdraw'", admitAt))
  check('N4 the control server forwards bornBlank into the admit request', admitBody.includes('raw.bornBlank === true ? { bornBlank: true }'))
  const source = read('src/daemon/concourseSupervisor.ts')
  const claimAt = source.indexOf('THE WARM CLAIM (claim-over-spawn)')
  const coldAt = source.indexOf('// Lowest free worker slot', claimAt)
  const claimBody = source.slice(claimAt, coldAt)
  const coldBody = source.slice(coldAt, source.indexOf('function mintWorktreeBranchName', coldAt))
  check('N4 the warm-claim mint stamps bornBlankAt', claimBody.includes("req.bornBlank === true ? { bornBlankAt: Date.now() }"))
  check('N4 the cold-spawn mint stamps bornBlankAt', coldBody.includes("req.bornBlank === true ? { bornBlankAt: Date.now() }"))
  const birth = read('src/services/switchboard/bornSession.ts')
  check('N4 the birth door sends bornBlank: true', birth.includes('bornBlank: true'))
  const protocol = read('src/daemon/protocol.ts')
  check('N4 the protocol names the field on the admit op', /op: 'sessionAdmit'[\s\S]{0,1200}bornBlank\?: true/.test(protocol))
  const registry = read('src/substrate/flagRegistry.ts')
  check('N4 the grace knob is a registered row under its session spelling, the legacy concourse spelling registered beside it', registry.includes("env: 'MERCURY_SESSION_NEWBORN_GRACE_MINUTES'") && registry.includes("env: 'MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES'"))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-newborn-grace: ALL LAWS HOLD' : `\nprove-newborn-grace: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
