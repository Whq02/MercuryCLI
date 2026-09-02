import { useMemo, useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { renderModelChip } from '../utils/model/model.js'

// ============================================================================
//  useDisplayedSessionModel — the ONE model label for display surfaces (the
//  boot card, the sessions strip, the frame statusline, the deck vitals).
//
//  Labels follow the /model picker's own vocabulary (live truth, never a
//  pinned label — the display law). The wire and functional consumers
//  (context-window math, effort vocabulary, API calls) keep reading
//  useMainLoopModel directly.
// ============================================================================

export type DisplayedSessionModel = {
  /** Full label — boot card / deck header. */
  label: string
  /** Compact chip — strips/rails. */
  compact: string
  /** The queued switch's display label, null when no
   *  switch is parked. When set, `compact`/`label` already carry the
   *  `current → next` projection — this field is for surfaces that want the
   *  structured fact (e.g. a dedicated pending chip). */
  pendingNext: string | null
}

/**
 * The pure resolver (React-free, prover-testable): derive the display labels
 * from the given main model.
 *
 * a parked pending switch (AppState.pendingModelSwitch — the ONE
 * non-persisted slot) projects into BOTH label forms as `current → next` so
 * every consumer of this owner (frame statusline, deck vitals, boot card,
 * monitor) shows the queued transition and clears it on settlement — the
 * truth must not live only inside the /model picker while it is open.
 */
export function resolveDisplayedSessionModel(
  mainModel: string,
  pendingSwitch?: { setting: string | null } | null,
): DisplayedSessionModel {
  const pendingNext =
    pendingSwitch === undefined || pendingSwitch === null
      ? null
      : pendingSwitch.setting === null
        ? 'Default'
        : renderModelChip(pendingSwitch.setting)
  const name = renderModelChip(mainModel)
  return {
    label: pendingNext === null ? name : `${name} → ${pendingNext} (queued)`,
    compact: pendingNext === null ? name : `${name} → ${pendingNext}`,
    pendingNext,
  }
}

// The focused chat's model facts as PRIMITIVE snapshots (a fresh object per
// read would churn useSyncExternalStore's stability comparison).
const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedMainModel = (): string => getFocusedSessionConnector().modelFacts().main
const getFocusedPendingParked = (): boolean => getFocusedSessionConnector().modelFacts().pendingSwitch !== null
const getFocusedPendingSetting = (): string | null =>
  getFocusedSessionConnector().modelFacts().pendingSwitch?.setting ?? null

export function useDisplayedSessionModel(): DisplayedSessionModel {
  const mainModel = useSyncExternalStore(subscribeFocusedModel, getFocusedMainModel, getFocusedMainModel)
  // The ONE pending slot, subscribed so the projection appears when a
  // switch queues and clears exactly when settlement nulls it.
  const pendingParked = useSyncExternalStore(subscribeFocusedModel, getFocusedPendingParked, getFocusedPendingParked)
  const pendingSetting = useSyncExternalStore(subscribeFocusedModel, getFocusedPendingSetting, getFocusedPendingSetting)
  const pendingSwitch = useMemo(
    () => (pendingParked ? { setting: pendingSetting } : null),
    [pendingParked, pendingSetting],
  )
  return resolveDisplayedSessionModel(mainModel, pendingSwitch)
}
