// ============================================================================
//  alternateScrollPolicy —.6.3: the ONE
//  documented deterministic mouse-off alternate-scroll policy.
//
// THE AMBIGUITY (source-confirmed, supplement): with the alt screen
//  active, mouse tracking OFF (the /mouse-off native-copy state) and DECSET
//  1007 armed, the terminal reports each wheel notch as a plain Up/Down
//  arrow — byte-identical to a physical key press. No parser can tell them
//  apart from bytes, and the retired heuristic (≥2 identical arrows in one
//  parsed batch ⇒ wheel) made MEANING depend on PTY chunking: three notches
//  delivered as three single-arrow reads walked prompt history, the same
//  three coalesced scrolled the transcript.
//
//  THE POLICY — scroll-first in the native-selection state:
//    while (alt screen active) ∧ (mouse tracking off) ∧ (no elevated surface
//    is registered), EVERY plain unmodified Up/Down resolves to wheel
//    semantics — one or many, split or coalesced, pure per-item mapping.
//    Prompt history in that state rides the PORTABLE route (ctrl+p / ctrl+n,
//    plus ctrl+r history search); an open modal/picker (elevated-surface
//    registration — the LUSTRE oracle) keeps arrows as arrows for list
//    navigation; every other state is untouched.
//
// Why scroll-first (the two honest policies, supplement): the operator
//  entered /mouse-off deliberately to select text natively — the wheel is
//  the live instrument there, and DECSET 1007's own contract says these
//  arrows ARE wheel notches. History-first would kill the deliberate
//  wheel-scroll feature and make every notch walk history. What the policy
//  NEVER does: infer intent from arrival timing or batch size (correction
//  #3 — no clock, no count).
//
//  Split/coalescing invariance holds BY CONSTRUCTION: the mapping is
//  per-item and state-pure — batch size cannot change meaning.
// ============================================================================

import type { ParsedInput, ParsedKey } from '../input/input-decoder.js'

/** The documented policy identity — surfaces and proofs cite this. */
export const ALTERNATE_SCROLL_POLICY = 'scroll-first-in-native-selection' as const

export interface AlternateScrollState {
  /** The alt screen is the active buffer. */
  altScreenActive: boolean
  /** SGR mouse tracking is currently enabled (wheel arrives as mouse events). */
  mouseTrackingEnabled: boolean
  /** An elevated surface (modal/picker/command overlay) is registered —
   *  arrows belong to its list navigation, never to transcript scroll. */
  elevatedSurfaceActive: boolean
}

const isPlainArrow = (i: ParsedInput): i is ParsedKey =>
  i.kind === 'key' &&
  (i.name === 'up' || i.name === 'down') &&
  !i.ctrl &&
  !i.meta &&
  !i.shift &&
  !i.option

/**
 * Resolve one parsed batch under the policy. Pure: same items + same state ⇒
 * same actions, regardless of how the bytes were chunked into batches.
 * Mixed batches map ONLY their plain-arrow items; every other item passes
 * through untouched in order.
 */
export function resolveAlternateScrollIntent(
  items: readonly ParsedInput[],
  state: AlternateScrollState,
): ParsedInput[] {
  const engaged =
    state.altScreenActive && !state.mouseTrackingEnabled && !state.elevatedSurfaceActive
  if (!engaged) return [...items]
  return items.map(i =>
    isPlainArrow(i) ? { ...i, name: i.name === 'up' ? 'wheelup' : 'wheeldown' } : i,
  )
}
