import { useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  subscribeFocusedSessionConnector,
} from '../../engine/connector/focusedConnector.js'
import type { EngineConnectorV1 } from '../../engine/connector/types.js'

export function useSessionConnector(): EngineConnectorV1 {
  return useSyncExternalStore(
    subscribeFocusedSessionConnector,
    getFocusedSessionConnector,
    getFocusedSessionConnector,
  )
}
