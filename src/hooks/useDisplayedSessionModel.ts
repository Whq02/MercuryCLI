import { useMemo, useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { renderModelChip } from '../utils/model/model.js'
import { resolveSeatSlot } from '../utils/model/seatSlots.js'
import {
  getScribeModeVersion,
  isScribeModeOn,
  subscribeScribeMode,
} from '../utils/scribeMode.js'

// ============================================================================
//  useDisplayedSessionModel — the ONE scribe-aware model label for display
//  surfaces (operator bug: with the two-stream router engaged the
//  boot card and sessions strip kept the stale mainLoopModel — "Opus 5" —
//  while the foreground actually ran the scribe seat).
//
//  Engaging scribe deliberately does NOT write mainLoopModel (the sentinel is
//  a picker ACTION — scribeRouterSelect), so any surface rendering
//  renderModelName(useMainLoopModel()) shows the pre-engage model for the
//  whole engagement. Display surfaces render THIS hook instead; the wire and
//  functional consumers (context-window math, effort vocabulary, API calls)
//  keep reading useMainLoopModel/the seat resolvers directly.
//
//  Labels follow the /model picker's own vocabulary (live seat truth, never a
//  pinned label — the display law): the full form names both streams,
//  the compact form names what the FOREGROUND runs (the strip already carries
//  its own scribe dot).
// ============================================================================

export type DisplayedSessionModel = {
  /** True while the Scribe two-stream router owns the foreground session. */
  scribeRouter: boolean
  /** Full label — boot card / deck header: both streams when engaged. */
  label: string
  /** Compact chip — strips/rails: the foreground (scribe) stream when engaged. */
  compact: string
  /** The queued switch's display label, null when no
   *  switch is parked. When set, `compact`/`label` already carry the
   *  `current → next` projection — this field is for surfaces that want the
   *  structured fact (e.g. a dedicated pending chip). */
  pendingNext: string | null
}

/**
 * The pure resolver (React-free, prover-testable): derive the display labels
 * from the live scribe engagement + seat slots, else the given main model.
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
  const queued = (base: string): string =>
    pendingNext === null ? base : `${base} → ${pendingNext}`
  const queuedLabel = (base: string): string =>
    pendingNext === null ? base : `${base} → ${pendingNext} (queued)`
  // Scribe-engaged queued grammar: the duo label already uses `→` for the
  // scribe→implementer CHAIN, so appending the plain `→ next (queued)` form
  // minted a three-arrow chain that read as an implementer retarget
  // ("Scribe router — A → B → C (queued)"). The queued switch names itself
  // instead — it belongs to the FOREGROUND stream, never the implementer.
  const queuedScribe = (base: string): string =>
    pendingNext === null ? base : `${base} · queued switch → ${pendingNext}`
  if (!isScribeModeOn()) {
    const name = renderModelChip(mainModel)
    return {
      scribeRouter: false,
      label: queuedLabel(name),
      compact: queued(name),
      pendingNext,
    }
  }
  const applied = renderModelChip(mainModel)
  const scribe = renderModelChip(resolveSeatSlot('scribe').model)
  const implementer = renderModelChip(resolveSeatSlot('implementer').model)
  // Wire truth outranks seat intent: the engage-time foreground pin can
  // legitimately skip (scribeModelPin applicability — e.g. a GPT seat with
  // engines cold), and then the wire still runs the un-pinned model. Display
  // must never claim a model the wire isn't running — show the APPLIED model
  // and mark the seat intent visibly instead.
  if (applied !== scribe) {
    return {
      scribeRouter: true,
      label: queuedScribe(`Scribe router — ${applied} (seat ${scribe} not applied) → ${implementer}`),
      compact: queuedScribe(`Scribe · ${applied}`),
      pendingNext,
    }
  }
  return {
    scribeRouter: true,
    label: queuedScribe(`Scribe router — ${scribe} → ${implementer}`),
    compact: queuedScribe(`Scribe · ${scribe}`),
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
  // Version-counter subscription — module-state toggles are invisible to React
  // (the keybinding-gotchas class); this repaints the label on engage/exit.
  useSyncExternalStore(subscribeScribeMode, getScribeModeVersion, getScribeModeVersion)
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
