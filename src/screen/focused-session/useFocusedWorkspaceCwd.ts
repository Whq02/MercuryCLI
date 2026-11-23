
import { useSyncExternalStore } from 'react'
import { subscribeCwdState } from '../../boot/process-state/processState.js'
import {
  getFocusedSessionConnector,
  subscribeFocusedSessionConnector,
} from '../../engine/connector/focusedConnector.js'

function subscribeFocusedWorkspace(listener: () => void): () => void {
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

export function getFocusedWorkspaceOriginalCwd(): string {
  return getFocusedSessionConnector().workspace().originalCwd
}

export function useFocusedWorkspaceOriginalCwd(): string {
  return useSyncExternalStore(subscribeFocusedWorkspace, getFocusedWorkspaceOriginalCwd, getFocusedWorkspaceOriginalCwd)
}

export function useFocusedWorkspaceCwd(): string {
  return useSyncExternalStore(subscribeFocusedWorkspace, getFocusedWorkspaceCwd, getFocusedWorkspaceCwd)
}
