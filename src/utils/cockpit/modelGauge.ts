// ============================================================================
//  modelGauge — the ONE owner of the model line: the active main-loop model,
//  its context window WITH provenance, and whether its provider is usable.
//
//  Every figure is read from its owner, never re-derived here:
//    · the label — renderModelName (the display law the frame renders);
//    · the window — resolveContextWindow (capabilities.ts, the one window
//      resolution budgeting and the outgoing request both derive from), with
//      its `source` word and the fallback reason when the window is the
//      labelled conservative default;
//    · the provider — declaredRouteOf (the routing law's honest verdict);
//    · usability — resolveProviderUsability (the credential/limit resolver
//      /accounts, /model and /health read).
//
//  LIVE: the window follows the catalogue epoch (a live catalogue fetch that
//  lands a served window re-reads through the same resolver); the model
//  itself is app state the caller passes in. Never throws: an unresolvable
//  model is an honest `unavailable`, never a crash.
// ============================================================================

import { getSdkBetas } from '../../bootstrap/state.js'
import { catalogueEpoch, subscribeCatalogueEpoch } from '../../services/providers/catalogueEpoch.js'
import {
  resolveProviderUsability,
  type ProviderId,
  type ProviderUsability,
} from '../../services/providers/providerUsability.js'
import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import { resolveContextWindow, type ContextResolution } from '../model/capabilities.js'
import { renderModelName, type ModelName } from '../model/model.js'
import { withState, type Snapshot } from './types.js'

export type ModelData = {
  /** The display label (the frame's own law). */
  name: string
  /** The raw model id the main loop runs. */
  model: string
  /** The effective context window — the served truth budgeting derives from. */
  window: number
  windowSource: ContextResolution['source']
  /** Present when the window is the labelled fallback rather than a stated one. */
  windowReason?: string
  outputReserve: number
  /** The declared family, or 'unrecognised' when no family declares the
   *  session model — painted as the honest word, never a borrowed lane. */
  provider: ProviderId | 'unrecognised'
  /** The provider's usability — null when the resolver itself failed. */
  usability: Pick<ProviderUsability, 'usable' | 'credential' | 'limit' | 'blockers'> | null
}

const EMPTY: ModelData = {
  name: 'unknown',
  model: '',
  window: 0,
  windowSource: 'fallback',
  outputReserve: 0,
  provider: 'anthropic',
  usability: null,
}

export function modelGauge(model: ModelName): Snapshot<{ data: ModelData }> {
  try {
    const resolution = resolveContextWindow(model, getSdkBetas())
    const provider = declaredRouteOf(model) ?? 'unrecognised'
    let usability: ModelData['usability'] = null
    try {
      // No usability lane exists for an id no family declares — the gauge
      // shows the honest word with no borrowed lane state.
      const u = provider === 'unrecognised' ? undefined : resolveProviderUsability()[provider]
      usability = u ? { usable: u.usable, credential: u.credential, limit: u.limit, blockers: u.blockers } : null
    } catch {
      usability = null
    }
    return {
      state: 'live',
      source: 'mainLoopModel · resolveContextWindow · providerUsability',
      data: {
        name: renderModelName(model),
        model,
        window: resolution.effectiveWindow,
        windowSource: resolution.source,
        ...(resolution.fallbackReason ? { windowReason: resolution.fallbackReason } : {}),
        outputReserve: resolution.outputReserve,
        provider,
        usability,
      },
    }
  } catch {
    return withState('unavailable', { ...EMPTY, model: String(model ?? '') }, 'model info missing')
  }
}

/** The live edge: the served window follows the catalogue epoch. */
export function subscribeModelGauge(cb: () => void): () => void {
  return subscribeCatalogueEpoch(cb)
}

/** Monotonic — bumps when a catalogue fetch settles (the useSyncExternalStore snapshot). */
export function getModelGaugeVersion(): number {
  return catalogueEpoch()
}
