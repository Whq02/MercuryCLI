#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-chat-birth.ts — LANE CHATBIRTH (ledger L19):
//  a SOLO New Session births IN PLACE, seamlessly. The operator's live
//  finding (mercury --chat: Continue Last Session → boot menu → New Session
//  → "git worktree add failed … a branch named 'mercury/concourse-w3'
//  already exists"): every solo door sent a DEFAULTED claim into the
//  ruling-1 fold, which silently converted a workspace collision into a
//  worktree fork built for coordinator dispatches; the carve's namer seeded
//  the RECYCLED runner short while the short-keyed records store had
//  clobbered the record that remembered the branch, and the ensure ladder's
//  recovery retried a name just proven taken. The pins drive the REAL
//  admission policy (makeConcourseAdmitHandler over a scratch home, a fake
//  roster port and real scratch git repos):
//
//   A1  THE SOLO NO-MINT LAW: a 'shared' (solo in-place) birth beside a
//       LIVE shared sibling admits ON THE GROUND — no worktree dir, no
//       branch, record isolation 'shared', cwd = the claim root, bornBlankAt
//       stamped. CONTROL: a DEFAULTED admission beside the same sibling
//       still folds to the worktree estate (carves, records
//       'worktree-isolated', mints a branch) — the estate stays the
//       coordinator dispatches' and explicit opt-ins' alone.
//   A2  THE COLLISION-PROOF NAMER: with mercury/<seed> AND -2..-6 all
//       lingering as branches, a lawful carve still succeeds on a fresh
//       time-tailed name; with only the base taken it lands on -2.
//   A3  THE OPERATOR'S EXACT JOURNEY at the daemon's seam: a record-less
//       resume (continue) admits in place, then New Session admits a CLEAN
//       SECOND session beside it — both live, distinct ids, zero carves.
//   A4  NEW-IS-NEVER-REPLAY: the birth carries no resumeSessionId (word-
//       keyed at the one birth door), mints a fresh id, boots with
//       --session-id and never --resume; the resume door claims shared
//       beside its resumeSessionId (word-keyed at the one resume door).
//   A5  THE STANDING-ESTATE MIGRATION: an operator reactivate of a
//       worktree-less 'exclusive' record beside a live shared sibling
//       admits (never a checkout-held refusal) and rewrites the record
//       'shared' — day-one journeys never re-fence the ground.
//
//  POISONS: drop bornSession's explicit shared claim, the bothShared arm,
//  or fold EXPLICIT claims ⇒ A1/A3 find a worktree dir or a branch where
//  none may exist; drop the DEFAULTED fold ⇒ A1's control fails (the
//  estate must live); seed the namer from the runner short or retry the
//  refused name ⇒ A2 dies on "already exists"; converge a birth onto an
//  existing session ⇒ A4's fresh-id/argv pins fail; skip the reactivate
//  rewrite ⇒ A5 refuses or keeps 'exclusive'.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const SCRATCH = mkdtempSync(join(tmpdir(), 'chat-birth-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_WARM_RUNNER
delete process.env.MERCURY_DAEMON_NO_SELF_WARM
delete process.env.MERCURY_CONCOURSE_WORKER
// Hermetic git: the worktree module spreads process.env into every git
// child, so the scratch config pin really governs the carves below.
const gitConfig = join(SCRATCH, 'gitconfig')
writeFileSync(gitConfig, '[user]\n\tname = prover\n\temail = prover@example.invalid\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_GLOBAL = gitConfig
process.env.GIT_CONFIG_NOSYSTEM = '1'

// The account-scoped model gate refuses keyless admission (no-credential:*),
// and the registry's resolved default below rides every admission — on a
// signed-out box the whole drive starves at resolution. A fixture sign-in
// row in the scratch home satisfies resolution offline (the
// prove-daemon-env-scrub / prove-credential-wall fixture shape); the roster
// below is fake, so no child ever runs and the token can never reach a wire.
mkdirSync(join(SCRATCH, 'home'), { recursive: true })
writeFileSync(
  join(SCRATCH, 'home', '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))
const { makeConcourseAdmitHandler, readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { ensureWorkerWorktree, workerWorktreeRoot } = await import('../../src/daemon/concourseWorktrees.ts')
const { validateWorkerModelChoice } = await import('../../src/services/concourse/workerModels.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'
import type { StreamJsonChildSpec } from '../../src/daemon/headlessRun.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const recordsDir = join(SCRATCH, 'daemon')
mkdirSync(recordsDir, { recursive: true })

function git(cwd: string, ...args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env } })
  return { ok: r.status === 0, stdout: r.stdout ?? '' }
}
function mkrepo(name: string): string {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', dir], { encoding: 'utf8', env: { ...process.env } })
  git(dir, 'commit', '--allow-empty', '-m', 'base')
  return dir
}
function mercuryBranches(ws: string): string[] {
  return git(ws, 'branch', '--list', 'mercury/*', '--format=%(refname:short)')
    .stdout.split('\n')
    .map(s => s.trim())
    .filter(Boolean)
}

/** The daemon's roster port, scripted: registrations observable, every
 *  spawn acknowledged (the child never actually runs here). */
class FakeRoster {
  registered: Array<{ short: string; spec: StreamJsonChildSpec }> = []
  present = new Map<string, { alive: boolean; ready: boolean }>()
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const p = this.present.get(short)
    return p ? { present: true, alive: p.alive, ready: p.ready } : { present: false, alive: false, ready: false }
  }
  list(): Array<{ short: string; outcome?: string }> {
    return [...this.present.keys()].map(short => ({ short }))
  }
  kill(_short: string): boolean {
    return true
  }
  registerLongLived(short: string, spec: StreamJsonChildSpec): { ok: boolean; pid?: number; error?: string } {
    this.registered.push({ short, spec })
    this.present.set(short, { alive: true, ready: true })
    return { ok: true, pid: 40_000 + this.registered.length }
  }
}
const roster = new FakeRoster()
const admit = makeConcourseAdmitHandler({ roster: () => roster, dir: recordsDir })
const specOf = (runnerId: string): StreamJsonChildSpec | undefined => roster.registered.findLast(r => r.short === runnerId)?.spec
const argvOf = (spec: StreamJsonChildSpec | undefined): string[] => [...(spec?.extraArgv ?? [])]

// The registry's own resolved default rides every admission explicitly —
// a refused registry is a legible refusal here, never a silent skip.
const resolvedModel = await validateWorkerModelChoice(undefined, 'session')
if (!resolvedModel.ok) {
  console.log(`  [FAIL] the registry resolves a default model — ${resolvedModel.reason}`)
  process.exit(1)
}
const modelKey = resolvedModel.entry.modelId

function seedLiveShared(ws: string, runnerId: string, sessionId: string): void {
  const workers = ((): Record<string, ConcourseWorkerRecordV1> => {
    try {
      return (JSON.parse(readFileSync(join(recordsDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, ConcourseWorkerRecordV1> }).workers
    } catch {
      return {}
    }
  })()
  workers[runnerId] = {
    schema: 1,
    runnerId,
    sessionId,
    workspaceId: ws,
    isolation: 'shared',
    modelKey,
    spawnedAt: Date.now() - 60_000,
    lastLiveAt: Date.now(),
    pid: process.pid,
  } as ConcourseWorkerRecordV1
  writeFileSync(join(recordsDir, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers }, null, 1)}\n`)
  roster.present.set(runnerId, { alive: true, ready: true })
}

console.log('============================================================')
console.log(' chat-birth — the solo in-place law on the real policy (L19)')
console.log('============================================================')

// ── A1: the solo no-mint law, with the estate control ───────────────────────
console.log('\n── A1: a solo birth beside a live sibling admits IN PLACE ──')
const ws1 = mkrepo('ws1')
{
  seedLiveShared(ws1, 'concourse-w1', randomUUID())
  const born = await admit({ workspaceDir: ws1, isolation: 'shared', bornBlank: true, modelKey })
  check('A1 the shared birth admits beside the live shared sibling', born.ok, born.ok ? '' : born.error)
  if (born.ok) {
    const rec = readSessionWorkers(recordsDir)[born.runnerId]
    check('A1 the record claims the solo in-place kind', rec?.isolation === 'shared', String(rec?.isolation))
    check('A1 no worktree was carved (no path on the record)', rec?.worktreePath === undefined && rec?.branchName === undefined)
    check('A1 the ground is the cwd (in place, the claim root)', specOf(born.runnerId)?.cwd === rec?.workspaceId, String(specOf(born.runnerId)?.cwd))
    check('A1 bornBlankAt stamps the newborn', rec?.bornBlankAt !== undefined)
  }
  check('A1 the worktree estate stayed untouched (no worktrees/ dir)', !existsSync(workerWorktreeRoot(recordsDir)))
  check('A1 no mercury/* branch exists in the repo', mercuryBranches(ws1).length === 0, mercuryBranches(ws1).join(','))
  // CONTROL — the estate must LIVE for defaulted (dispatch-shaped) claims:
  // the same collision, undefaulted by nobody, still folds to a fork.
  const defaulted = await admit({ workspaceDir: ws1, modelKey })
  check('A1c the defaulted admission still folds to the worktree estate', defaulted.ok, defaulted.ok ? '' : defaulted.error)
  if (defaulted.ok) {
    const rec = readSessionWorkers(recordsDir)[defaulted.runnerId]
    check('A1c the folded record is worktree-isolated with a branch', rec?.isolation === 'worktree-isolated' && rec?.branchName !== undefined)
    check('A1c the fork exists on disk', rec?.worktreePath !== undefined && existsSync(rec.worktreePath))
    check('A1c the branch is session-keyed, never the runner short', rec?.branchName !== undefined && !rec.branchName.includes(rec.runnerId))
  }
}

// ── A2: the namer over seeded leftovers ─────────────────────────────────────
console.log('\n── A2: the carve survives a fully-burned ladder ──')
{
  const ws2 = mkrepo('ws2')
  for (const name of ['mercury/seedx', ...[2, 3, 4, 5, 6].map(n => `mercury/seedx-${n}`)]) git(ws2, 'branch', name)
  const carved = await ensureWorkerWorktree(ws2, 'wt-exhausted', recordsDir, { branchName: 'mercury/seedx' })
  check('A2 an exhausted ladder still carves', carved.ok, carved.ok ? '' : carved.error)
  if (carved.ok) {
    const taken = new Set(['mercury/seedx', ...[2, 3, 4, 5, 6].map(n => `mercury/seedx-${n}`)])
    check('A2 the minted name is fresh (time-tailed past the ladder)', carved.branchName !== undefined && !taken.has(carved.branchName), String(carved.branchName))
    check('A2 the fork exists on its fresh branch', existsSync(carved.path))
  }
  const partial = await ensureWorkerWorktree(ws2, 'wt-partial', recordsDir, { branchName: 'mercury/lonely' })
  git(ws2, 'branch', 'mercury/taken')
  const suffixed = await ensureWorkerWorktree(ws2, 'wt-suffixed', recordsDir, { branchName: 'mercury/taken' })
  check('A2 a free base name lands unsuffixed', partial.ok && partial.branchName === 'mercury/lonely')
  check('A2 a taken base steps to -2 (the ladder still ladders)', suffixed.ok && suffixed.branchName === 'mercury/taken-2', suffixed.ok ? String(suffixed.branchName) : suffixed.error)
}

// ── A3 + A4: the operator's exact journey; new is never a replay ────────────
console.log('\n── A3/A4: continue → menu → New Session → a clean second session ──')
{
  const ws4 = mkrepo('ws4')
  const resumeId = randomUUID()
  // The continue: a record-less resume (its runner died with an earlier
  // boot; no standing record survives) — the solo road claims shared and
  // revives IN PLACE, never inside a fork it never asked for.
  const resumed = await admit({ workspaceDir: ws4, isolation: 'shared', resumeSessionId: resumeId, modelKey })
  check('A3 the record-less resume admits in place', resumed.ok, resumed.ok ? '' : resumed.error)
  const resumedRec = resumed.ok ? readSessionWorkers(recordsDir)[resumed.runnerId] : undefined
  check('A3 the resume claims shared, carves nothing', resumedRec?.isolation === 'shared' && resumedRec?.worktreePath === undefined)
  check('A3 the resume continues the SAME durable session', resumed.ok && resumed.sessionId === resumeId)
  check('A3 the runner boots with --resume (a revival, not a birth)', resumed.ok && argvOf(specOf(resumed.runnerId)).includes('--resume'))
  // The New Session beside it: the operator's friction moment, now clean.
  const born = await admit({ workspaceDir: ws4, isolation: 'shared', bornBlank: true, modelKey })
  check('A3 New Session admits a clean SECOND session beside the continue', born.ok, born.ok ? '' : born.error)
  const bornRec = born.ok ? readSessionWorkers(recordsDir)[born.runnerId] : undefined
  check('A3 both live in place — distinct ids, zero carves, no branches', born.ok && resumed.ok && born.sessionId !== resumed.sessionId && born.runnerId !== resumed.runnerId && bornRec?.worktreePath === undefined && mercuryBranches(ws4).length === 0)
  // A4 — new is never a replay: a fresh id, a --session-id boot, no
  // --resume anywhere near the birth.
  check('A4 the born id is fresh (∉ every prior session)', born.ok && born.sessionId !== resumeId && !Object.values(readSessionWorkers(recordsDir)).some(r => r.sessionId === born.sessionId && r.runnerId !== born.runnerId))
  const bornArgv = born.ok ? argvOf(specOf(born.runnerId)) : []
  check('A4 the birth boots --session-id, never --resume', bornArgv.includes('--session-id') && !bornArgv.includes('--resume'))
}

// ── A4 (source): the two solo doors, word-keyed ─────────────────────────────
console.log('\n── A4: the solo doors carry the claim in source ──')
{
  const bornDoor = read('src/services/switchboard/bornSession.ts')
  check("A4 the birth door claims 'shared' explicitly", /op: 'sessionAdmit'[\s\S]{0,400}isolation: 'shared'/.test(bornDoor))
  check('A4 the birth door never names resumeSessionId (new ≠ replay)', !bornDoor.includes('resumeSessionId'))
  const resumeDoor = read('src/services/switchboard/hopIntoSession.ts')
  check("A4 the resume door claims 'shared' beside its resumeSessionId", /resumeSessionId: sessionId, isolation: 'shared'/.test(resumeDoor))
}

// ── A5: the standing-estate migration at the reactivate ─────────────────────
console.log('\n── A5: an old exclusive record reactivates as shared ──')
{
  const ws5 = mkrepo('ws5')
  seedLiveShared(ws5, 'concourse-w8', randomUUID())
  const oldId = randomUUID()
  const workers = (JSON.parse(readFileSync(join(recordsDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, ConcourseWorkerRecordV1> }).workers
  workers['concourse-w9'] = {
    schema: 1,
    runnerId: 'concourse-w9',
    sessionId: oldId,
    workspaceId: ws5,
    isolation: 'exclusive',
    modelKey,
    spawnedAt: Date.now() - 3_600_000,
    lastLiveAt: Date.now() - 3_600_000,
    parkedAt: Date.now() - 1_800_000,
  } as ConcourseWorkerRecordV1
  writeFileSync(join(recordsDir, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers }, null, 1)}\n`)
  const reactivated = await admit({ workspaceDir: ws5, isolation: 'shared', resumeSessionId: oldId, modelKey })
  check('A5 the reactivate admits beside the live shared sibling', reactivated.ok, reactivated.ok ? '' : reactivated.error)
  const rec = Object.values(readSessionWorkers(recordsDir)).find(r => r.sessionId === oldId && r.endedAt === undefined)
  check("A5 the standing record re-claims 'shared' (the ground never re-fences)", rec?.isolation === 'shared', String(rec?.isolation))
}

console.log(`\n${failures === 0 ? 'ALL PINS HOLD' : `${failures} PIN(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
