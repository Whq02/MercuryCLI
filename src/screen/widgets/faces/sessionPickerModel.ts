import { useMemo, useState, useSyncExternalStore } from 'react'
import { useLoad } from '../../effects/effects.js'
import { conversationIdHere } from '../../../engine/connector/focusedConnector.js'
import { currentProject, subscribeCurrentProject } from '../../boot-face/bootCardFacts.js'
import { filterResumableSessions } from '../../session-chooser/sessionResumeFilter.js'
import type { SessionListing } from '../../../sessions/transcripts/transcriptEntries.js'
import { getLogDisplayTitle } from '../../../platform/logs/errorLog.js'
import { formatRelativeTimeAgo } from '../../../platform/text/format.js'
import { boardHomedSessionIds, readSessionWorkers } from '../../../daemon/concourse-workers/concourseWorkers.js'
import { sanitizeLabel } from '../../concourse-model/concourseSnapshot.js'
import { sessionTitleOf } from '../../concourse-model/sessionNaming.js'
import { isSubstantiveSession, partitionByProject } from '../../session-chooser/sessionFilter.js'
import { isSessionCleared } from '../../../sessions/transcripts/clearedSessions.js'
import {
  enrichSessionListings,
  sessionIdOfListing,
  listSessionsAcrossProjectsProgressive,
} from '../../../sessions/transcripts/sessionStorage.js'
import {
  formatSessionReadFailures,
  mergeSessionReadFailures,
  type SessionReadFailures,
} from '../../../sessions/transcripts/sessionListings.js'
import { getProjectsDir } from '../../../sessions/transcripts/sessionStoragePortable.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { useNowTick } from '../components.js'


export type SessionScope = 'project' | 'all'

type SessionPickerRow = {
  project: string
  label: string
  seen: string
  log: SessionListing
  cleared?: boolean
}
export type SessionPickerFlatRow = { project: string; head: boolean; row: SessionPickerRow }

function workerTitlesBySession(recordsDir?: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  try {
    for (const rec of Object.values(readSessionWorkers(recordsDir))) {
      if (rec.endedAt !== undefined) continue
      const title = (rec.title ?? '').trim()
      if (title.length > 0) out.set(rec.sessionId, title)
    }
  } catch (error) {
    passedOver(error)
  }
  return out
}

export function rowLabel(log: SessionListing, workerTitle?: string): string {
  const renamed = (workerTitle ?? '').trim() || (log.customTitle ?? '').trim()
  const workspaceId = log.projectPath || currentProject().dir
  return sanitizeLabel(
    sessionTitleOf({ title: renamed, workspaceId }, () => {
      const prompt = getLogDisplayTitle({ ...log, agentName: undefined, customTitle: undefined, summary: undefined }, '')
      if (prompt.length > 0 && prompt !== log.sessionId?.slice(0, 8)) return prompt
      const fallback = getLogDisplayTitle({ ...log, agentName: undefined, customTitle: undefined }, '')
      return fallback.length > 0 ? fallback : null
    }),
  )
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
  workerTitles?: ReadonlyMap<string, string>
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
  const titles = facts.workerTitles ?? workerTitlesBySession()
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
    label: rowLabel(log, titles.get(sessionIdOfListing(log) ?? '')),
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

function useResumableSessionLogs(opts: { enabled?: boolean } = {}): {
  logs: SessionListing[] | null
  pendingMore: number
  readNotice: string | null
  dropSessions: (sessionIds: ReadonlySet<string>) => void
} {
  const enabled = opts.enabled !== false
  const [logs, setLogs] = useState<SessionListing[] | null>(null)
  const [pendingMore, setPendingMore] = useState(0)
  const [readFailures, setReadFailures] = useState<SessionReadFailures | undefined>(undefined)
  useLoad(signal => {
    if (!enabled) return
    void (async () => {
      try {
        const first = await listSessionsAcrossProjectsProgressive()
        const publish = (all: SessionListing[]): void => {
          if (!signal.aborted) setLogs(resumableNewestFirst(all, conversationIdHere()))
        }
        let acc = first.logs
        let next = first.nextIndex
        let failures = first.readFailures
        publish(acc)
        if (!signal.aborted) {
          setPendingMore(Math.max(0, first.allStatLogs.length - next))
          setReadFailures(failures)
        }
        while (!signal.aborted && next < first.allStatLogs.length) {
          const batch = await enrichSessionListings(first.allStatLogs, next, ENRICH_BATCH)
          next = batch.nextIndex
          acc = [...acc, ...batch.logs]
          failures = mergeSessionReadFailures(failures, batch.readFailures)
          publish(acc)
          if (!signal.aborted) {
            setPendingMore(Math.max(0, first.allStatLogs.length - next))
            setReadFailures(failures)
          }
        }
      } catch (error) {
        passedOver(error)
        if (!signal.aborted) {
          setLogs([])
          setPendingMore(0)
          setReadFailures({ count: 1, firstPath: getProjectsDir(), firstError: errorMessage(error) })
        }
      }
    })()
  }, [enabled])
  const dropSessions = (sessionIds: ReadonlySet<string>): void => {
    setLogs(prev => (prev === null ? prev : prev.filter(l => !sessionIds.has(sessionIdOfListing(l) ?? ''))))
  }
  return { logs, pendingMore, readNotice: formatSessionReadFailures(readFailures), dropSessions }
}

export function useSessionPickerModel(
  scope: SessionScope,
  opts: { enabled?: boolean; filterDir?: string } = {},
): {
  logs: SessionListing[] | null
  pendingMore: number
  readNotice: string | null
  projectKey: string
  flat: SessionPickerFlatRow[]
  elsewhereCount: number
  dropSessions: (sessionIds: ReadonlySet<string>) => void
} {
  const { logs, pendingMore, readNotice, dropSessions } = useResumableSessionLogs(opts)
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
    [logs, nowTick, scope, projectKey, opts.filterDir],
  )
  return { logs, pendingMore, readNotice, projectKey, flat, elsewhereCount, dropSessions }
}
