// The face's one hand onto the focused chat's engine connector: a
// subscription to the connector slot, so a hop that re-points the slot
// repaints every consumer with the newly focused session's doors.
import { useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  subscribeFocusedSessionConnector,
} from '../services/engine-connector/focusedConnector.js'
import type { EngineConnectorV1 } from '../services/engine-connector/types.js'

export function useSessionConnector(): EngineConnectorV1 {
  return useSyncExternalStore(
    subscribeFocusedSessionConnector,
    getFocusedSessionConnector,
    getFocusedSessionConnector,
  )
}
