// ============================================================================
//  MercurySessionProfile — ONE coherent, typed snapshot of how this session
//  operates: who the agent is (the invariant Mercury behavior doctrine) and
//  how it looks (the appearance snapshot).
// ----------------------------------------------------------------------------
//  This is a COMPOSITION layer, not a new state owner. Durable preferences
//  stay with their owners (config for theme/accent); live session state stays
//  in AppState; this module exposes pure resolvers all surfaces share so the
//  rail, doctor, and teammate spawns can never tell different stories about
//  the same session.
//
//  COMPOSITION ORDER (the prompt contract, tested end to end):
//    1. Mercury base identity + behavior doctrine   (composer static head +
//       wrapper/identity floor — src/prompt/composer.ts owns the sequence)
//    2. Operator and repository instructions        (dynamic registry: memory,
//       project-instruction (MERCURY.md) context, env)
//    3. Role/runtime mode packs, when engaged        (mode packs — composed
//       AFTER the wrapper, never replacing identity)
//    4. Agent-role contract                         (teammate addendum + the
//       resolved role definition — swarm/inProcessRunner)
//    5. Team charter + individual assignment        (the role packet)
//    6. The current task message                    (the conversation)
//  A role narrows responsibilities; it must not erase operator intent.
// ============================================================================

import type { MercuryAppearanceSnapshot } from './appearanceSnapshot.js'
import type { HarnessProfileResolution } from '../../services/mission/harnessProfiles.js'

/**
 * The invariant Mercury behavior doctrine — the part of the profile that no
 * mode, role, or theme may replace. Constant by design: surfaces embed it so
 * "what kind of agent is this" has exactly one machine-readable answer.
 */
export type MercuryBehaviorProfile = {
  productName: 'Mercury'
  /** Loyal to the operator's intended OUTCOME — candid about evidence, not
   *  agreeable about claims. */
  outcomeLoyalty: 'candid-completion'
  /** Stays inside the asked scope; scope changes are surfaced, not assumed. */
  scopeFidelity: true
  /** Speaks the operator's working register — direct, peer-toned. */
  communicationRegister: 'operator-native'
  /** Finishes, or names the one real blocker with the clearing action. */
  completionPolicy: 'finish-or-name-real-blocker'
}

export const MERCURY_BEHAVIOR_PROFILE: MercuryBehaviorProfile = Object.freeze({
  productName: 'Mercury',
  outcomeLoyalty: 'candid-completion',
  scopeFidelity: true,
  communicationRegister: 'operator-native',
  completionPolicy: 'finish-or-name-real-blocker',
})

/** The full session profile a turn or a teammate spawn captures. */
export type MercurySessionProfile = {
  identity: MercuryBehaviorProfile
  appearance: MercuryAppearanceSnapshot
  /** The resolved harness-profile snapshot (additive component) —
   *  present only while MERCURY_HARNESS_PROFILE is armed.
   *  Observability/receipt surface ONLY: never serialized into prompt bytes
   *  (the identity floor above stays the invariant the harness system may
   *  never touch). */
  harness?: HarnessProfileResolution
  changedAt: number
}

/** Compose the session profile from its live halves. Pure + frozen. The
 *  harness component is additive: one-argument callers compose exactly the
 *  harness-less profile. */
export function resolveMercurySessionProfile(
  appearance: MercuryAppearanceSnapshot,
  harness?: HarnessProfileResolution | null,
): MercurySessionProfile {
  return Object.freeze({
    identity: MERCURY_BEHAVIOR_PROFILE,
    appearance,
    ...(harness ? { harness } : {}),
    changedAt: appearance.changedAt,
  })
}
