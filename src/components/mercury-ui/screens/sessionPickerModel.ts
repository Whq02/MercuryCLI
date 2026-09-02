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


export type SessionScope = 'project' | 'all'

export type SessionPickerRow = {
  project: string
  label: string
  seen: string
  log: LogOption
  cleared?: boolean
}
export type SessionPickerFlatRow = { project: string; head: boolean; row: SessionPickerRow }
export type SessionPickerCrewRow = { tag: string; label: string; seen: string; log: LogOption }

export function rowLabel(log: LogOption): string {
  return getLogDisplayTitle(log, '(untitled session)')
}

export function rowProject(log: LogOption): string {
  const p = log.projectPath || currentProject().dir
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

export function resumableNewestFirst(all: LogOption[], currentSessionId: string): LogOption[] {
  const resumable = filterResumableSessions(all, currentSessionId).filter(isSubstantiveSession)
  resumable.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
  return resumable
}

export interface SessionPickerFacts {
  scope: SessionScope
  projectDir: string
  boardHomed: ReadonlySet<string>
  isCleared: (sessionId: string | undefined) => boolean
  nowMs?: number
  filterDir?: string
}

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

const ENRICH_BATCH = 50

export function useResumableSessionLogs(opts: { enabled?: boolean } = {}): {
  logs: LogOption[] | null
  pendingMore: number
  dropSessions: (sessionIds: ReadonlySet<string>) => void
} {
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
  const projectKey = useSyncExternalStore(subscribeCurrentProject, () => currentProject().key, () => currentProject().key)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logs, nowTick, scope, projectKey, opts.filterDir],
  )
  return { logs, pendingMore, projectKey, flat, crew, elsewhereCount, dropSessions }
}
