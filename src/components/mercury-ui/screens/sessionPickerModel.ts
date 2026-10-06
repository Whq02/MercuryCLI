import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { conversationIdHere } from '../../../services/engine-connector/focusedConnector.js'
import { currentProject, subscribeCurrentProject } from '../../../utils/bootCardFacts.js'
import { filterResumableSessions } from '../../../utils/sessionResumeFilter.js'
import type { SessionListing } from '../../../types/logs.js'
import { getLogDisplayTitle } from '../../../utils/log.js'
import { formatRelativeTimeAgo } from '../../../utils/format.js'
import { boardHomedSessionIds } from '../../../daemon/concourseWorkers.js'
import { isSubstantiveSession, partitionByProject } from '../../../utils/sessionFilter.js'
import { isSessionCleared } from '../../../utils/sessionStorage/clearedSessions.js'
import {
  enrichSessionListings,
  sessionIdOfListing,
  listSessionsAcrossProjectsProgressive,
} from '../../../utils/sessionStorage.js'
import { useNowTick } from '../components.js'


export type SessionScope = 'project' | 'all'

export type SessionPickerRow = {
  project: string
  label: string
  seen: string
  log: SessionListing
  cleared?: boolean
}
export type SessionPickerFlatRow = { project: string; head: boolean; row: SessionPickerRow }

export function rowLabel(log: SessionListing): string {
  return getLogDisplayTitle(log, '(untitled session)')
}

export function rowProject(log: SessionListing): string {
  const p = log.projectPath || currentProject().dir
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

export function resumableNewestFirst(all: SessionListing[], currentSessionId: string): SessionListing[] {
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
  logs: SessionListing[],
  facts: SessionPickerFacts,
): { flat: SessionPickerFlatRow[]; elsewhereCount: number } {
  const now = facts.nowMs !== undefined ? new Date(facts.nowMs) : undefined
  const seenOf = (log: SessionListing): string =>
    formatRelativeTimeAgo(new Date(log.modified), { style: 'short', ...(now !== undefined ? { now } : {}) })
  const operatorLogs = logs.filter(l => !facts.boardHomed.has(sessionIdOfListing(l) ?? ''))
  const scoped =
    facts.scope === 'project'
      ? partitionByProject(
          operatorLogs.filter(l => !facts.isCleared(sessionIdOfListing(l))),
          facts.projectDir,
        )
      : { inProject: operatorLogs, elsewhere: [] as SessionListing[] }
  const viewed =
    facts.filterDir !== undefined
      ? partitionByProject(scoped.inProject, facts.filterDir).inProject
      : scoped.inProject
  const rows: SessionPickerRow[] = viewed.map(log => ({
    project: rowProject(log),
    label: rowLabel(log),
    seen: seenOf(log),
    log,
    cleared: facts.scope === 'all' ? facts.isCleared(sessionIdOfListing(log)) : undefined,
  }))
  const flat: SessionPickerFlatRow[] = rows.map((row, i) => ({
    project: row.project,
    head: i === 0 || rows[i - 1]!.project !== row.project,
    row,
  }))
  return { flat, elsewhereCount: scoped.elsewhere.length }
}

const ENRICH_BATCH = 50

export function useResumableSessionLogs(opts: { enabled?: boolean } = {}): {
  logs: SessionListing[] | null
  pendingMore: number
  dropSessions: (sessionIds: ReadonlySet<string>) => void
} {
  const enabled = opts.enabled !== false
  const [logs, setLogs] = useState<SessionListing[] | null>(null)
  const [pendingMore, setPendingMore] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void (async () => {
      try {
        const first = await listSessionsAcrossProjectsProgressive()
        const publish = (all: SessionListing[]): void => {
          if (alive) setLogs(resumableNewestFirst(all, conversationIdHere()))
        }
        let acc = first.logs
        let next = first.nextIndex
        publish(acc)
        if (alive) setPendingMore(Math.max(0, first.allStatLogs.length - next))
        while (alive && next < first.allStatLogs.length) {
          const batch = await enrichSessionListings(first.allStatLogs, next, ENRICH_BATCH)
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
    setLogs(prev => (prev === null ? prev : prev.filter(l => !sessionIds.has(sessionIdOfListing(l) ?? ''))))
  }
  return { logs, pendingMore, dropSessions }
}

export function useSessionPickerModel(
  scope: SessionScope,
  opts: { enabled?: boolean; filterDir?: string } = {},
): {
  logs: SessionListing[] | null
  pendingMore: number
  projectKey: string
  flat: SessionPickerFlatRow[]
  elsewhereCount: number
  dropSessions: (sessionIds: ReadonlySet<string>) => void
} {
  const { logs, pendingMore, dropSessions } = useResumableSessionLogs(opts)
  const projectKey = useSyncExternalStore(subscribeCurrentProject, () => currentProject().key, () => currentProject().key)
  const nowTick = useNowTick(30_000)
  const { flat, elsewhereCount } = useMemo(
    () =>
      logs === null
        ? { flat: [] as SessionPickerFlatRow[], elsewhereCount: 0 }
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
  return { logs, pendingMore, projectKey, flat, elsewhereCount, dropSessions }
}
