#!/usr/bin/env bun
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'lifecycle-collector-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_CREW_DIR
delete process.env.MERCURY_CHANNEL_ROOM
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_DELIVERY_ARTIFACT
delete process.env.MERCURY_DELIVERY_ARTIFACT
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const lifecycle = await import('../../src/substrate/stateLifecycle.ts')
const housekeeping = await import('../../src/utils/backgroundHousekeeping.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const DAY = 24 * 60 * 60 * 1000
let NOW = Date.parse('2026-08-08T12:00:00Z')
const fakeNow = (): number => NOW

const DEAD_PID = 3_999_999

const backdate = (p: string, ageMs: number): void => {
  const t = (NOW - ageMs) / 1000
  utimesSync(p, t, t)
}

const pass = (opts?: { budgetMs?: number; maxRemovals?: number }) =>
  lifecycle.runLifecyclePass({ ...opts, now: fakeNow })

const daemonHome = join(HOME, 'daemon')
const channels = join(HOME, 'channels')
const snapshots = join(HOME, 'shell-snapshots')
const tasksRoot = join(HOME, 'tasks')
const crewRoot = join(HOME, 'crew')

section('§1 COLLECTOR CLASSES')
{
  await lifecycle._resetLifecycleForProofs()

  mkdirSync(daemonHome, { recursive: true })
  const deadSidecar = join(daemonHome, `daemon.lock.claim-${DEAD_PID}-abcdef01`)
  const liveSidecar = join(daemonHome, `daemon.lock.claim-${process.pid}-abcdef02`)
  writeFileSync(deadSidecar, '{}')
  writeFileSync(liveSidecar, '{}')

  const presenceDir = join(channels, 'proj-12345678', 'presence')
  mkdirSync(presenceDir, { recursive: true })
  writeFileSync(join(presenceDir, 'ghost.json'), JSON.stringify({ seat: 'ghost', verb: 'active', ts: NOW - 25 * 60 * 60 * 1000 }))
  writeFileSync(join(presenceDir, 'live.json'), JSON.stringify({ seat: 'live', verb: 'editing', ts: NOW - 5000 }))

  mkdirSync(snapshots, { recursive: true })
  const oldSnap = join(snapshots, 'snapshot-zsh-1111-aaaaaa.sh')
  const newSnap = join(snapshots, 'snapshot-zsh-2222-bbbbbb.sh')
  writeFileSync(oldSnap, '# old')
  writeFileSync(newSnap, '# new')
  backdate(oldSnap, 45 * DAY)


  const oldList = join(tasksRoot, 'old-list')
  const freshList = join(tasksRoot, 'fresh-list')
  mkdirSync(oldList, { recursive: true })
  mkdirSync(freshList, { recursive: true })
  writeFileSync(join(oldList, '1.json'), '{}')
  writeFileSync(join(freshList, '1.json'), '{}')
  backdate(join(oldList, '1.json'), 45 * DAY)
  backdate(oldList, 45 * DAY)

  const oldSkeleton = join(crewRoot, 'conversations', 'empty-old')
  const fullDir = join(crewRoot, 'conversations', 'has-records')
  const freshSkeleton = join(crewRoot, 'conversations', 'empty-fresh')
  mkdirSync(oldSkeleton, { recursive: true })
  mkdirSync(fullDir, { recursive: true })
  mkdirSync(freshSkeleton, { recursive: true })
  writeFileSync(join(fullDir, 'record.json'), '{}')
  backdate(oldSkeleton, 10 * DAY)
  backdate(fullDir, 10 * DAY)

  let receipt = await pass({ budgetMs: 60_000, maxRemovals: 1000 })
  while (!receipt.cycleComplete) receipt = await pass({ budgetMs: 60_000, maxRemovals: 1000 })

  check('dead-owned sidecar collected (G01 family)', !existsSync(deadSidecar))
  check('live-owned sidecar retained', existsSync(liveSidecar))
  check('stale presence seat collected (the 14h "active" ghost)', !existsSync(join(presenceDir, 'ghost.json')))
  check('fresh presence seat retained', existsSync(join(presenceDir, 'live.json')))
  check('ancient shell snapshot collected', !existsSync(oldSnap))
  check('recent shell snapshot retained', existsSync(newSnap))
  check('old task list collected', !existsSync(oldList))
  check('fresh task list retained', existsSync(freshList))
  check('old empty crew skeleton collected', !existsSync(oldSkeleton))
  check('crew records NEVER collected (non-empty retained)', existsSync(join(fullDir, 'record.json')))
  check('fresh empty skeleton retained', existsSync(freshSkeleton))
  check('cycle failures zero on the clean sweep', receipt.cycleFailures === 0, `failures=${receipt.cycleFailures}`)
}

section('§2 BUDGET + CURSOR (G08)')
{
  await lifecycle._resetLifecycleForProofs()
  const p2 = join(channels, 'proj-b', 'presence')
  mkdirSync(p2, { recursive: true })
  writeFileSync(join(p2, 'g1.json'), JSON.stringify({ seat: 'g1', ts: NOW - 3 * DAY }))
  const snapOld2 = join(snapshots, 'snapshot-bash-0001-cccccc.sh')
  writeFileSync(snapOld2, '# old2')
  backdate(snapOld2, 45 * DAY)

  const first = await pass({ budgetMs: 60_000, maxRemovals: 1 })
  check('capped pass stops mid-cycle (budgetExhausted, not complete)', first.budgetExhausted && !first.cycleComplete)
  const cursorRaw = JSON.parse(readFileSync(join(HOME, '.lifecycle-cursor.json'), 'utf8')) as {
    classIndex: number
  }
  check('cursor persisted mid-cycle', typeof cursorRaw.classIndex === 'number')

  let resumed = await pass({ budgetMs: 60_000, maxRemovals: 1000 })
  let guard = 0
  while (!resumed.cycleComplete && guard++ < 10) resumed = await pass({ budgetMs: 60_000, maxRemovals: 1000 })
  check('resumed passes complete the cycle from the cursor', resumed.cycleComplete)
  check('both seeded items eventually collected across passes', !existsSync(join(p2, 'g1.json')) && !existsSync(snapOld2))
}

section('§3 THE SENTINEL LAW (G07)')
{
  await lifecycle._resetLifecycleForProofs()
  housekeeping._resetHousekeepingCycleForTesting()
  const jailDir = join(channels, 'proj-jail', 'presence')
  mkdirSync(jailDir, { recursive: true })
  const jailed = join(jailDir, 'stuck.json')
  writeFileSync(jailed, JSON.stringify({ seat: 'stuck', ts: NOW - 3 * DAY }))
  chmodSync(jailDir, 0o555)

  let outcome = await housekeeping.runCleanupCycleStep({ budgetMs: 60_000, now: fakeNow })
  let guard = 0
  while (outcome === 'continue' && guard++ < 10) {
    outcome = await housekeeping.runCleanupCycleStep({ budgetMs: 60_000, now: fakeNow })
  }
  check('a failing removal settles the cycle FAILED (sentinel withheld)', outcome === 'cycle-failed', `outcome=${outcome}`)
  check('the sentinel was NOT stamped', !existsSync(join(HOME, '.last-cleanup')))

  chmodSync(jailDir, 0o755)
  housekeeping._resetHousekeepingCycleForTesting()
  outcome = await housekeeping.runCleanupCycleStep({ budgetMs: 60_000, now: fakeNow })
  guard = 0
  while (outcome === 'continue' && guard++ < 10) {
    outcome = await housekeeping.runCleanupCycleStep({ budgetMs: 60_000, now: fakeNow })
  }
  check('healed, the cycle completes clean', outcome === 'cycle-complete', `outcome=${outcome}`)
  check('the healed sweep collected the jailed seat', !existsSync(jailed))
}

section('§4 RECURRING RE-ARM (G09)')
{
  await lifecycle._resetLifecycleForProofs()
  housekeeping._resetHousekeepingCycleForTesting()
  rmSync(join(HOME, '.last-cleanup'), { force: true })

  type Scheduled = { fn: () => void; ms: number }
  const queue: Scheduled[] = []
  housekeeping._setHousekeepingSeamsForTesting({
    now: fakeNow,
    schedule: (fn, ms) => {
      queue.push({ fn, ms })
      return { unref: () => undefined }
    },
  })

  housekeeping.startCleanupCycleLoop()
  check('first tick armed fast (the 5s catch-up gate)', queue.length === 1 && queue[0]!.ms === 5000, `ms=${queue[0]?.ms}`)

  const fireNext = async (): Promise<number> => {
    const next = queue.shift()
    if (!next) return -1
    next.fn()
    const settleDeadline = Date.now() + 5000
    while (queue.length === 0 && Date.now() < settleDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return next.ms
  }
  let ticks = 0
  while (!existsSync(join(HOME, '.last-cleanup')) && ticks++ < 12 && queue.length > 0) {
    await fireNext()
  }
  check('the loop completed a cycle and stamped the sentinel', existsSync(join(HOME, '.last-cleanup')))
  const stampedContent = existsSync(join(HOME, '.last-cleanup'))
    ? readFileSync(join(HOME, '.last-cleanup'), 'utf8')
    : '<never stamped>'
  const recurring = queue[queue.length - 1]
  check('the 24h recurring cadence is ARMED (the dead constant lives)', recurring?.ms === 24 * 60 * 60 * 1000, `ms=${recurring?.ms}`)

  NOW += 40 * DAY
  ticks = 0
  const sentinelNow = (): string =>
    existsSync(join(HOME, '.last-cleanup')) ? readFileSync(join(HOME, '.last-cleanup'), 'utf8') : '<never stamped>'
  while (queue.length > 0 && ticks++ < 12) {
    await fireNext()
    if (sentinelNow() !== stampedContent) break
  }
  check(
    'an advanced clock re-opens the cycle and re-stamps (genuine recurrence)',
    sentinelNow() !== stampedContent && sentinelNow() !== '<never stamped>',
  )
  housekeeping._setHousekeepingSeamsForTesting(null)
}

section('§5 HEADLESS MINT GATE (BM-17)')
{
  const { headlessMintAllowed } = await import('../../src/utils/hooks/runStopAdapter.ts')
  const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
  setIsInteractive(false)
  check('non-interactive + default-on flag ⇒ NO mint', headlessMintAllowed(undefined) === false)
  check('non-interactive + explicit truthy ⇒ mints (review mode)', headlessMintAllowed('1') === true)
  setIsInteractive(true)
  check('interactive + default-on ⇒ mints (unchanged)', headlessMintAllowed(undefined) === true)
  setIsInteractive(false)
}

section('§6 DRAFTS NO-OP (the _rev 616 pathology)')
{
  const drafts = await import('../../src/utils/promptDraft.ts')
  const sid = '11111111-2222-4333-8444-555555555555'
  const draft = { text: 'hello', cursorOffset: 5, mode: 'prompt', pastedContents: {} }
  drafts.saveDraftDebounced(sid, draft)
  await drafts.flushDraftSaves()
  const { createHash } = await import('node:crypto')
  const { getCwd } = await import('../../src/utils/cwd.ts')
  const draftFile = join(HOME, 'drafts', `${createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)}.json`)
  const revOf = (): number =>
    (JSON.parse(readFileSync(draftFile, 'utf8')) as { _rev?: { revision?: number } })._rev?.revision ?? -1
  const rev1 = revOf()
  check('first save published (revision minted)', rev1 >= 1, `rev=${rev1}`)
  drafts.saveDraftDebounced(sid, { ...draft })
  await drafts.flushDraftSaves()
  drafts.saveDraftDebounced(sid, { ...draft })
  await drafts.flushDraftSaves()
  check('identical re-saves publish NOTHING (revision unchanged)', revOf() === rev1, `rev=${revOf()} vs ${rev1}`)
  drafts.saveDraftDebounced(sid, { ...draft, text: 'hello world', cursorOffset: 11 })
  await drafts.flushDraftSaves()
  check('a real change still bumps the revision', revOf() === rev1 + 1, `rev=${revOf()}`)

  const doc = { v: 1 as const, scope: 'board:slot-1', body: 'draft body', items: [] }
  await drafts.saveScopedDoc(sid, doc)
  await drafts.flushScopedDocSaves()
  const scopedFile = join(HOME, 'drafts', `${createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)}-scoped.json`)
  const scopedRev = (): number =>
    (JSON.parse(readFileSync(scopedFile, 'utf8')) as { _rev?: { revision?: number } })._rev?.revision ?? -1
  const srev1 = scopedRev()
  await drafts.saveScopedDoc(sid, { ...doc })
  await drafts.flushScopedDocSaves()
  check('scoped store: identical doc re-save publishes nothing', scopedRev() === srev1, `rev=${scopedRev()} vs ${srev1}`)
  await drafts.saveScopedDoc(sid, { ...doc, body: 'draft body v2' })
  await drafts.flushScopedDocSaves()
  check('scoped store: a real change bumps', scopedRev() === srev1 + 1)
}

section('§7 WINDOW LABELS')
{
  const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')
  const schema = src('src/utils/config/schema.ts')
  check('schema declares BOTH window labels', schema.includes('lastCostWindow') && schema.includes('lastSessionMetricsWindow'))
  check(
    'the cost writer stamps its session-cumulative window',
    src('src/cost-tracker.ts').includes("kind: 'session-cumulative'"),
  )
  check(
    'the stats flush stamps its process-leg window',
    src('src/context/stats.tsx').includes("kind: 'process-leg'"),
  )
}

section('§8 PROVISIONAL SESSION RECONCILE')
{
  const { reconcileProvisionalSession } = await import('../../src/utils/provisionalSessionReconcile.ts')
  const provisionalId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const realId = 'ffffffff-0000-4111-8222-333333333333'
  const envDir = join(HOME, 'session-env', provisionalId)
  mkdirSync(envDir, { recursive: true })
  writeFileSync(join(envDir, 'sessionstart-hook-0.sh'), '# env')
  await reconcileProvisionalSession(provisionalId, realId)
  check('transcript-less boot id: session-env removed on switch', !existsSync(envDir))

  const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage.ts')
  const realTranscript = getTranscriptPathForSession(realId)
  mkdirSync(join(realTranscript, '..'), { recursive: true })
  writeFileSync(realTranscript, '{}\n')
  const realEnvDir = join(HOME, 'session-env', realId)
  mkdirSync(realEnvDir, { recursive: true })
  await reconcileProvisionalSession(realId, provisionalId)
  check('a TRANSCRIPTED id is never reconciled away', existsSync(realEnvDir))

  const weirdDir = join(HOME, 'session-env', 'not-a-uuid')
  mkdirSync(weirdDir, { recursive: true })
  await reconcileProvisionalSession('not-a-uuid', realId)
  check('a non-uuid id never joins a removal path', existsSync(weirdDir))
}

section('§9 WIRING')
{
  const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')
  const doctor = src('src/utils/healthReport.ts')
  check(
    '/doctor carries the lifecycle-collection row',
    doctor.includes("id: 'lifecycle-collection'") && doctor.includes('getLifecycleHealth'),
  )
  check(
    'the doctor verb runs the cleanup opportunity',
    doctor.includes("runLifecycleVerbOpportunity('doctor')"),
  )
  check(
    'the update verb runs the cleanup opportunity',
    src('src/cli/update.ts').includes("runLifecycleVerbOpportunity('update')"),
  )
  check(
    'the REPL boot arms the provisional reconcile',
    src('src/main.tsx').includes('armProvisionalSessionReconcile'),
  )
  check(
    'H-17: the crash prune logs its failures (no silent bare catch)',
    src('src/utils/crashReport.ts').includes('prune failed for'),
  )
  check(
    'the delivery flag row documents the headless gate',
    src('src/substrate/flagRegistry.ts').includes('headless -p completion mints nothing'),
  )
  check(
    'the sentinel is stamped ONLY by the complete-success path',
    (src('src/utils/backgroundHousekeeping.ts').match(/stampSentinel\(\)/g) ?? []).length >= 2 &&
      !src('src/utils/backgroundHousekeeping.ts').includes("writeFile(\n          join(getMercuryHome(), '.last-cleanup')"),
  )
  const gen = spawnSync('bun', ['run', join(import.meta.dir, 'gen-lifecycle-manifest.ts')], {
    encoding: 'utf8',
  })
  check('the lifecycle manifest renders from the declarations', gen.status === 0, gen.stderr?.slice(0, 120) ?? '')
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-lifecycle-collector: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-lifecycle-collector: all green')
