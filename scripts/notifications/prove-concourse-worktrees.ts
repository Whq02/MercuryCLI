#!/usr/bin/env bun
// ============================================================================
//  prove-concourse-worktrees — the worktree core mechanics.
//
//  §1 typed workspace capability (git / plain-folder — the half)
//  §2 ensure: detached worktree created + registered; idempotent by dir
//  §3 crash-mid-create: a partial dir (no .git — no worker ever ran)
//     recreates safely (idempotency)
//  §4 THE DIRT LAW: clean · runtime-only (the product's project
//     runtime-home dirs, untracked) · authored (tracked edits + any other untracked;
//     authored WINS a mixed tree; unreadable ⇒ authored)
//  §5 reap: clean/runtime-only removed + pruned; AUTHORED RETAINED with the
//     exact files; missing dir = noop (idempotent)
//  §6 supervisor integration: settle + crash-reconcile both reap; the
//     authored variant retains AND records the typed evidence row (the
//     visible, never silent)
//  §7 collision-evidence store: bounded FIFO, fail-soft reads
//  §8 preflight: every term named, ALL refusals collected, and
//     the ZERO-WRITE law — a preview consumes nothing
//  §9 structural no-merge: the concourse daemon family never
//     writes workspace files — its fs writes are the record publishers
//     exactly; the worktree module mutates repositories through git only
//
//  Hermetic: scratch homes + a scratch git fixture; git identity pinned
//  per-invocation (proof-hygiene: no ambient reads).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// The snapshot's model projection (F-batch: newSession.modelOptions rides
// composeWorkerModelRegistry) reads config — in-process provers must open
// the gate exactly like the runtime boot does.
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'sg6-worktrees-'))
// The scratch home is pinned BEFORE anything reads config (the
// prove-concourse-supervisor harness law — this prover used to ride the
// operator's REAL home, an ambient-state read): the multi-refusal leg rides
// the account-scoped model gate, and keyless it refuses (no-credential:any)
// where the invalid-model refusal under test should compose. A fixture
// sign-in row satisfies resolution offline (the prove-daemon-env-scrub /
// prove-credential-wall fixture shape); no admission here ever spawns, so
// the token can never reach a wire.
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
mkdirSync(join(scratch, 'home'), { recursive: true })
writeFileSync(
  join(scratch, 'home', '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
process.env.GIT_CONFIG_GLOBAL = join(scratch, 'gitconfig-empty')
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
// The AMBIENT-STATE law, learned live here: git's DEFAULT core.excludesFile
// ($XDG_CONFIG_HOME/git/ignore) is consulted even with the config files
// pinned — an operator global-ignore listing the runtime-home dir would hide the
// runtime-dirt fixture from porcelain. Pin the whole XDG home to scratch.
process.env.XDG_CONFIG_HOME = join(scratch, 'xdg')
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')

const wt = await import('../../src/daemon/concourseWorktrees.ts')
const sup = await import('../../src/daemon/concourseSupervisor.ts')
const disp = await import('../../src/daemon/concourseDispatch.ts')

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

// The workspace fixture: a real repo with one commit + one tracked file.
const repo = join(scratch, 'repo')
mkdirSync(repo, { recursive: true })
git(repo, 'init', '-q')
git(repo, 'config', 'user.email', 'prover@mercury.local')
git(repo, 'config', 'user.name', 'Prover')
writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
git(repo, 'add', '.')
git(repo, 'commit', '-qm', 'seed')
const plain = join(scratch, 'plain-folder')
mkdirSync(plain, { recursive: true })
const daemon = join(scratch, 'daemon')

console.log('§1 typed workspace capability (half)')
{
  check("a repository classifies 'git'", wt.workspaceKindOf(repo) === 'git')
  check("a bare folder classifies 'plain-folder'", wt.workspaceKindOf(plain) === 'plain-folder')
}

console.log('§2 ensure — detached worktree, registered, idempotent')
{
  const first = await wt.ensureWorkerWorktree(repo, 'concourse-w1', daemon)
  check('ensure creates the worktree', first.ok === true && first.ok && first.created, JSON.stringify(first))
  const path = first.ok ? first.path : ''
  check('…as a real linked worktree (.git file present)', existsSync(join(path, '.git')))
  check('…registered with the repository', git(repo, 'worktree', 'list').includes(path))
  check('…detached (no branch claimed)', git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim() === 'HEAD')
  const second = await wt.ensureWorkerWorktree(repo, 'concourse-w1', daemon)
  check('a second ensure REUSES (created:false, same path)', second.ok === true && second.ok && !second.created && second.path === path)
  const refused = await wt.ensureWorkerWorktree(plain, 'concourse-w2', daemon)
  check("a plain folder refuses TYPED ('no-repository')", refused.ok === false && refused.code === 'no-repository', JSON.stringify(refused))
}

console.log('§3 crash-mid-create — a partial dir recreates safely')
{
  const partial = wt.workerWorktreePath('concourse-w3', daemon)
  mkdirSync(partial, { recursive: true })
  writeFileSync(join(partial, 'half-written.tmp'), 'crash left this')
  const ensured = await wt.ensureWorkerWorktree(repo, 'concourse-w3', daemon)
  check('ensure over a partial (no .git) dir RECREATES', ensured.ok === true && ensured.ok && ensured.created, JSON.stringify(ensured))
  check('…and the recreated worktree is valid', ensured.ok && existsSync(join(ensured.path, '.git')))
  wt.reapWorkerWorktree(repo, 'concourse-w3', daemon)
}

console.log('§4 THE DIRT LAW')
{
  const p = wt.workerWorktreePath('concourse-w1', daemon)
  check('a fresh worktree classifies CLEAN', wt.classifyWorktreeDirt(p).kind === 'clean')
  // The fixture dirt lives under the product's OWN runtime-home name — the
  // classifier's list is the law, never a spelling pinned here.
  const runtimeHome = wt.WORKTREE_RUNTIME_HOMES[0]!
  mkdirSync(join(p, runtimeHome), { recursive: true })
  writeFileSync(join(p, runtimeHome, 'settings.local.json'), '{}')
  const runtime = wt.classifyWorktreeDirt(p)
  check('untracked runtime-home files classify RUNTIME-ONLY', runtime.kind === 'runtime-only', JSON.stringify(runtime))
  writeFileSync(join(p, 'authored.ts'), 'export const work = 1\n')
  const mixed = wt.classifyWorktreeDirt(p)
  check('an authored untracked file OUTRANKS runtime dirt', mixed.kind === 'authored' && mixed.files.includes('authored.ts'), JSON.stringify(mixed))
  rmSync(join(p, 'authored.ts'))
  writeFileSync(join(p, 'tracked.txt'), 'v2 — worker edited\n')
  const tracked = wt.classifyWorktreeDirt(p)
  check('a TRACKED modification is always authored', tracked.kind === 'authored' && tracked.files.includes('tracked.txt'), JSON.stringify(tracked))
  git(p, 'checkout', '--', 'tracked.txt')
  const unreadable = wt.classifyWorktreeDirt(join(scratch, 'not-a-worktree'))
  check('an unreadable tree classifies AUTHORED (conservative)', unreadable.kind === 'authored')
}

console.log('§5 reap — clean/runtime reaped + pruned; authored retained; noop idempotent')
{
  // w1 currently carries runtime-only dirt (the runtime-home dir) — reapable by the dirt law.
  const p1 = wt.workerWorktreePath('concourse-w1', daemon)
  const reaped = wt.reapWorkerWorktree(repo, 'concourse-w1', daemon)
  check('runtime-only dirt cannot keep a worktree alive', reaped.outcome === 'reaped', JSON.stringify(reaped))
  check('…the dir is gone', !existsSync(p1))
  check('…and the registration is pruned', !git(repo, 'worktree', 'list').includes(p1))
  check('reap of a missing dir is a NOOP (idempotent —)', wt.reapWorkerWorktree(repo, 'concourse-w1', daemon).outcome === 'noop')

  const w4 = await wt.ensureWorkerWorktree(repo, 'concourse-w4', daemon)
  check('authored fixture worktree created', w4.ok === true)
  if (w4.ok) {
    writeFileSync(join(w4.path, 'real-work.ts'), 'export const authored = true\n')
    const retained = wt.reapWorkerWorktree(repo, 'concourse-w4', daemon)
    check(
      'AUTHORED work can never be reaped — retained with the exact files',
      retained.outcome === 'retained' && retained.outcome === 'retained' && retained.files.includes('real-work.ts'),
      JSON.stringify(retained),
    )
    check('…the worktree still exists', existsSync(join(w4.path, 'real-work.ts')))
  }
}

console.log('§6 supervisor integration — settle + reconcile reap; retention records evidence')
{
  const DEAD_PID = 4194999
  // Seed two records directly (production shape): w4 carries the AUTHORED
  // worktree from §5; w5 gets a clean one.
  const w5 = await wt.ensureWorkerWorktree(repo, 'concourse-w5', daemon)
  check('clean fixture worktree created', w5.ok === true)
  const recordOf = (runnerId: string, worktreePath: string) => ({
    schema: 1 as const,
    runnerId,
    sessionId: `sess-${runnerId}`,
    workspaceId: repo,
    isolation: 'worktree-isolated' as const,
    modelKey: 'fable' as const,
    spawnedAt: Date.now(),
    lastLiveAt: Date.now(),
    pid: DEAD_PID,
    workspaceKind: 'git' as const,
    worktreePath,
  })
  writeFileSync(
    sup.concourseWorkersPath(daemon),
    `${JSON.stringify({
      version: 1,
      workers: {
        'concourse-w4': recordOf('concourse-w4', wt.workerWorktreePath('concourse-w4', daemon)),
        'concourse-w5': recordOf('concourse-w5', wt.workerWorktreePath('concourse-w5', daemon)),
      },
    }, null, 1)}\n`,
  )
  const settled = sup.settleConcourseWorker('concourse-w5', daemon)
  check('explicit settle settles the record', settled)
  check('…and reaped its clean worktree', !existsSync(wt.workerWorktreePath('concourse-w5', daemon)))

  const receipt = sup.reconcileConcourseWorkers(new Set(), daemon)
  // The session-end visibility law: the
  // reconcile stamps the CRASH fact and KEEPS the row — no reap, no
  // endedAt; the fork's authored work stays with its NEEDS-YOU row.
  check('crash reconcile stamps the dead authored worker (row kept)', receipt.settled.includes('concourse-w4'), JSON.stringify(receipt))
  const w4 = sup.readSessionWorkers(daemon)['concourse-w4']
  check('…as a CRASH fact, not a burial (endedAt unset, reason on the record)', w4?.crash !== undefined && w4?.endedAt === undefined, JSON.stringify(w4?.crash))
  check('…its AUTHORED worktree survived the reconcile', existsSync(join(wt.workerWorktreePath('concourse-w4', daemon), 'real-work.ts')))
  // The RELEASE (the operator's own x x) is where the reap runs — and the
  // authored work refuses it with the TYPED retention evidence.
  check('the release settles the crashed row', sup.settleConcourseWorker('concourse-w4', daemon))
  check('…and the authored work still survives the release reap (the dirt law)', existsSync(join(wt.workerWorktreePath('concourse-w4', daemon), 'real-work.ts')))
  const evidence = sup.readCollisionEvidence(daemon)
  const retention = evidence.find(e => e.kind === 'authored-work-retained' && e.holders.some(h => h.workerId === 'concourse-w4'))
  check('the retention recorded its TYPED evidence row', retention !== undefined && (retention.files ?? []).includes('real-work.ts'), JSON.stringify(evidence.map(e => e.kind)))
}

console.log('§7 collision-evidence store — bounded FIFO, fail-soft')
{
  const evDir = join(scratch, 'ev-daemon')
  for (let i = 0; i < 105; i++) {
    sup.recordCollisionEvidence(
      { schema: 1, kind: 'exclusive-overlap', workspaceId: `/ws-${i}`, holders: [], observedAt: i },
      evDir,
    )
  }
  const rows = sup.readCollisionEvidence(evDir)
  check('the FIFO cap holds (newest 100 retained)', rows.length === 100 && rows[0]?.workspaceId === '/ws-5' && rows[99]?.workspaceId === '/ws-104', String(rows.length))
  mkdirSync(join(scratch, 'torn'), { recursive: true })
  writeFileSync(sup.concourseCollisionsPath(join(scratch, 'torn')), '{"version":1,"rows":')
  check('a torn file reads as empty (fail-soft)', sup.readCollisionEvidence(join(scratch, 'torn')).length === 0)
}

console.log('§8 preflight — every term named, zero writes')
{
  const pfDaemon = join(scratch, 'pf-daemon')
  mkdirSync(pfDaemon, { recursive: true })
  const ok = await disp.preflightConcourseDispatch({ workspaceDir: repo, isolation: 'worktree-isolated' }, pfDaemon)
  check('a clean request preflights OK', ok.ok === true, JSON.stringify(ok))

  // Seed a LIVE exclusive holder on the repo (this process's pid = alive).
  writeFileSync(
    sup.concourseWorkersPath(pfDaemon),
    `${JSON.stringify({
      version: 1,
      workers: {
        'concourse-w1': {
          schema: 1, runnerId: 'concourse-w1', sessionId: 's-live', workspaceId: sup.canonicalWorkspaceId(repo),
          isolation: 'exclusive', modelKey: 'fable', spawnedAt: 1, lastLiveAt: 1, pid: process.pid,
        },
      },
    }, null, 1)}\n`,
  )
  // Re-pin: a DEFAULTED second claim on a held git
  // repo silently FORKS (worktree-isolated) — the preview says OK; only an
  // EXPLICIT exclusive choice still names the collision (never overridden).
  const defaultedForks = await disp.preflightConcourseDispatch({ workspaceDir: repo }, pfDaemon)
  check(
    'a DEFAULTED claim beside the exclusive holder previews OK (ruling 1: it forks)',
    defaultedForks.ok === true,
    JSON.stringify(defaultedForks),
  )
  const collide = await disp.preflightConcourseDispatch({ workspaceDir: repo, isolation: 'exclusive' }, pfDaemon)
  check(
    'an EXPLICIT exclusive-vs-exclusive claim is REFUSED with the collision named',
    collide.ok === false && collide.refusals.some(r => r.code === 'workspace-collision'),
    JSON.stringify(collide),
  )
  const readOnlyOk = await disp.preflightConcourseDispatch({ workspaceDir: repo, isolation: 'worktree-isolated' }, pfDaemon)
  check('a worktree-isolated claim beside the exclusive holder previews OK (ruling 5)', readOnlyOk.ok === true, JSON.stringify(readOnlyOk))
  // The refusing model must refuse on EVERY box: 'haiku' rode the box's
  // ambient sign-in state (keyless boxes refused it, the operator's
  // signed-in home resolved it — the row was box-dependent either way). An
  // id no family declares refuses identically everywhere, and the spelling
  // fold leaves a non-catalogue id unrecognised by design.
  const multi = await disp.preflightConcourseDispatch(
    { workspaceDir: plain, isolation: 'worktree-isolated', modelKey: 'no-such-model-zz' },
    pfDaemon,
  )
  check(
    'MULTIPLE refusals collect (no-repository + invalid-model)',
    multi.ok === false && multi.refusals.some(r => r.code === 'no-repository') && multi.refusals.some(r => r.code === 'invalid-model'),
    JSON.stringify(multi),
  )
  const missing = await disp.preflightConcourseDispatch({ workspaceDir: join(scratch, 'nope') }, pfDaemon)
  check('a missing workspace refuses typed', missing.ok === false && missing.refusals.some(r => r.code === 'invalid-workspace'))

  // THE ZERO-WRITE LAW (the structural half): the preview consumed
  // nothing — records byte-identical, no dispatch ledger, no worktree.
  const before = readFileSync(sup.concourseWorkersPath(pfDaemon), 'utf8')
  await disp.preflightConcourseDispatch({ workspaceDir: repo }, pfDaemon)
  await disp.preflightConcourseDispatch({ workspaceDir: plain, isolation: 'worktree-isolated' }, pfDaemon)
  check('records byte-identical after previews', readFileSync(sup.concourseWorkersPath(pfDaemon), 'utf8') === before)
  check('no dispatch ledger was created', !existsSync(disp.concourseDispatchesPath(pfDaemon)))
  check('no worktree dir was created', !existsSync(wt.workerWorktreeRoot(pfDaemon)))
}

console.log('§9 structural no-merge — the family never writes workspace files')
{
  const read = (p: string) => readFileSync(join(import.meta.dir, '../../', p), 'utf8')
  const supervisor = read('src/daemon/concourseSupervisor.ts')
  const dispatch = read('src/daemon/concourseDispatch.ts')
  const worktrees = read('src/daemon/concourseWorktrees.ts')
  // The supervisor + dispatch publish EXACTLY through the ONE durable
  // primitive (DURABILITY §1, the 2-2-2 fold): zero hand-rolled fs writes —
  // every record file rides durableAtomicPublishSync (fsync'd temp → atomic
  // rename → dir fsync, boot-swept orphans). The tmp-publish law this
  // section pinned is now enforced INSIDE the primitive; the section pins
  // that the primitive is the only write route left.
  for (const [name, src] of [['concourseSupervisor', supervisor], ['concourseDispatch', dispatch]] as const) {
    check(
      `${name}: zero hand-rolled fs writes — every publish rides durableAtomicPublishSync`,
      !src.includes('writeFileSync(') && src.includes('durableAtomicPublishSync('),
      name,
    )
  }
  check('concourseWorktrees performs NO direct file writes (git owns repository mutation)', !worktrees.includes('writeFileSync('))
  check('no concourse module merges/overwrites workspace content (no copyFile/cp/appendFile)',
    [supervisor, dispatch, worktrees].every(s => !/copyFileSync|cpSync|appendFileSync/.test(s)))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-CONCOURSE-WORKTREES: PASS' : `\nPROVE-CONCOURSE-WORKTREES: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
