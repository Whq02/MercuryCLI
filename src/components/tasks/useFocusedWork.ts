import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  hasFocusedSession,
  subscribeThroughFocused,
} from '../../services/engine-connector/focusedConnector.js'
import { runnerRecordAlive, workRowRuns } from '../../services/engine-connector/workCounts.js'
import { readSessionWorkers } from '../../daemon/concourseSupervisor.js'
import type { MissionRowV1, WorkRosterV1, WorkRowV1 } from '../../services/engine-connector/types.js'
import { useAppState, useAppStateStore, type AppState } from '../../state/AppState.js'
import { getTelemetry, subscribeTelemetry, type SessionGlanceSnapshot } from '../../state/telemetryBus.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { EngineCarrierKind } from '../../services/engine-connector/types.js'
import { projectWorkRoster } from '../../utils/task/workRoster.js'
import { pidAlive } from '../../utils/pidAlive.js'

const subscribeFocusedWork = subscribeThroughFocused((connector, listener) =>
  connector.subscribeWork(listener),
)

export function useFocusedWorkRoster(): WorkRosterV1 {
  return useSyncExternalStore(
    subscribeFocusedWork,
    () => getFocusedSessionConnector().workRoster(),
    () => getFocusedSessionConnector().workRoster(),
  )
}

export function useFocusedMission(): readonly MissionRowV1[] {
  return useFocusedWorkRoster().mission
}

export function focusedWorkRows(
  tasks: AppState['tasks'] | undefined,
  roster: WorkRosterV1,
): WorkRowV1[] {
  const rows = projectWorkRoster(tasks ?? {})
  const seen = new Set(rows.map(r => r.id))
  for (const row of roster.rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  return rows
}

export function useFocusedWorkRows(): readonly WorkRowV1[] {
  const tasks = useAppState((s: AppState) => s.tasks)
  const roster = useFocusedWorkRoster()
  return useMemo(() => focusedWorkRows(tasks, roster), [tasks, roster])
}

export function focusedWorkflowRows(rows: readonly WorkRowV1[]): WorkRowV1[] {
  return rows.filter(r => r.kind === 'workflow')
}

export function runningWorkflowRows(rows: readonly WorkRowV1[]): WorkRowV1[] {
  return focusedWorkflowRows(rows).filter(workRowRuns)
}


export type FocusedRunnerPresence = 'blank' | 'live' | 'dormant'

export function focusedRunnerPresence(): FocusedRunnerPresence {
  if (!hasFocusedSession()) return 'blank'
  const sessionId = getFocusedSessionConnector().sessionId()
  const live = Object.values(readSessionWorkers()).some(
    rec => rec.sessionId === sessionId && runnerRecordAlive(rec, pidAlive),
  )
  return live ? 'live' : 'dormant'
}

export function otherSessionRunnerPids(focusedSessionId: string | null): Set<number> {
  const pids = new Set<number>()
  for (const rec of Object.values(readSessionWorkers())) {
    if (rec.endedAt !== undefined || rec.pid === undefined) continue
    if (focusedSessionId !== null && rec.sessionId === focusedSessionId) continue
    pids.add(rec.pid)
  }
  return pids
}

export function focusedSessionIdOrNull(): string | null {
  return hasFocusedSession() ? getFocusedSessionConnector().sessionId() : null
}
export type CompactWorkCounts = Readonly<{
  sessionsOn: number | null
  agentsHere: number | null
  monitorsHere: number | null
  samples?: number
}>

export function compactWorkCounts(input: {
  sessions: SessionGlanceSnapshot
  focusedSessionId: string | null
  carrier: EngineCarrierKind
  roster: WorkRosterV1
  tasks?: AppState['tasks']
}): CompactWorkCounts {
  const activeSessions = input.sessions.state === 'known'
    ? new Set(input.sessions.rows.filter(row => row.live && !row.paused && !row.parked && !row.stopped).map(row => row.sessionId))
    : null
  if (input.focusedSessionId !== null && input.carrier === 'in-process') activeSessions?.add(input.focusedSessionId)
  const sessionsOn = activeSessions?.size ?? null
  const samples = input.roster.samples?.length ?? 0
  if (input.focusedSessionId === null) return { sessionsOn, agentsHere: 0, monitorsHere: 0, samples: 0 }
  if (input.carrier === 'daemon') {
    const focused = input.sessions.state === 'known' ? input.sessions.rows.find(row => row.sessionId === input.focusedSessionId) : undefined
    if (focused !== undefined && activeSessions !== null && !activeSessions.has(input.focusedSessionId)) return { sessionsOn, agentsHere: 0, monitorsHere: 0, samples }
    if (focused === undefined || input.roster.reported === false) return { sessionsOn, agentsHere: null, monitorsHere: null, samples }
  }
  const rows = focusedWorkRows(input.carrier === 'in-process' ? input.tasks : undefined, input.roster)
  const byId = new Map<string, WorkRowV1>()
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row)
  const agents = new Set<string>()
  const monitors = new Set<string>()
  const topAgents = new Map<string, WorkRowV1>()
  for (const row of byId.values()) {
    if (row.kind === 'agent' || row.kind === 'teammate') topAgents.set(row.agentId ?? row.id, row)
    if (row.kind === 'monitor' && workRowRuns(row)) monitors.add(row.id)
  }
  for (const [id, row] of topAgents) {
    if (workRowRuns(row) && row.paused === undefined && row.pausedBy === undefined) agents.add(id)
  }
  let agentsKnown = true
  for (const row of byId.values()) {
    if (row.kind !== 'workflow') continue
    const parentRuns = workRowRuns(row) && row.pausedBy === undefined
    if (parentRuns && row.phases === undefined && (row.agentCount ?? 0) > 0) agentsKnown = false
    for (const phase of row.phases ?? []) {
      for (const child of phase.agents) {
        const key = child.agentId ?? `${row.workflowRunId ?? row.id}:${child.index}`
        if (!parentRuns) {
          if (child.agentId !== undefined) agents.delete(key)
          continue
        }
        if (child.state !== 'start' && child.state !== 'progress') continue
        if (child.waiting === undefined || child.pausedBy === undefined) {
          agentsKnown = false
          continue
        }
        if (child.pausedBy !== null || child.waiting === 'operator' || child.waiting === 'usage-window') {
          if (child.agentId !== undefined) agents.delete(key)
          continue
        }
        if (child.agentId !== undefined && topAgents.has(child.agentId)) continue
        agents.add(key)
      }
    }
  }
  return { sessionsOn, agentsHere: agentsKnown ? agents.size : null, monitorsHere: monitors.size, samples }
}

export function compactWorkSummaryText(counts: CompactWorkCounts, columns: number): string {
  const parts = [
    { value: counts.sessionsOn, noun: 'session', scope: 'on', short: 'S' },
    { value: counts.monitorsHere, noun: 'monitor', scope: 'here', short: 'M' },
    { value: counts.agentsHere, noun: 'agent', scope: 'here', short: 'A' },
  ]
  const available = parts.filter(part => part.value !== null)
  const unavailable = available.length !== parts.length
  const words = available.map(part => `${part.value} ${part.noun}${part.value === 1 ? '' : 's'} ${part.scope}`)
  if (unavailable) words.push('counts unavailable')
  const samples = counts.samples ?? 0
  if (samples > 0) words.push(`${samples} sample${samples === 1 ? '' : 's'}`)
  const full = words.join(' · ')
  if (stringWidth(full) <= columns) return full
  const fields = available.map(part => `${part.short}:${part.value}`)
  while (fields.length > 0) {
    const text = fields.join(' · ') + (unavailable || fields.length < parts.length ? ' …' : '')
    if (stringWidth(text) <= columns) return text
    fields.pop()
  }
  return columns > 0 ? '…' : ''
}

export function useCompactWorkCounts(): CompactWorkCounts {
  const store = useAppStateStore()
  const subscribe = useCallback((listener: () => void) => {
    const work = subscribeFocusedWork(listener)
    const telemetry = subscribeTelemetry(listener, true)
    const local = store.subscribe(listener)
    return () => { work(); telemetry(); local() }
  }, [store])
  const snapshot = useCallback(() => {
    const connector = getFocusedSessionConnector()
    return JSON.stringify(compactWorkCounts({
      sessions: getTelemetry().sessions,
      focusedSessionId: hasFocusedSession() ? connector.sessionId() : null,
      carrier: connector.carrier,
      roster: connector.workRoster(),
      tasks: store.getState().tasks,
    }))
  }, [store])
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  return useMemo(() => JSON.parse(value) as CompactWorkCounts, [value])
}
