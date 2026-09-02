
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mapWithConcurrency } from '../utils/concurrency.js'
import { logForDebugging } from '../utils/debug.js'
import { getMercuryHome, getTeamsDir } from '../utils/envUtils.js'
import { cleanupOrphanDurableTemps } from './durablePublish.js'
import type { JournalRecoverySummary } from './operationJournal.js'
import { readStoreRecoveryEvents } from './storeRecovery.js'

const SWEEP_DIR_CAP = 128
const TASK_LIST_CAP = 64

const RECENT_QUARANTINE_WINDOW_MS = 24 * 60 * 60_000

export type BootRecoveryScope = 'session' | 'daemon'
export type BootRecoveryPhase = 'pending' | 'running' | 'done'

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
  teamJournal: JournalRecoverySummary | null
  runJournal: JournalRecoverySummary | null
  changeSetJournal: JournalRecoverySummary | null
  deadEpochTasks: { listsChecked: number; removed: number }
  daemonRecords: { state: 'live' | 'clean' | 'reconciled'; cleaned: string[] } | null
  leaderProjection: LeaderProjectionSeed | null
  quarantine: { total: number; recent: number }
  errors: string[]
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
    }
  }
}

export function getBootRecovery(): BootRecoveryState {
  return state
}

export function subscribeBootRecovery(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

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
  try {
    const { changeSetJournalDir } = await import(
      '../services/changeTransaction/changeSetContracts.js'
    )
    push(changeSetJournalDir())
  } catch {
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
  }
  const tasksRoot = join(home, 'tasks')
  try {
    for (const name of await readdir(tasksRoot)) {
      if (!name.startsWith('.')) push(join(tasksRoot, name))
    }
  } catch {
  }
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
  const epochChecks = await mapWithConcurrency(lists, 8, async list => {
    try {
      return (await readTaskEpoch(list)) > 0
    } catch {
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

export async function runBootRecovery(opts: {
  scope: BootRecoveryScope
  sessionId?: string
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

    try {
      report.orphanTemps = await sweepOrphanTemps(opts.scope, errors, notes)
    } catch (e) {
      errors.push(`orphan sweep failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    const describe = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))
    const [teamSettled, changeSetSettled] = await Promise.allSettled([
      import('../utils/swarm/teamOperations.js').then(m => m.recoverTeamJournal()),
      import('../services/changeTransaction/changeSetCommit.js').then(m => m.recoverChangeSetJournal()),
    ])
    if (teamSettled.status === 'fulfilled') report.teamJournal = teamSettled.value
    else errors.push(`team journal recovery failed: ${describe(teamSettled.reason)}`)
    if (changeSetSettled.status === 'fulfilled') report.changeSetJournal = changeSetSettled.value
    else errors.push(`change-set journal recovery failed: ${describe(changeSetSettled.reason)}`)

    try {
      report.deadEpochTasks = await sweepTaskEpochs(errors, notes)
    } catch (e) {
      errors.push(`dead-epoch GC failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      const { reconcileDaemonRecords } = await import('../daemon/reconcileRecords.js')
      const rec = await reconcileDaemonRecords({ projectDir: opts.projectDir })
      report.daemonRecords = { state: rec.state, cleaned: rec.cleaned }
    } catch (e) {
      errors.push(
        `daemon-records reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    if (opts.scope === 'session' && opts.sessionId) {
      report.leaderProjection = await rebuildLeaderProjection(opts.sessionId, errors)
    }

    try {
      const events = await readStoreRecoveryEvents()
      report.quarantine.total = events.length
      const cutoff = startedMs - RECENT_QUARANTINE_WINDOW_MS
      report.quarantine.recent = events.filter(e => {
        const t = Date.parse(e.ts)
        return Number.isFinite(t) && t >= cutoff
      }).length
    } catch {
    }

    report.durationMs = Date.now() - startedMs
    setState({ phase: 'done', report })
    const line = bootRecoveryStatusLine(state)
    if (line) logForDebugging(`[recovery] ${line.text} (${report.durationMs}ms)`)
    return report
  })()
  return inflight
}

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
      }
    }
  }
  return { dirs: dirs.length, stale }
}

export function _resetBootRecoveryForTests(): void {
  inflight = null
  state = { phase: 'pending', report: null }
}
