// The focused chat's WORK — the session's runner's own roster, read over
// the focused connector (the work-scope law: the work views render the
// FOCUSED session's rows and never a screen-global store). Shared by the
// /workflows board and the /tasks board; subscriptions ride the focused
// slot, so a hop re-points every reader and B's view carries zero of A's
// rows.
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

/** The focused session's work roster (content-keyed snapshot — unchanged
 *  work keeps its identity and re-renders nothing). */
export function useFocusedWorkRoster(): WorkRosterV1 {
  return useSyncExternalStore(
    subscribeFocusedWork,
    () => getFocusedSessionConnector().workRoster(),
    () => getFocusedSessionConnector().workRoster(),
  )
}

// The focused session's workspace cwd (the disk sweeps' scope) rides the
// estate's one owner, hooks/useFocusedWorkspaceCwd — the door on both the
// ground beat and the slot signal. A second copy here fed the same snapshot
// off the roster's beat under the same name: one concept, two owners.

/** What the work views know about the focused chat's carrier, derived once
 *  per call (renders read it inside memos keyed on data changes):
 *  · 'blank'   — the blank chat: no session, nothing could run;
 *  · 'live'    — a session with a live runner record;
 *  · 'dormant' — a session whose runner is not live (the revive-line
 *    vocabulary speaks; its roster rows are history, not motion). */
export type FocusedRunnerPresence = 'blank' | 'live' | 'dormant'

export function focusedRunnerPresence(): FocusedRunnerPresence {
  if (!hasFocusedSession()) return 'blank'
  const sessionId = getFocusedSessionConnector().sessionId()
  // Liveness is the RUNNER's, never the row's: the crash law keeps a dead
  // runner's record on the board (endedAt unset, its crash fact standing)
  // until the operator's own act, so an un-ended record alone would paint a
  // crashed session's last roster as motion.
  const live = Object.values(readSessionWorkers()).some(
    rec => rec.sessionId === sessionId && runnerRecordAlive(rec, pidAlive),
  )
  return live ? 'live' : 'dormant'
}

/** The live runner pids of OTHER concourse sessions (the leak filter's
 *  set): a claims-running disk manifest owned by one of these belongs to
 *  THAT session's board, never to the focused one. */
export function otherSessionRunnerPids(focusedSessionId: string | null): Set<number> {
  const pids = new Set<number>()
  for (const rec of Object.values(readSessionWorkers())) {
    if (rec.endedAt !== undefined || rec.pid === undefined) continue
    if (focusedSessionId !== null && rec.sessionId === focusedSessionId) continue
    pids.add(rec.pid)
  }
  return pids
}

/** The focused session's id, null for the blank chat. */
export function focusedSessionIdOrNull(): string | null {
  return hasFocusedSession() ? getFocusedSessionConnector().sessionId() : null
}
