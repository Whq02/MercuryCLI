// The focused chat's folder AS RENDERED — session truth (the connector's
// workspace door), never the process cwd (Law 9). The door has no beat of
// its own, so two beats reach this feed: the ground beat (bootstrap
// subscribeCwdState — every ground move, the class seam) and the
// focused-slot signal (a hop re-points the slot; harnessGround's in-place
// re-ground of the blank chat emits it AFTER regroundWorkspace, so the
// snapshot read on that beat sees the NEW folder). The ground beat alone is
// a half-feed for this door: harnessGround emits it BEFORE the re-ground, so
// a consumer riding only that beat re-reads the OLD folder, and a hop never
// emits it at all. One feed for every consumer of the door — the frame's
// folder chip and the export dialog's shown path ride it together.
//
// This is the SESSION-workspace read. Chrome whose truth is the screen's
// own ground (the blank chat's ground) rides useCwdState instead.

import { useSyncExternalStore } from 'react'
import { subscribeCwdState } from '../bootstrap/state.js'
import {
  getFocusedSessionConnector,
  subscribeFocusedSessionConnector,
} from '../services/engine-connector/focusedConnector.js'

/** Both beats, one subscription — module-stable, so useSyncExternalStore
 *  never re-subscribes on render. */
export function subscribeFocusedWorkspace(listener: () => void): () => void {
  const offGround = subscribeCwdState(listener)
  const offSlot = subscribeFocusedSessionConnector(listener)
  return () => {
    offGround()
    offSlot()
  }
}

/** The door itself — also the call-time read for a write that must land
 *  where the shown path says. */
export function getFocusedWorkspaceCwd(): string {
  return getFocusedSessionConnector().workspace().cwd
}

export function useFocusedWorkspaceCwd(): string {
  return useSyncExternalStore(subscribeFocusedWorkspace, getFocusedWorkspaceCwd, getFocusedWorkspaceCwd)
}
