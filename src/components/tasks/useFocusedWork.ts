import { useMemo, useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  hasFocusedSession,
  subscribeThroughFocused,
} from '../../services/engine-connector/focusedConnector.js'
import { runnerRecordAlive, workRowRuns } from '../../services/engine-connector/workCounts.js'
import { readSessionWorkers } from '../../daemon/concourseSupervisor.js'
import type { MissionRowV1, WorkRosterV1, WorkRowV1 } from '../../services/engine-connector/types.js'
import { useAppState, type AppState } from '../../state/AppState.js'
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
