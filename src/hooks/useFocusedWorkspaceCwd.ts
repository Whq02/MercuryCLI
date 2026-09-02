
import { useSyncExternalStore } from 'react'
import { subscribeCwdState } from '../bootstrap/state.js'
import {
  getFocusedSessionConnector,
  subscribeFocusedSessionConnector,
} from '../services/engine-connector/focusedConnector.js'

export function subscribeFocusedWorkspace(listener: () => void): () => void {
  const offGround = subscribeCwdState(listener)
  const offSlot = subscribeFocusedSessionConnector(listener)
  return () => {
    offGround()
    offSlot()
  }
}

export function getFocusedWorkspaceCwd(): string {
  return getFocusedSessionConnector().workspace().cwd
}

export function useFocusedWorkspaceCwd(): string {
  return useSyncExternalStore(subscribeFocusedWorkspace, getFocusedWorkspaceCwd, getFocusedWorkspaceCwd)
}
