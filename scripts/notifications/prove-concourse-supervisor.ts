#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'
import type { StreamJsonChildSpec } from '../../src/daemon/headlessRun.ts'

const t = checker()
const root = scratchRoot('concourse-supervisor')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 } }))
writeFileSync(
  join(root, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
const {
  effectiveSeatCeiling,
  buildConcourseWorkerSpec,
  canonicalWorkspaceId,
  concourseWorkerStripEnv,
  evaluateConcourseAdmission,
  listConcourseWorkers,
  makeConcourseAdmitHandler,
  readSessionWorkers,
  reconcileConcourseWorkers,
  settleConcourseWorker,
} = await import('../../src/daemon/concourseSupervisor.js')

t.section('§1 — the pure seat-lease fold (the machine cap; line 6: no artificial ceiling)')
{
  const live: { workspaceId: string }[] = []
  let admitted = 0
  for (let i = 1; i <= 5; i++) {
    const d = evaluateConcourseAdmission(live, { workspaceId: `/scratch/ws-${i}` }, 5)
    if (d.admit) {
      admitted++
      live.push({ workspaceId: `/scratch/ws-${i}` })
    }
  }
  t.check('admissions up to the resolved ceiling succeed', admitted === 5, `admitted=${admitted}`)
  const sixth = evaluateConcourseAdmission(live, { workspaceId: '/scratch/ws-6' }, 5)
  t.check(
    'past the ceiling it refuses BEFORE worker/provider use, with a reason',
    sixth.admit === false && typeof sixth.reason === 'string' && sixth.reason.length > 0,
    JSON.stringify(sixth),
  )
  t.check(
    "the refusal names the consented capacity reading (never a bare number) and the typed code",
    sixth.admit === false && sixth.code === 'runtime-ceiling' && (sixth.reason ?? '').includes('the consented capacity reading: 5 seats'),
    JSON.stringify(sixth),
  )
  t.check(
    'the effective ceiling is machine-derived (≥ the two-seat floor), never a hard five',
    effectiveSeatCeiling() >= 2,
    String(effectiveSeatCeiling()),
  )
  const sameExclusive = evaluateConcourseAdmission(
    [{ workspaceId: '/scratch/repo-a' }],
    { workspaceId: '/scratch/repo-a' },
  )
  t.check(
    'same-workspace exclusive vs exclusive refuses as a workspace collision',
    sameExclusive.admit === false && sameExclusive.code === 'workspace-collision',
    JSON.stringify(sameExclusive),
  )
  const readPair = evaluateConcourseAdmission(
    [{ workspaceId: '/scratch/repo-a', isolation: 'read-only' }],
    { workspaceId: '/scratch/repo-a', isolation: 'read-only' },
  )
  t.check('read-only sessions coexist in one workspace', readPair.admit === true, JSON.stringify(readPair))
  const isolated = evaluateConcourseAdmission(
    [{ workspaceId: '/scratch/repo-a' }],
    { workspaceId: '/scratch/repo-a', isolation: 'worktree-isolated' },
  )
  t.check('a worktree-isolated claim coexists with an exclusive one', isolated.admit === true, JSON.stringify(isolated))
}

t.section('§2 — RR-01: canonicalization collapses aliases at admission')
{
  const real = join(root, 'workspace-real')
  mkdirSync(real, { recursive: true })
  const alias = join(root, 'workspace-alias')
  symlinkSync(real, alias)
  t.check(
    'a symlink alias resolves to the same workspaceId',
    canonicalWorkspaceId(alias) === canonicalWorkspaceId(real),
    `${canonicalWorkspaceId(alias)} vs ${canonicalWorkspaceId(real)}`,
  )
  const composed = '/scratch/caf\u00e9'
  const decomposed = '/scratch/cafe\u0301'
  t.check(
    'NFC normalization collapses composed/decomposed unicode',
    composed !== decomposed && canonicalWorkspaceId(composed) === canonicalWorkspaceId(decomposed),
    'NFC',
  )
}

t.section('§3 — the admission handler over a fake roster port')
{
  const dir = join(root, 'daemon')
  const registered: Array<{ short: string; spec: StreamJsonChildSpec }> = []
  const liveShorts = new Set<string>()
  let nextPid = 40000
  const roster = {
    has: (short: string) => ({ present: liveShorts.has(short) }),
    list: () => [...liveShorts].map(short => ({ short })),
    registerLongLived: (short: string, spec: StreamJsonChildSpec) => {
      registered.push({ short, spec })
      liveShorts.add(short)
      return { ok: true, pid: nextPid++ }
    },
  }
  const admit = makeConcourseAdmitHandler({ roster: () => roster, dir })

  const wsDirs: string[] = []
  for (let i = 1; i <= 5; i++) {
    const ws = join(root, `ws-${i}`)
    mkdirSync(ws, { recursive: true })
    wsDirs.push(ws)
  }
  const results = []
  results.push(await admit({ workspaceDir: wsDirs[0]! }))
  const dupe = await admit({ workspaceDir: wsDirs[0]! })
  t.check(
    'a duplicate defaulted claim on a plain folder holds on the git OFFER (no spawn)',
    dupe.ok === false &&
      dupe.code === 'no-repository' &&
      registered.length === 1 &&
      Array.isArray((dupe as { moves?: Array<{ verb?: string }> }).moves) &&
      (dupe as { moves?: Array<{ verb?: string }> }).moves?.some(m => m.verb === 'init-git') === true,
    JSON.stringify(dupe),
  )
  {
    const explicitDupe = await admit({ workspaceDir: wsDirs[0]!, isolation: 'exclusive' })
    t.check(
      'an EXPLICIT exclusive duplicate still refuses as a collision',
      explicitDupe.ok === false && explicitDupe.code === 'workspace-collision',
      JSON.stringify(explicitDupe),
    )
  }
  for (const ws of wsDirs.slice(1)) results.push(await admit({ workspaceDir: ws }))
  t.check(
    'five distinct workspaces admit through the handler',
    results.every(r => r.ok),
    JSON.stringify(results.find(r => !r.ok) ?? 'all ok'),
  )
  const sixthWs = join(root, 'ws-6')
  mkdirSync(sixthWs, { recursive: true })
  const spawnsBefore = registered.length
  const sixth = await admit({ workspaceDir: sixthWs })
  t.check(
    'the sixth request refuses with the preserved reason and NO spawn',
    sixth.ok === false && sixth.code === 'runtime-ceiling' && registered.length === spawnsBefore,
    JSON.stringify(sixth),
  )

  const first = results[0]!
  const records = readSessionWorkers(dir)
  const rec = first.ok ? records[first.runnerId] : undefined
  t.check(
    'the durable record relates runnerId ⇄ minted sessionId ⇄ canonical workspaceId',
    first.ok && rec != null && rec.sessionId === first.sessionId && rec.workspaceId === canonicalWorkspaceId(wsDirs[0]!),
    JSON.stringify(rec),
  )
  const spec = registered[0]!.spec
  const argv = spec.extraArgv ?? []
  t.check(
    'the worker spec pins the minted session id on first spawn (--session-id)',
    first.ok && argv.includes('--session-id') && argv.includes(first.sessionId),
    JSON.stringify(argv),
  )
  t.check(
    'the respawn argv RESUMES the same durable session (--resume, never a second --session-id) and keeps the ask-wire',
    first.ok &&
      (spec.respawnExtraArgv ?? []).join(' ') ===
        `--resume ${first.sessionId} --permission-prompt-tool stdio --include-partial-messages`,
    JSON.stringify(spec.respawnExtraArgv),
  )
  const strip = new Set(spec.stripEnv ?? [])
  t.check(
    'CH-01: the spec strips the splash handoff, alt-hold, launch id and the stray session-kit stamp',
    ['MERCURY_SPLASH_HANDOFF', 'MERCURY_ALT_HELD', 'MERCURY_LAUNCH_ID', 'MERCURY_SESSION_KIT'].every(v => strip.has(v)),
    JSON.stringify([...strip]),
  )
  t.check(
    'stripEnv derives from the one concourseWorkerStripEnv owner',
    concourseWorkerStripEnv().every(v => strip.has(v)),
    'subset',
  )
  const summary = listConcourseWorkers(liveShorts, dir)
  t.check('the bounded supervisor summary answers five live workers', summary.length === 5, String(summary.length))
}

t.section('§4 — settle + crash reconciliation (exactly-once, G13-conservative, rows KEPT)')
{
  const dir = join(root, 'daemon')
  const records = readSessionWorkers(dir)
  const ids = Object.keys(records)
  const victim = ids[0]!
  const survivorSet = new Set(ids.slice(1))
  const receipt = reconcileConcourseWorkers(survivorSet, dir)
  const victimRec = readSessionWorkers(dir)[victim]!
  t.check(
    'a rosterless dead-pid worker takes the CRASH fact exactly once — endedAt stays unset (the row is NOT removed)',
    receipt.settled.includes(victim) && victimRec.crash !== undefined && victimRec.endedAt === undefined,
    JSON.stringify({ receipt, crash: victimRec.crash, endedAt: victimRec.endedAt }),
  )
  t.check(
    'the crash reason speaks to the operator (found dead · enter resumes · x x releases)',
    /found dead/.test(victimRec.crash?.reason ?? '') && victimRec.crash?.respawning === false,
    JSON.stringify(victimRec.crash),
  )
  t.check(
    'the crashed row stays VISIBLE to the board read (listConcourseWorkers(null) keeps it)',
    listConcourseWorkers(null, dir).some(r => r.runnerId === victim),
    victim,
  )
  t.check(
    'live-roster workers stay untouched (any liveness signal ⇒ untouched)',
    receipt.live.length === survivorSet.size &&
      [...survivorSet].every(id => readSessionWorkers(dir)[id]!.crash === undefined),
    JSON.stringify(receipt.live),
  )
  const again = reconcileConcourseWorkers(survivorSet, dir)
  t.check('re-reconciliation stamps nothing twice (converged rows leave both lists)', again.settled.length === 0, JSON.stringify(again))
  t.check('manual settle settles exactly once', settleConcourseWorker(victim, dir) === true && settleConcourseWorker(victim, dir) === false, victim)
  t.check(
    'released rows leave the board read (endedAt is the release, not the crash)',
    !listConcourseWorkers(null, dir).some(r => r.runnerId === victim),
    victim,
  )
  const second = ids[1]!
  t.check('a live worker settles exactly once too', settleConcourseWorker(second, dir) === true && settleConcourseWorker(second, dir) === false, second)
}

t.section('§4b — the crash fact clears on the operator\'s own acts')
{
  const dir = join(root, 'daemon')
  const { markConcourseWorkerCrash, markConcourseWorkerDelivery } = await import('../../src/daemon/concourseSupervisor.ts')
  const ids = Object.keys(readSessionWorkers(dir)).filter(id => readSessionWorkers(dir)[id]!.endedAt === undefined)
  const subject = ids[0]!
  markConcourseWorkerCrash(subject, { reason: 'crashed mid-run (exit 1)', respawning: true }, dir)
  t.check(
    'the roster-path crash stamp lands durably (respawning true)',
    readSessionWorkers(dir)[subject]!.crash?.respawning === true,
    JSON.stringify(readSessionWorkers(dir)[subject]!.crash),
  )
  markConcourseWorkerDelivery(subject, dir)
  t.check(
    "the operator's next words CLEAR the crash fact (delivery = acknowledgement)",
    readSessionWorkers(dir)[subject]!.crash === undefined,
    JSON.stringify(readSessionWorkers(dir)[subject]!.crash),
  )
}

t.section('§4c — a stale respawn promise converges at the reconcile (the daemon died mid-episode)')
{
  const dir = join(root, 'daemon')
  const { markConcourseWorkerCrash, markConcourseWorkerDelivery } = await import('../../src/daemon/concourseSupervisor.ts')
  const ids = Object.keys(readSessionWorkers(dir)).filter(id => readSessionWorkers(dir)[id]!.endedAt === undefined)
  const subject = ids[0]!
  markConcourseWorkerCrash(subject, { reason: 'crashed mid-run (exit 1) · resumed — the interrupted ask needs a re-send', respawning: true }, dir)
  const stampedAt = readSessionWorkers(dir)[subject]!.crash!.at
  const others = new Set(ids.filter(id => id !== subject))
  const receipt = reconcileConcourseWorkers(others, dir)
  const converged = readSessionWorkers(dir)[subject]!.crash
  t.check(
    'the standing respawn-true fact converges to found-dead wording (respawning false)',
    converged !== undefined && converged.respawning === false && /found dead/.test(converged.reason),
    JSON.stringify(converged),
  )
  t.check('the crash episode keeps its original stamp time', converged?.at === stampedAt, JSON.stringify({ stampedAt, at: converged?.at }))
  t.check(
    'the convergence is silent — no fresh settle row, no re-journal (settled excludes the subject)',
    !receipt.settled.includes(subject),
    JSON.stringify(receipt),
  )
  const again = reconcileConcourseWorkers(others, dir)
  t.check('the re-run is a pure continue (idempotence holds past the convergence)', !again.settled.includes(subject), JSON.stringify(again))
  markConcourseWorkerDelivery(subject, dir)
}

t.section('§pause/resume — the delivery valve record half')
{
  const { pauseConcourseWorker, resumeConcourseWorker } = await import('../../src/daemon/concourseSupervisor.ts')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { join: j } = await import('node:path')
  const dir = j(root, 'daemon')
  mkdirSync(dir, { recursive: true })
  const seeded = {
    version: 1,
    workers: {
      'pv-live': { schema: 1, runnerId: 'pv-live', sessionId: 'pv-sess-live', workspaceId: '/ws/a', isolation: 'exclusive', modelKey: 'fable', spawnedAt: Date.now(), lastLiveAt: Date.now(), pid: process.pid },
      'pv-dead': { schema: 1, runnerId: 'pv-dead', sessionId: 'pv-sess-dead', workspaceId: '/ws/b', isolation: 'exclusive', modelKey: 'fable', spawnedAt: Date.now(), lastLiveAt: Date.now(), pid: 4194999 },
      'pv-ended': { schema: 1, runnerId: 'pv-ended', sessionId: 'pv-sess-ended', workspaceId: '/ws/c', isolation: 'exclusive', modelKey: 'fable', spawnedAt: Date.now(), lastLiveAt: Date.now(), endedAt: Date.now() },
    },
  }
  writeFileSync(j(dir, 'concourse-workers.json'), JSON.stringify(seeded))
  t.check('pause on a LIVE worker applies (working→paused lawful)', pauseConcourseWorker('pv-live', 'operator', dir).outcome === 'applied')
  const rec = readSessionWorkers(dir)['pv-live']!
  t.check('…and the record carries the durable receipt (pausedAt + pausedBy)', rec.pausedAt !== undefined && rec.pausedBy === 'operator')
  t.check('pausing a paused worker is a NOOP (idempotent)', JSON.stringify(pauseConcourseWorker('pv-live', 'operator', dir)) === JSON.stringify({ outcome: 'noop', reason: 'already-paused' }))
  t.check('resume re-opens the valve (paused→starting lawful)', resumeConcourseWorker('pv-live', 'operator', dir).outcome === 'applied')
  t.check('…clearing the pause facts', readSessionWorkers(dir)['pv-live']!.pausedAt === undefined)
  t.check('resuming a non-paused worker is a NOOP', JSON.stringify(resumeConcourseWorker('pv-live', 'operator', dir)) === JSON.stringify({ outcome: 'noop', reason: 'not-paused' }))
  t.check("a worker WITHOUT positive liveness refuses TYPED ('starting'→paused is not lawful)", JSON.stringify(pauseConcourseWorker('pv-dead', 'operator', dir)) === JSON.stringify({ outcome: 'refused', reason: 'not-pausable-yet' }))
  t.check('a settled record is terminal-immutable', JSON.stringify(pauseConcourseWorker('pv-ended', 'operator', dir)) === JSON.stringify({ outcome: 'refused', reason: 'terminal-immutable' }))
  t.check('an unknown worker refuses typed', JSON.stringify(pauseConcourseWorker('pv-none', 'operator', dir)) === JSON.stringify({ outcome: 'refused', reason: 'unknown-worker' }))
}

t.section('§worktree admission — isolated claims carve REAL worktrees')
{
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig-empty')
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  process.env.XDG_CONFIG_HOME = join(root, 'xdg')
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')
  const dir = join(root, 'wt-daemon')
  const registered: Array<{ short: string; spec: StreamJsonChildSpec }> = []
  const liveShorts = new Set<string>()
  let nextPid = 50000
  const roster = {
    has: (short: string) => ({ present: liveShorts.has(short) }),
    list: () => [...liveShorts].map(short => ({ short })),
    registerLongLived: (short: string, spec: StreamJsonChildSpec) => {
      registered.push({ short, spec })
      liveShorts.add(short)
      return { ok: true, pid: nextPid++ }
    },
  }
  const admit = makeConcourseAdmitHandler({ roster: () => roster, dir })
  const repo = join(root, 'wt-repo')
  mkdirSync(repo, { recursive: true })
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env } })
  g('init', '-q')
  g('config', 'user.email', 'prover@mercury.local')
  g('config', 'user.name', 'fixture-user')
  writeFileSync(join(repo, 'seed.txt'), 'v1\n')
  g('add', '.')
  g('commit', '-qm', 'seed')

  const iso = await admit({ workspaceDir: repo, isolation: 'worktree-isolated' })
  const recs = readSessionWorkers(dir)
  const isoRec = iso.ok ? recs[iso.runnerId] : undefined
  t.check('an isolated claim admits with a REAL worktree recorded', iso.ok && isoRec?.worktreePath !== undefined && isoRec.workspaceKind === 'git', JSON.stringify(isoRec))
  t.check(
    "…the worker's cwd IS the worktree, the CLAIM stays the canonical root",
    iso.ok &&
      registered[registered.length - 1]?.spec.cwd === isoRec?.worktreePath &&
      isoRec?.workspaceId === canonicalWorkspaceId(repo) &&
      isoRec.worktreePath !== isoRec.workspaceId,
    JSON.stringify({ cwd: registered[registered.length - 1]?.spec.cwd }),
  )
  const iso2 = await admit({ workspaceDir: repo, isolation: 'worktree-isolated' })
  const iso2Rec = iso2.ok ? readSessionWorkers(dir)[iso2.runnerId] : undefined
  t.check(
    'a SECOND isolated session shares the one repository lawfully (ruling 5) with its OWN worktree',
    iso2.ok && iso2Rec?.worktreePath !== undefined && iso2Rec.worktreePath !== isoRec?.worktreePath,
    JSON.stringify(iso2Rec?.worktreePath),
  )

  const plain = join(root, 'wt-plain')
  mkdirSync(plain, { recursive: true })
  const spawnsBefore = registered.length
  const refused = await admit({ workspaceDir: plain, isolation: 'worktree-isolated' })
  t.check(
    "a plain-folder ISOLATED claim refuses TYPED ('no-repository' honesty) with NO spawn",
    refused.ok === false && /plain folder|repository/.test(refused.error) && registered.length === spawnsBefore,
    JSON.stringify(refused),
  )
  const plainOk = await admit({ workspaceDir: plain })
  const plainRec = plainOk.ok ? readSessionWorkers(dir)[plainOk.runnerId] : undefined
  t.check(
    "a plain-folder EXCLUSIVE claim admits honestly with the typed 'plain-folder' capability",
    plainOk.ok && plainRec?.workspaceKind === 'plain-folder' && plainRec.worktreePath === undefined,
    JSON.stringify(plainRec?.workspaceKind),
  )
}

t.finish('prove-concourse-supervisor')
