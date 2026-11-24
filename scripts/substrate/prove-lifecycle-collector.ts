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
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'lifecycle-collector-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_CREW_DIR
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_DELIVERY_ARTIFACT
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const lifecycle = await import('../../src/platform/substrate/stateLifecycle.ts')
const housekeeping = await import('../../src/platform/housekeeping/backgroundHousekeeping.ts')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')

let failures = 0
let sectionHint = ''
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && sectionHint ? ' — change: ' + sectionHint : ''}`)
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
const snapshots = join(HOME, 'shell-snapshots')
const tasksRoot = join(HOME, 'tasks')
const crewRoot = join(HOME, 'crew')

section('§1 COLLECTOR CLASSES')
sectionHint = 'the class that owns this item in LIFECYCLE_MANIFEST, or runLifecyclePass, in src/platform/substrate/stateLifecycle.ts'
{
  await lifecycle._resetLifecycleForProofs()

  mkdirSync(daemonHome, { recursive: true })
  const deadSidecar = join(daemonHome, `daemon.lock.claim-${DEAD_PID}-abcdef01`)
  const liveSidecar = join(daemonHome, `daemon.lock.claim-${process.pid}-abcdef02`)
  writeFileSync(deadSidecar, '{}')
  writeFileSync(liveSidecar, '{}')

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

  const { getMercuryTempDir } = await import('../../src/permissions/rules/filesystem.ts')
  const queryCopies = join(getMercuryTempDir(), 'json-queries')
  const remoteCopies = join(getMercuryTempDir(), 'remote-files')
  const copyOf = (root: string, name: string): string => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'input.json'), '{}')
    return join(root, name)
  }
  const deadQuery = copyOf(queryCopies, `read-${DEAD_PID}-AbCd12`)
  const liveQuery = copyOf(queryCopies, `read-${process.pid}-AbCd13`)
  const deadRemote = copyOf(remoteCopies, `copy-${DEAD_PID}-AbCd14`)
  const liveRemote = copyOf(remoteCopies, `copy-${process.pid}-AbCd15`)
  const otherForms = [copyOf(queryCopies, 'read-AbCd16'), copyOf(queryCopies, `copy-${DEAD_PID}-AbCd17`), copyOf(remoteCopies, `read-${DEAD_PID}-AbCd18`), copyOf(remoteCopies, `copy-${DEAD_PID}-AbCd19-more`), copyOf(queryCopies, `read-${DEAD_PID}x-AbCd20`), copyOf(join(getMercuryTempDir(), 'other-folder'), `read-${DEAD_PID}-AbCd21`)]
  writeFileSync(join(queryCopies, `read-${DEAD_PID}-AbCd22`), 'a file, not a folder')

  let receipt = await pass({ budgetMs: 60_000, maxRemovals: 1000 })
  while (!receipt.cycleComplete) receipt = await pass({ budgetMs: 60_000, maxRemovals: 1000 })

  check('dead-owned sidecar collected (G01 family)', !existsSync(deadSidecar))
  check('live-owned sidecar retained', existsSync(liveSidecar))
  check('ancient shell snapshot collected', !existsSync(oldSnap))
  check('recent shell snapshot retained', existsSync(newSnap))
  check('old task list collected', !existsSync(oldList))
  check('fresh task list retained', existsSync(freshList))
  check('old empty crew skeleton collected', !existsSync(oldSkeleton))
  check('crew records NEVER collected (non-empty retained)', existsSync(join(fullDir, 'record.json')))
  check('fresh empty skeleton retained', existsSync(freshSkeleton))
  check("a dead process's private query folder and private remote copy are collected", !existsSync(deadQuery) && !existsSync(deadRemote))
  check("a live process's private query folder and private remote copy are retained", existsSync(join(liveQuery, 'input.json')) && existsSync(join(liveRemote, 'input.json')))
  check('nothing outside the two name forms is touched', otherForms.every(path => existsSync(join(path, 'input.json'))) && existsSync(join(queryCopies, `read-${DEAD_PID}-AbCd22`)))
  check('cycle failures zero on the clean sweep', receipt.cycleFailures === 0, `failures=${receipt.cycleFailures}`)
}

section('§2 BUDGET + CURSOR (G08)')
sectionHint = 'the removal budget and the persisted cursor (.lifecycle-cursor.json) in runLifecyclePass, src/platform/substrate/stateLifecycle.ts'
{
  await lifecycle._resetLifecycleForProofs()
  const snapOld2 = join(snapshots, 'snapshot-bash-0001-cccccc.sh')
  writeFileSync(snapOld2, '# old2')
  backdate(snapOld2, 45 * DAY)
  const oldList2 = join(tasksRoot, 'old-list-2')
  mkdirSync(oldList2, { recursive: true })
  writeFileSync(join(oldList2, '1.json'), '{}')
  backdate(join(oldList2, '1.json'), 45 * DAY)
  backdate(oldList2, 45 * DAY)

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
  check('both seeded items eventually collected across passes', !existsSync(snapOld2) && !existsSync(oldList2))
}

section('§3 THE SENTINEL LAW (G07)')
sectionHint = 'runCleanupCycleStep in src/platform/housekeeping/backgroundHousekeeping.ts must return cycle-failed when a removal fails (runLifecyclePass in src/platform/substrate/stateLifecycle.ts counts cycleFailures) and only a cycle-complete cycle may stamp .last-cleanup'
{
  await lifecycle._resetLifecycleForProofs()
  housekeeping._resetHousekeepingCycleForTesting()
  const jailDir = snapshots
  mkdirSync(jailDir, { recursive: true })
  const jailed = join(jailDir, 'snapshot-zsh-3333-dddddd.sh')
  writeFileSync(jailed, '# stuck')
  backdate(jailed, 45 * DAY)
  let outcome = 'continue'
  let guard = 0
  const holdOpenOnWindows = async (): Promise<{ held: boolean; detail: string; release: () => Promise<void> }> => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = `$f = [System.IO.File]::Open('${jailed.replaceAll("'", "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 120`
    const holder: ChildProcess = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    holder.stdout?.on('data', chunk => { out += String(chunk) })
    holder.stderr?.on('data', chunk => { out += String(chunk) })
    const exited = new Promise<void>(resolve => holder.once('exit', () => resolve()))
    const deadline = Date.now() + 20_000
    while (!out.includes('held') && holder.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    const release = async (): Promise<void> => {
      if (holder.exitCode === null) holder.kill()
      await exited
    }
    return { held: out.includes('held'), detail: out.trim().slice(0, 200), release }
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('  [SKIP] running as root, which removes a file from a read-only directory; the failing-removal law is read under a user')
  } else {
    let release = async (): Promise<void> => { chmodSync(jailDir, 0o755) }
    let armed = true
    if (process.platform === 'win32') {
      const hold = await holdOpenOnWindows()
      release = hold.release
      armed = hold.held
      if (!armed) console.log(`  [SKIP] no process could hold the snapshot open (${hold.detail || 'powershell wrote nothing'}); the failing-removal law is read with the file held by another process on Windows`)
    } else {
      chmodSync(jailDir, 0o555)
    }
    if (armed) {
      outcome = await housekeeping.runCleanupCycleStep({ budgetMs: 60_000, now: fakeNow })
      while (outcome === 'continue' && guard++ < 10) {
        outcome = await housekeeping.runCleanupCycleStep({ budgetMs: 60_000, now: fakeNow })
      }
      check('a failing removal settles the cycle FAILED (sentinel withheld)', outcome === 'cycle-failed', `outcome=${outcome}`)
      check('the sentinel was NOT stamped', !existsSync(join(HOME, '.last-cleanup')))
    }
    await release()
    housekeeping._resetHousekeepingCycleForTesting()
  }
  outcome = await housekeeping.runCleanupCycleStep({ budgetMs: 60_000, now: fakeNow })
  guard = 0
  while (outcome === 'continue' && guard++ < 10) {
    outcome = await housekeeping.runCleanupCycleStep({ budgetMs: 60_000, now: fakeNow })
  }
  check('healed, the cycle completes clean', outcome === 'cycle-complete', `outcome=${outcome}`)
  check('the healed sweep collected the jailed snapshot', !existsSync(jailed))
}

section('§4 RECURRING RE-ARM (G09)')
sectionHint = 'startCleanupCycleLoop and its armNextCycle re-arm in src/platform/housekeeping/backgroundHousekeeping.ts'
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

  backdate(join(HOME, '.last-cleanup'), 0)
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
sectionHint = 'headlessMintAllowed in src/permissions/guards/runStopAdapter.ts'
{
  const { headlessMintAllowed } = await import('../../src/permissions/guards/runStopAdapter.ts')
  const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
  setIsInteractive(false)
  check('non-interactive + default-on flag ⇒ NO mint', headlessMintAllowed(undefined) === false)
  check('non-interactive + explicit truthy ⇒ mints (review mode)', headlessMintAllowed('1') === true)
  setIsInteractive(true)
  check('interactive + default-on ⇒ mints (unchanged)', headlessMintAllowed(undefined) === true)
  setIsInteractive(false)
}

section('§6 DRAFTS NO-OP (the _rev 616 pathology)')
sectionHint = 'saveDraftDebounced in src/screen/composer/input-core/promptDraft.ts must skip the write when the content is unchanged'
{
  const drafts = await import('../../src/screen/composer/input-core/promptDraft.ts')
  const sid = '11111111-2222-4333-8444-555555555555'
  const draft = { text: 'hello', cursorOffset: 5, mode: 'prompt', pastedContents: {} }
  drafts.saveDraftDebounced(sid, draft)
  await drafts.flushDraftSaves()
  const { createHash } = await import('node:crypto')
  const { getCwd } = await import('../../src/platform/files/cwd.ts')
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
}


section('§8 PROVISIONAL SESSION RECONCILE')
sectionHint = 'reconcileProvisionalSession in src/daemon/runner/provisionalSessionReconcile.ts'
{
  const { reconcileProvisionalSession } = await import('../../src/daemon/runner/provisionalSessionReconcile.ts')
  const provisionalId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const realId = 'ffffffff-0000-4111-8222-333333333333'
  const envDir = join(HOME, 'session-env', provisionalId)
  mkdirSync(envDir, { recursive: true })
  writeFileSync(join(envDir, 'sessionstart-hook-0.sh'), '# env')
  await reconcileProvisionalSession(provisionalId, realId)
  check('transcript-less boot id: session-env removed on switch', !existsSync(envDir))

  const { getTranscriptPathForSession } = await import('../../src/sessions/transcripts/sessionStorage.ts')
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
sectionHint = 'the lifecycle-collection row in src/platform/health/sections/crew/scratch.ts, the MERCURY_DELIVERY_ARTIFACT summary in FLAG_REGISTRY, or scripts/substrate/gen-lifecycle-manifest.ts (run it with bun to see its error)'
{
  const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
  const { getLifecycleHealth: lifecycleNow } = await import('../../src/platform/substrate/stateLifecycle.ts')
  const lifecycleSays = await crewChecks().find(row => row.id === 'lifecycle-collection')?.run()
  const lastPass = lifecycleNow()
  check(
    '/health carries the lifecycle-collection row',
    lifecycleSays !== undefined && (/ · cleanup pending$/.test(lifecycleSays.evidence) || (lastPass && lastPass.cycleFailures > 0 ? lifecycleSays.status === 'warn' && lifecycleSays.evidence.startsWith(`collection failing — ${lastPass.cycleFailures} failure(s) this cycle`) : lifecycleSays.status === 'ok' && lifecycleSays.evidence.startsWith(lastPass ? `last pass removed ${lastPass.removed}, ${lastPass.cycleComplete ? 'cycle complete' : 'cursor mid-cycle'}` : 'no pass this session'))),
    lifecycleSays?.evidence,
  )
  check(
    'the delivery flag row documents the headless gate',
    getFlagSpec('MERCURY_DELIVERY_ARTIFACT')?.summary.includes('headless run completion mints nothing') === true,
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
