import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { getSessionId } from '../../../bootstrap/state.js'
import { currentProject, subscribeCurrentProject } from '../../../utils/bootCardFacts.js'
import { filterResumableSessions } from '../../../commands/resume/resume.js'
import type { LogOption } from '../../../types/logs.js'
import { getLogDisplayTitle } from '../../../utils/log.js'
import { formatRelativeTimeAgo } from '../../../utils/format.js'
import { crewTagOf, isCrewSession } from '../../../utils/sessionClass.js'
import { boardHomedSessionIds } from '../../../daemon/concourseSupervisor.js'
import { isSubstantiveSession, partitionByProject } from '../../../utils/sessionFilter.js'
import { isSessionCleared } from '../../../utils/sessionStorage/clearedSessions.js'
import {
  enrichLogs,
  getSessionIdFromLog,
  loadAllProjectsMessageLogsProgressive,
} from '../../../utils/sessionStorage.js'
import { useNowTick } from '../components.js'

// ============================================================================
//  sessionPickerModel — the ONE resumable-session picker core.
//
//  The list machinery the in-chat switcher (SessionManagerView — /sessions +
//  argless /resume) and the Boot face's resume entrance both present: the
//  progressive full-history load, the resumable/substantive projection, the
//  scope partition with cleared marks, the operator/crew split and the
//  board-homed exclusion. ONE picker core, two skins (ruling 4): the skins
//  own selection, confirms, geometry and paint; everything about WHICH rows
//  exist and WHAT their cells say lives here, so the two surfaces can never
//  disagree about the session estate. Pure projections take their facts as
//  arguments (the prover drives them with fixtures); the hooks bind the
//  estate's live owners.
// ============================================================================

export type SessionScope = 'project' | 'all'

// One resumable session, projected to the cells the list shows.
export type SessionPickerRow = {
  project: string
  label: string
  seen: string
  log: LogOption
  /** True in 'all' scope for a deliberately /clear'ed session (still resumable). */
  cleared?: boolean
}
export type SessionPickerFlatRow = { project: string; head: boolean; row: SessionPickerRow }
export type SessionPickerCrewRow = { tag: string; label: string; seen: string; log: LogOption }

// Derive a one-line label for a session row: delegate to the canonical
// getLogDisplayTitle (what /resume's LogSelector uses) instead of a drifted local
// copy — so /sessions and /resume agree (agentName/customTitle/summary priority,
// display-tag stripping, autonomous-tick skipping).
export function rowLabel(log: LogOption): string {
  return getLogDisplayTitle(log, '(untitled session)')
}

// Project bucket = the session's project basename (falls back to the current
// project — the catalog door's, never the boot's root). Groups the flat list
// the way /resume groups by project.
export function rowProject(log: LogOption): string {
  const p = log.projectPath || currentProject().dir
  // Split on BOTH separators so a win32 `C:\…\project` path yields the project
  // basename, not the whole path (the `/`-only split was a no-op there).
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

/** The resumable projection every load publishes (pure): drop sidechains +
 *  the current session (filterResumableSessions), then drop throwaway /
 *  "(no content)" render-junk (isSubstantiveSession) so a switcher never
 *  lands the flip on an empty command-only session — isSubstantiveSession
 *  works on LITE logs too (firstPrompt='' falls through to the real
 *  fileSize check), so this is safe over a partially-enriched list. Newest
 *  first — mirror /resume's per-group modified sort. */
export function resumableNewestFirst(all: LogOption[], currentSessionId: string): LogOption[] {
  const resumable = filterResumableSessions(all, currentSessionId).filter(isSubstantiveSession)
  resumable.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
  return resumable
}

/** The live facts a projection reads — injected, so the prover can drive
 *  the whole row model with fixtures and the skins can never fork it. */
export interface SessionPickerFacts {
  scope: SessionScope
  /** The catalog door's current project root ("THIS PROJECT" — cross-project
   *  awareness, law 1: the ground both switch doors move). */
  projectDir: string
  /** Board-homed sessions (standing concourse records) live on the board,
   *  not in a picker — post-sever they are operator-classed, so the crew
   *  filter no longer catches them. */
  boardHomed: ReadonlySet<string>
  /** The cleared cache's read (deliberately closed sessions). */
  isCleared: (sessionId: string | undefined) => boolean
  /** The clock the 'seen' cells derive against (a still needs it stable). */
  nowMs?: number
  /** The merged sessions·projects screen: a VIEW
   *  filter to one project's sessions — the highlighted project row scopes
   *  the list. Applies AFTER the scope partition through the landed
   *  matcher (partitionByProject/isProjectSession — path-keyed, never a
   *  display-name match); the crew section stays UNSCOPED (worktree lanes
   *  run outside project roots — the landed law's own reasoning). Absent ⇒
   *  byte-identical rows (identity pinned both directions); the in-chat
   *  skin never passes it. */
  filterDir?: string
}

/** The one row model both skins present (pure over its facts):
 *  PROJECT SCOPE — the quick switcher is the PROJECT's board: only sessions
 *  whose recorded cwd is this project root (or inside it), minus /clear'ed
 *  ones (deliberately closed — the cleared cache); other repos' sessions
 *  collapse to one honest count. ALL SCOPE (argless /resume + the `a`
 *  toggle) is the FULL history: every project, /clear'ed included (marked),
 *  nothing dropped. Crew rows stay UNSCOPED: daemon seats run in worktree
 *  lanes whose cwd can sit outside the project root — scoping them would
 *  hide real crew transcripts; the crew section classifies them apart.
 *  `head` marks each project-group boundary so a header prints once per
 *  project run ('all' scope interleaves projects chronologically — the row
 *  names its project). */
export function projectSessionPickerRows(
  logs: LogOption[],
  facts: SessionPickerFacts,
): { flat: SessionPickerFlatRow[]; crew: SessionPickerCrewRow[]; elsewhereCount: number } {
  const now = facts.nowMs !== undefined ? new Date(facts.nowMs) : undefined
  const seenOf = (log: LogOption): string =>
    formatRelativeTimeAgo(new Date(log.modified), { style: 'short', ...(now !== undefined ? { now } : {}) })
  const operatorLogs = logs.filter(
    l => !isCrewSession(l) && !facts.boardHomed.has(getSessionIdFromLog(l) ?? ''),
  )
  const scoped =
    facts.scope === 'project'
      ? partitionByProject(
          operatorLogs.filter(l => !facts.isCleared(getSessionIdFromLog(l))),
          facts.projectDir,
        )
      : { inProject: operatorLogs, elsewhere: [] as LogOption[] }
  // The act-two view filter: one project's sessions, over the scoped rows,
  // through the SAME landed matcher the scope partition rides.
  const viewed =
    facts.filterDir !== undefined
      ? partitionByProject(scoped.inProject, facts.filterDir).inProject
      : scoped.inProject
  const crewLogs = logs.filter(l => isCrewSession(l))
  const rows: SessionPickerRow[] = viewed.map(log => ({
    project: rowProject(log),
    label: rowLabel(log),
    seen: seenOf(log),
    log,
    cleared: facts.scope === 'all' ? facts.isCleared(getSessionIdFromLog(log)) : undefined,
  }))
  const flat: SessionPickerFlatRow[] = rows.map((row, i) => ({
    project: row.project,
    head: i === 0 || rows[i - 1]!.project !== row.project,
    row,
  }))
  const crew: SessionPickerCrewRow[] = crewLogs.map(log => ({
    tag: crewTagOf(log),
    label: rowLabel(log),
    seen: seenOf(log),
    log,
  }))
  return { flat, crew, elsewhereCount: scoped.elsewhere.length }
}

/** SL-2's enrichment batch — big enough to finish a large store in a few
 *  beats, small enough to keep the first paint instant. */
const ENRICH_BATCH = 50

/** THE FULL HISTORY load (SL-2), one owner: the progressive loader enriches
 *  the newest fifty for the first paint, then this effect walks the REST of
 *  the stat listing in batches until the whole store is on the list — a
 *  picker that stopped at those fifty across EVERY project dropped this
 *  project's chats entirely while calling itself "Full history".
 *  `pendingMore` counts the sessions still being enriched behind the first
 *  paint — a header says so, and an empty state waits for them. */
export function useResumableSessionLogs(opts: { enabled?: boolean } = {}): {
  logs: LogOption[] | null
  pendingMore: number
  /** Drop exactly these sessions from the list — the mirror of what the
   *  prune door removed; failures stay listed, honestly. */
  dropSessions: (sessionIds: ReadonlySet<string>) => void
} {
  // `enabled: false` is the proof/still seam: a mount with an injected model
  // must never walk the real session store (the hooks still run — only the
  // load body yields).
  const enabled = opts.enabled !== false
  const [logs, setLogs] = useState<LogOption[] | null>(null)
  const [pendingMore, setPendingMore] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void (async () => {
      try {
        const first = await loadAllProjectsMessageLogsProgressive()
        const publish = (all: LogOption[]): void => {
          if (alive) setLogs(resumableNewestFirst(all, getSessionId()))
        }
        let acc = first.logs
        let next = first.nextIndex
        publish(acc)
        if (alive) setPendingMore(Math.max(0, first.allStatLogs.length - next))
        while (alive && next < first.allStatLogs.length) {
          const batch = await enrichLogs(first.allStatLogs, next, ENRICH_BATCH)
          next = batch.nextIndex
          acc = [...acc, ...batch.logs]
          publish(acc)
          if (alive) setPendingMore(Math.max(0, first.allStatLogs.length - next))
        }
      } catch {
        if (alive) {
          setLogs([])
          setPendingMore(0)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [enabled])
  const dropSessions = (sessionIds: ReadonlySet<string>): void => {
    setLogs(prev => (prev === null ? prev : prev.filter(l => !sessionIds.has(getSessionIdFromLog(l) ?? ''))))
  }
  return { logs, pendingMore, dropSessions }
}

/** The bound model: the load, the catalog door's project beat (a ground
 *  move re-scopes an open list), the 30s 'seen' re-derive on the ONE
 *  uiClock, and the live-facts projection — everything a picker skin
 *  presents, with selection and paint left to the skin. */
export function useSessionPickerModel(
  scope: SessionScope,
  opts: { enabled?: boolean; filterDir?: string } = {},
): {
  logs: LogOption[] | null
  pendingMore: number
  projectKey: string
  flat: SessionPickerFlatRow[]
  crew: SessionPickerCrewRow[]
  elsewhereCount: number
  dropSessions: (sessionIds: ReadonlySet<string>) => void
} {
  const { logs, pendingMore, dropSessions } = useResumableSessionLogs(opts)
  // The current project's key, re-read on the catalog door's beat (a ground
  // move, a first chat catalogued) so an open list follows a project switch.
  const projectKey = useSyncExternalStore(subscribeCurrentProject, () => currentProject().key, () => currentProject().key)
  // a coarse 30s tick so the per-row 'seen' relative time ('2m ago')
  // recomputes as the panel stays open — the cadence rides the ONE uiClock
  // (shared bucket · scroll-drain skip · motion parking); the quantized
  // value changes each period, same dep semantics.
  const nowTick = useNowTick(30_000)
  const { flat, crew, elsewhereCount } = useMemo(
    () =>
      logs === null
        ? { flat: [] as SessionPickerFlatRow[], crew: [] as SessionPickerCrewRow[], elsewhereCount: 0 }
        : projectSessionPickerRows(logs, {
            scope,
            projectDir: currentProject().dir,
            boardHomed: boardHomedSessionIds(),
            isCleared: id => isSessionCleared(id),
            ...(opts.filterDir !== undefined ? { filterDir: opts.filterDir } : {}),
          }),
    // nowTick is an intentional dep: it forces 'seen' to re-derive on
    // the 30s clock even when `logs` is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logs, nowTick, scope, projectKey, opts.filterDir],
  )
  return { logs, pendingMore, projectKey, flat, crew, elsewhereCount, dropSessions }
}
