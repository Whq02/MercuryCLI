// contextUsageLive — the render-published context-fill seam, OWNER-ADDRESSED
// since the Sol 5.6 frontier sprint.
//
// MercuryFrame legitimately has `messages` and computes the fill every
// render for its own ctx gauge; it publishes the resulting slot here, and
// DeckPane/HelmTelemetryRail/HelmLanesRail read the latest WITHOUT threading
// `messages` through the layout tree. A publish that changes a slot bumps a
// version the rails subscribe to, so a window landing from a catalogue (or a
// usage arriving) repaints them without waiting on their own tick.
//
// OWNER MODEL: each conversation owner has its own slot in a bounded
// OwnerScopedStore — conversation B's publish can never clobber conversation
// A's gauge. Callers that predate owner threading omit the owner and get the
// process MAIN owner (the single-conversation REPL behavior, unchanged).
//
// Honest: the value is the frame's real computation (the same contextFill
// the compaction trigger reads), not a fake. Null until the frame has
// rendered once — a fresh owner reads null, so DeckPane omits the ctx row
// (matches the contextGauge 'unavailable' contract). The slot also carries
// WHERE each number came from: `fillSource` 'estimate' when no wire usage
// exists yet (the rails paint ≈), and `windowSource` 'fallback' when the
// window is the labelled conservative default rather than a stated one (the
// rails paint ~).

import { fluxMark } from '../flux/fluxProbe.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { registerOwnerScopedStore } from '../../services/run/ownerLifecycle.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import type { ContextResolution } from '../model/capabilities.js'
import { ctxForecastEnabled, recordCtxSample } from './ctxForecast.js'

export type ContextFillSource = 'usage' | 'estimate'
export type ContextWindowSource = ContextResolution['source']

export interface LiveContextUsage {
  usedPct: number | null
  window: number
  compactAtPct: number | null
  /** The token figure behind usedPct (the compaction trigger's own count). */
  usedTokens: number | null
  fillSource: ContextFillSource | null
  windowSource: ContextWindowSource | null
}

export interface ContextUsageDetail {
  usedTokens?: number | null
  fillSource?: ContextFillSource | null
  windowSource?: ContextWindowSource | null
}

const usageSlots = new OwnerScopedStore<LiveContextUsage>({
  name: 'ctx-usage-live',
  create: () => ({
    usedPct: null,
    window: 0,
    compactAtPct: null,
    usedTokens: null,
    fillSource: null,
    windowSource: null,
  }),
})
registerOwnerScopedStore(usageSlots)

let version = 0
const listeners = new Set<() => void>()

/** Publish the live context fill (called by MercuryFrame, which has `messages`).
 *  `compactAtPct` is the autocompact threshold as a percent of the SAME window
 *  (null when autocompact is off/unknown) — the P7 ctx-forecast cue's target.
 *  `detail` carries the token figure and the two provenance words. */
export function publishContextUsage(
  usedPct: number | null,
  window: number,
  compactAtPct: number | null = null,
  owner?: OwnerKey,
  detail?: ContextUsageDetail,
): void {
  const key = owner ?? processMainOwner()
  const slot = usageSlots.get(key)
  const next: LiveContextUsage = {
    usedPct,
    window,
    compactAtPct,
    usedTokens: detail?.usedTokens ?? null,
    fillSource: detail?.fillSource ?? null,
    windowSource: detail?.windowSource ?? null,
  }
  const changed =
    slot.usedPct !== next.usedPct ||
    slot.window !== next.window ||
    slot.compactAtPct !== next.compactAtPct ||
    slot.usedTokens !== next.usedTokens ||
    slot.fillSource !== next.fillSource ||
    slot.windowSource !== next.windowSource
  Object.assign(slot, next)
  // P7 ctx-forecast sampling piggybacks here (no new producer); flag-inert OFF.
  if (ctxForecastEnabled()) recordCtxSample(usedPct, key)
  if (changed) {
    version += 1
    fluxMark('ctxusage:publish') // probe-gated ring stamp (off ⇒ no-op)
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // One rail's failure never blocks the others' repaint.
      }
    }
  }
}

/** Read the latest published context fill (DeckPane, on its refresh tick). */
export function getLiveContextUsage(owner?: OwnerKey): LiveContextUsage {
  const slot = usageSlots.peek(owner ?? processMainOwner())
  if (!slot) {
    return {
      usedPct: null,
      window: 0,
      compactAtPct: null,
      usedTokens: null,
      fillSource: null,
      windowSource: null,
    }
  }
  return { ...slot }
}

/** Monotonic publish version — the useSyncExternalStore snapshot for a rail
 *  that must repaint the instant the published fill changes. */
export function getLiveContextUsageVersion(): number {
  return version
}

export function subscribeLiveContextUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
