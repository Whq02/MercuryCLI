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
