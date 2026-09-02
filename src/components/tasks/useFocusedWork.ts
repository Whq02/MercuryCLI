import { useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  hasFocusedSession,
  subscribeThroughFocused,
} from '../../services/engine-connector/focusedConnector.js'
import { runnerRecordAlive } from '../../services/engine-connector/workCounts.js'
import { readSessionWorkers } from '../../daemon/concourseSupervisor.js'
import type { WorkRosterV1 } from '../../services/engine-connector/types.js'
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
