// ============================================================================
//  cockpitActivity — what the session is DOING, as one subscribable value
//
//
//  Adaptive density needs an answer the whole cockpit agrees on: is the
//  operator watching work run, being asked for a decision, reviewing a result,
//  or sitting calm? Only the REPL can see all four (the tool-confirm queue,
//  the loading flag, the open review surface), and threading that through the
//  rails, the frame and the layout would have meant four props and four
//  chances to drift. So the REPL PUBLISHES it once and consumers subscribe —
//  the helmFocus idiom, `useSyncExternalStore` over a module signal, no
//  polling and no context re-render storm.
//
//  Deliberately four states and no detail: density is a presentation
//  decision, and a richer payload here would invite surfaces to re-derive
//  policy instead of consuming the plan (helmDensity.ts owns that).
// ============================================================================

import { useSyncExternalStore } from 'react'
import { fluxMark } from '../flux/fluxProbe.js'

export type ActivityState =
  /** Idle — nothing running, nothing asked. Room for glanceables. */
  | 'calm'
  /** A turn is in flight. The work and its next action are the subject. */
  | 'active'
  /** A decision is pending on the operator. It outranks everything. */
  | 'waiting'
  /** A review surface is open. Changed files and checks are the subject. */
  | 'review'

let state: ActivityState = 'calm'
const listeners = new Set<() => void>()

/** The REPL's one publication point. Idempotent: an unchanged value notifies
 *  nobody, so a re-render storm cannot become a repaint storm. */
export function publishCockpitActivity(next: ActivityState): void {
  if (next === state) return
  state = next
  fluxMark(`activity:${next}`) // probe-gated ring stamp (off ⇒ no-op)
  for (const listener of listeners) listener()
}

export function getCockpitActivity(): ActivityState {
  return state
}

export function subscribeCockpitActivity(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

/** Reactive read for any cockpit surface. */
export function useCockpitActivity(): ActivityState {
  return useSyncExternalStore(
    subscribeCockpitActivity,
    getCockpitActivity,
    getCockpitActivity,
  )
}

/** Test/proof seam. */
export function resetCockpitActivityForTests(): void {
  state = 'calm'
  listeners.clear()
}
