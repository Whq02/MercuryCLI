/**
 * recoveryOrchestrator — ONE boot-time reconciliation pass over Mercury's
 * durable state.
 *
 * Runs BEFORE any projection is built (AppState team context, task-list
 * watchers, the daemon's fire trail) so every view starts from RECONCILED
 * durable state instead of whatever a previous process death left behind:
 *
 *   1. orphan-temp sweep    — stale durable-publish temps across the durable
 *                             homes (pattern-scoped, age-gated, bounded);
 *   2. journal recovery     — the teams journal (both scopes) + the daemon
 *                             run-record journal (daemon scope): incomplete
 *                             operations deterministically roll forward or
 *                             compensate (operationJournal semantics);
 *   3. dead-epoch task GC   — reclaim task bodies an interrupted reset left
 *                             behind (readers already filter them dead);
 *   4. projection rebuild   — session scope: if THIS session leads a team on
 *                             disk (resume), re-register the leader
 *                             registrations and hand the caller a typed
 *                             AppState seed (the projection is a VIEW of
 *                             committed state — this is where it gets
 *                             rebuilt, closing the resume gap);
 *   5. quarantine visibility— surface the store-recovery ledger
 *                             counts so damaged-store events are seen.
 *
 * Contract: NEVER throws (per-domain failures are recorded in the typed
 * report), idempotent (a second run over reconciled state is a no-op), and
 * memoized per process (one recovery per boot; repeat calls return the same
 * report). Runs are observable — /run, /team, and the doctor read the same
 * typed state through {@link getBootRecovery}/{@link subscribeBootRecovery}.
 * Domain modules load lazily so this substrate module stays leaf-cheap and
 * cycle-free.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mapWithConcurrency } from '../utils/concurrency.js'
import { logForDebugging } from '../utils/debug.js'
import { getMercuryHome, getTeamsDir } from '../utils/envUtils.js'
import { cleanupOrphanDurableTemps } from './durablePublish.js'
import type { JournalRecoverySummary } from './operationJournal.js'
import { readStoreRecoveryEvents } from './storeRecovery.js'

/** Bound on directories swept / epoch-bearing task lists GC'd per boot — a
 *  pathological home degrades to partial coverage, RECORDED in the report,
 *  never a hang. The task-list bound applies AFTER the cheap epoch probe:
 *  epoch-less lists (the overwhelming majority — plain session lists) cost
 *  one ENOENT each and never count against it. */
const SWEEP_DIR_CAP = 128
const TASK_LIST_CAP = 64

/** Quarantine events younger than this count as "recent" (operator-facing). */
const RECENT_QUARANTINE_WINDOW_MS = 24 * 60 * 60_000

export type BootRecoveryScope = 'session' | 'daemon'
export type BootRecoveryPhase = 'pending' | 'running' | 'done'

/** The typed AppState seed for a led team found on disk (session scope). */
export interface LeaderProjectionSeed {
  teamName: string
  teamFilePath: string
  leadAgentId: string
  teammates: Record<
    string,
    {
      name: string
      agentType?: string
      color?: string
      tmuxSessionName: string
      tmuxPaneId: string
      cwd: string
      worktreePath?: string
      spawnedAt: number
    }
  >
}

export interface BootRecoveryReport {
  schema: 1
  scope: BootRecoveryScope
  startedAt: string
  durationMs: number
  orphanTemps: { dirsSwept: number; removed: number }
  /** Teams-domain journal recovery (null: domain unreachable — see errors). */
  teamJournal: JournalRecoverySummary | null
  /** Daemon run-record journal recovery (daemon scope only). */
  runJournal: JournalRecoverySummary | null
  /** text-change-set journal recovery (both scopes — any process
   *  may own a multi-file commit). Null: domain unreachable — see errors. */
  changeSetJournal: JournalRecoverySummary | null
  deadEpochTasks: { listsChecked: number; removed: number }
  /** Stale daemon-record reconcile: a TerminateProcess'd or
   *  SIGKILL'd supervisor's supervisor.json/.lock + control.key (+ the
   *  project scheduler lock) removed once confirmed dead — conservative,
   *  one receipt. Null: step unreachable (see errors). */
  daemonRecords: { state: 'live' | 'clean' | 'reconciled'; cleaned: string[] } | null
  /** The led team found + re-registered on disk (session scope only). */
  leaderProjection: LeaderProjectionSeed | null
  quarantine: { total: number; recent: number }
  /** Per-domain failures — recovery is best-effort per domain, never a throw. */
  errors: string[]
  /** Benign coverage notes (bounded sweeps that left a remainder) — honest
   *  in the /run detail, never painted as a warning. */
  notes: string[]
}

export interface BootRecoveryState {
  phase: BootRecoveryPhase
  report: BootRecoveryReport | null
}

let state: BootRecoveryState = { phase: 'pending', report: null }
let inflight: Promise<BootRecoveryReport> | null = null
const listeners = new Set<() => void>()

function setState(next: BootRecoveryState): void {
  state = next
  for (const l of listeners) {
    try {
      l()
    } catch {
      /* a listener must never break recovery */
    }
  }
}

/** Referentially-stable snapshot for useSyncExternalStore consumers. */
export function getBootRecovery(): BootRecoveryState {
  return state
}

export function subscribeBootRecovery(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** One operator-facing status line shared by /run and /team (null: nothing
 *  worth a row — recovery ran clean and found nothing). Pure. */
export function bootRecoveryStatusLine(
  s: BootRecoveryState,
): { text: string; tone: 'ok' | 'warn' | 'neutral' } | null {
  if (s.phase === 'running') {
    return { text: 'reconciling durable state (journal scan in flight)…', tone: 'neutral' }
  }
  if (s.phase !== 'done' || !s.report) return null
  const r = s.report
  const journalWork =
    (r.teamJournal ? r.teamJournal.rolledForward.length + r.teamJournal.compensated.length : 0) +
    (r.runJournal ? r.runJournal.rolledForward.length + r.runJournal.compensated.length : 0) +
    (r.changeSetJournal
      ? r.changeSetJournal.rolledForward.length + r.changeSetJournal.compensated.length
      : 0)
  const unrecoverable =
    (r.teamJournal?.unrecoverable.length ?? 0) +
    (r.runJournal?.unrecoverable.length ?? 0) +
    (r.changeSetJournal?.unrecoverable.length ?? 0)
  const parts: string[] = []
  if (journalWork > 0) parts.push(`${journalWork} interrupted op(s) reconciled`)
  if (r.orphanTemps.removed > 0) parts.push(`${r.orphanTemps.removed} orphan temp(s) swept`)
  if (r.deadEpochTasks.removed > 0) parts.push(`${r.deadEpochTasks.removed} dead task file(s) reclaimed`)
  if (r.daemonRecords?.state === 'reconciled' && r.daemonRecords.cleaned.length > 0) {
    parts.push(`${r.daemonRecords.cleaned.length} stale daemon record(s) reconciled`)
  }
  if (r.leaderProjection) parts.push(`team "${r.leaderProjection.teamName}" projection rebuilt`)
  if (unrecoverable > 0) parts.push(`${unrecoverable} op(s) NEED ATTENTION (journal preserved)`)
  if (r.errors.length > 0) parts.push(`${r.errors.length} recovery error(s)`)
  if (parts.length === 0) return null
  return {
    text: `boot recovery: ${parts.join(' · ')}`,
    tone: unrecoverable > 0 || r.errors.length > 0 ? 'warn' : 'ok',
  }
}

/** Candidate directories for the orphan-temp sweep, bounded and explicit.
 *  Transcript/project dirs are deliberately absent: run sidecars get the
 *  per-process first-publish sweep in durablePublish, and enumerating every
 *  project home at boot is unbounded IO for no additional safety. */
async function collectSweepDirs(
  scope: BootRecoveryScope,
  errors: string[],
  notes: string[],
): Promise<string[]> {
  const dirs: string[] = []
  let candidates = 0
  const push = (d: string) => {
    candidates++
    if (dirs.length < SWEEP_DIR_CAP) dirs.push(d)
  }
  const home = getMercuryHome()
  const teams = getTeamsDir()
  push(home)
  push(join(home, 'recovery'))
  push(teams)
  push(join(teams, '.journal'))
  // the change-set durable home (journal + staged-temp targets are
  // swept per-dir at publish; the journal dir itself joins the boot sweep).
  try {
    const { changeSetJournalDir } = await import(
      '../services/changeTransaction/changeSetContracts.js'
    )
    push(changeSetJournalDir())
  } catch {
    /* unreachable domain — journal recovery reports separately */
  }
  try {
    for (const name of await readdir(teams)) {
      if (name.startsWith('.')) continue
      const teamDir = join(teams, name)
      push(teamDir)
      push(join(teamDir, 'inboxes'))
      push(join(teamDir, 'dedup'))
      push(join(teamDir, 'leases'))
    }
  } catch {
    /* no teams dir yet — nothing to sweep */
  }
  const tasksRoot = join(home, 'tasks')
  try {
    for (const name of await readdir(tasksRoot)) {
      if (!name.startsWith('.')) push(join(tasksRoot, name))
    }
  } catch {
    /* no tasks yet */
  }
  // The daemon home in BOTH scopes: the sweep is age-gated + pattern-scoped,
  // so it is safe beside a LIVE daemon, and a dead daemon's orphans should
  // not have to wait for the next daemon boot.
  try {
    const { daemonDir } = await import('../daemon/controlSocket.js')
    const daemon = daemonDir()
    push(daemon)
    push(join(daemon, 'journal'))
    push(join(daemon, 'outcomes'))
    const handoffRoot = join(daemon, 'handoff')
    try {
      for (const name of await readdir(handoffRoot)) {
        if (!name.startsWith('.')) push(join(handoffRoot, name))
      }
    } catch {
      /* no handoffs yet */
    }
  } catch (e) {
    errors.push(`daemon-home sweep skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (candidates > SWEEP_DIR_CAP) {
    notes.push(
      `orphan sweep bounded to ${SWEEP_DIR_CAP}/${candidates} dirs this boot — coverage is partial`,
    )
  }
  void scope
  return dirs
}

async function sweepOrphanTemps(
  scope: BootRecoveryScope,
  errors: string[],
  notes: string[],
): Promise<{ dirsSwept: number; removed: number }> {
  const dirs = await collectSweepDirs(scope, errors, notes)
  // Concurrent per-directory sweeps: the callee never throws (every arm is
  // caught inside it), the list is already capped, and the serial chain
  // paid one round trip per directory inside the pre-paint 3 s budget —
  // the budget that exists because this pass can run long.
  const removedPerDir = await Promise.all(dirs.map(dir => cleanupOrphanDurableTemps(dir)))
  const removed = removedPerDir.reduce((sum, r) => sum + r.length, 0)
  return { dirsSwept: dirs.length, removed }
}

async function sweepTaskEpochs(
  errors: string[],
  notes: string[],
): Promise<{ listsChecked: number; removed: number }> {
  const out = { listsChecked: 0, removed: 0 }
  const tasksRoot = join(getMercuryHome(), 'tasks')
  let lists: string[]
  try {
    lists = (await readdir(tasksRoot)).filter(n => !n.startsWith('.'))
  } catch {
    return out
  }
  const { readTaskEpoch, sweepDeadEpochTasks } = await import('../utils/tasks.js')
  // Cheap epoch probe first: only lists that ever went through a reset carry
  // an epoch marker; everything else (plain session lists — the overwhelming
  // majority of a real home) is one ENOENT and never counts against the cap.
  // The probe itself was the one GENUINELY uncapped serial loop of this pass
  // (the sweep below is TASK_LIST_CAP-bounded): a long-lived home's dozens-
  // to-hundreds of lists paid one round trip each inside the boot budget —
  // now a small order-preserving pool, so the cap still keeps the FIRST N
  // in the same lists order the serial walk kept.
  const epochChecks = await mapWithConcurrency(lists, 8, async list => {
    try {
      return (await readTaskEpoch(list)) > 0
    } catch {
      /* unreadable marker — the reader treats it as epoch 0; nothing to GC */
      return false
    }
  })
  const epochBearing: string[] = lists.filter((_, i) => epochChecks[i] === true)
  let toSweep = epochBearing
  if (epochBearing.length > TASK_LIST_CAP) {
    notes.push(
      `dead-epoch GC bounded to ${TASK_LIST_CAP}/${epochBearing.length} epoch-bearing lists this boot`,
    )
    toSweep = epochBearing.slice(0, TASK_LIST_CAP)
  }
  for (const list of toSweep) {
    try {
      out.removed += await sweepDeadEpochTasks(list)
      out.listsChecked++
    } catch (e) {
      errors.push(`dead-epoch GC failed for "${list}": ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

/** Rebuild the leader projection from committed durable state (session
 *  scope): module registrations now, and a typed AppState seed the REPL
 *  launcher injects — the resume path finally rebuilds what TeamCreate's
 *  projection step set mid-session. */
async function rebuildLeaderProjection(
  sessionId: string,
  errors: string[],
): Promise<LeaderProjectionSeed | null> {
  try {
    const { rebuildTeamProjection } = await import('../utils/swarm/teamOperations.js')
    const led = await rebuildTeamProjection(sessionId)
    if (!led) return null
    const helpers = await import('../utils/swarm/teamHelpers.js')
    const { setLeaderTeamName } = await import('../utils/tasks.js')
    const { setLeadTeamFallback } = await import('../utils/teammate.js')
    setLeaderTeamName(helpers.sanitizeName(led.teamName))
    setLeadTeamFallback(led.teamName)
    // Resume restores create-session semantics: this session owns the team
    // again, so its graceful exit cleans the team up (the SIGKILL orphan-dir
    // window from the matrix closes on the next resume+exit cycle).
    helpers.registerTeamForSessionCleanup(led.teamName)
    const teammates: LeaderProjectionSeed['teammates'] = {}
    const tf = await helpers.readTeamFileAsync(led.teamName)
    for (const m of tf?.members ?? []) {
      teammates[m.agentId] = {
        name: m.name,
        agentType: m.agentType,
        color: m.color,
        tmuxSessionName: '',
        tmuxPaneId: m.tmuxPaneId,
        cwd: m.cwd,
        worktreePath: m.worktreePath,
        spawnedAt: m.joinedAt,
      }
    }
    return {
      teamName: led.teamName,
      teamFilePath: led.teamFilePath,
      leadAgentId: led.leadAgentId,
      teammates,
    }
  } catch (e) {
    errors.push(`leader projection rebuild failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * Run the boot reconciliation pass. Memoized per process — the first caller
 * runs it, everyone else (UI, doctor, a second wiring point) receives the
 * same report. `sessionId` arms the leader-projection rebuild (session scope).
 */
export async function runBootRecovery(opts: {
  scope: BootRecoveryScope
  sessionId?: string
  /** The scheduling/project dir for the daemon-records step (the daemon
   *  passes its resolved dir; session scope resolves via the project root). */
  projectDir?: string
}): Promise<BootRecoveryReport> {
  if (inflight) return inflight
  inflight = (async (): Promise<BootRecoveryReport> => {
    const startedMs = Date.now()
    const errors: string[] = []
    const notes: string[] = []
    const report: BootRecoveryReport = {
      schema: 1,
      scope: opts.scope,
      startedAt: new Date(startedMs).toISOString(),
      durationMs: 0,
      orphanTemps: { dirsSwept: 0, removed: 0 },
      teamJournal: null,
      runJournal: null,
      changeSetJournal: null,
      deadEpochTasks: { listsChecked: 0, removed: 0 },
      daemonRecords: null,
      leaderProjection: null,
      quarantine: { total: 0, recent: 0 },
      errors,
      notes,
    }
    setState({ phase: 'running', report: null })

    // 1. Orphan temps — before journal recovery so a recovered op republishes
    //    into already-clean directories.
    try {
      report.orphanTemps = await sweepOrphanTemps(opts.scope, errors, notes)
    } catch (e) {
      errors.push(`orphan sweep failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 2. Journal recovery — teams journal in both scopes (any process may own
    //    team operations); the daemon run-record journal only where the
    //    daemon's views live.
    // (The old fire path's run-record journal died with its writer — the
    // report's runJournal field stays null; old journal debris is inert.)
    // The text-change-set journal recovers in BOTH scopes too — any process
    // may die mid multi-file commit; its walker is idempotent + digest-
    // guarded (later bytes never overwritten; unresolved records preserved).
    // The two domains touch unrelated directories with no ordering
    // dependency: they SETTLE concurrently inside the same boot budget, and
    // the report's error attribution stays deterministic — team first, then
    // change-set, by construction, never by settlement time.
    const describe = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))
    const [teamSettled, changeSetSettled] = await Promise.allSettled([
      import('../utils/swarm/teamOperations.js').then(m => m.recoverTeamJournal()),
      import('../services/changeTransaction/changeSetCommit.js').then(m => m.recoverChangeSetJournal()),
    ])
    if (teamSettled.status === 'fulfilled') report.teamJournal = teamSettled.value
    else errors.push(`team journal recovery failed: ${describe(teamSettled.reason)}`)
    if (changeSetSettled.status === 'fulfilled') report.changeSetJournal = changeSetSettled.value
    else errors.push(`change-set journal recovery failed: ${describe(changeSetSettled.reason)}`)

    // 3. Dead-epoch task GC — after journal recovery (a compensated
    //    team-create may have just reset an epoch).
    try {
      report.deadEpochTasks = await sweepTaskEpochs(errors, notes)
    } catch (e) {
      errors.push(`dead-epoch GC failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 3b. Stale daemon records — BOTH scopes: a TerminateProcess'd
    //     supervisor (win32 fires no signal and no 'exit' event) leaves
    //     supervisor.json/.lock + control.key + the scheduler lock as debris
    //     that nothing else reconciles on session-only homes. Conservative:
    //     any liveness signal (pid, lock holder, control-socket pong) ⇒
    //     untouched; one receipt line names every removal.
    try {
      const { reconcileDaemonRecords } = await import('../daemon/reconcileRecords.js')
      const rec = await reconcileDaemonRecords({ projectDir: opts.projectDir })
      report.daemonRecords = { state: rec.state, cleaned: rec.cleaned }
    } catch (e) {
      errors.push(
        `daemon-records reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    // 4. Projection rebuild — session scope, only over now-RECONCILED state.
    if (opts.scope === 'session' && opts.sessionId) {
      report.leaderProjection = await rebuildLeaderProjection(opts.sessionId, errors)
    }

    // 5. Quarantine visibility (report-only — the ledger is the record).
    try {
      const events = await readStoreRecoveryEvents()
      report.quarantine.total = events.length
      const cutoff = startedMs - RECENT_QUARANTINE_WINDOW_MS
      report.quarantine.recent = events.filter(e => {
        const t = Date.parse(e.ts)
        return Number.isFinite(t) && t >= cutoff
      }).length
    } catch {
      /* ledger unreadable — total stays 0; the doctor row reads it directly */
    }

    report.durationMs = Date.now() - startedMs
    setState({ phase: 'done', report })
    const line = bootRecoveryStatusLine(state)
    if (line) logForDebugging(`[recovery] ${line.text} (${report.durationMs}ms)`)
    return report
  })()
  return inflight
}

/** Read-only census of stale orphan temps across the same bounded dir set
 *  the boot sweep covers (the doctor's diagnose-only view — nothing is
 *  deleted here; the boot pass and per-dir first-publish sweeps do that). */
export async function countOrphanDurableTemps(): Promise<{ dirs: number; stale: number }> {
  const { stat } = await import('node:fs/promises')
  const { isDurableTempName } = await import('./durablePublish.js')
  const dirs = await collectSweepDirs('session', [], [])
  let stale = 0
  const cutoff = Date.now() - 10 * 60_000
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!isDurableTempName(name)) continue
      try {
        if ((await stat(join(dir, name))).mtimeMs < cutoff) stale++
      } catch {
        /* raced a sweep — fine */
      }
    }
  }
  return { dirs: dirs.length, stale }
}

/** TEST-ONLY: forget the per-process memo so proofs can run repeated boots. */
export function _resetBootRecoveryForTests(): void {
  inflight = null
  state = { phase: 'pending', report: null }
}
