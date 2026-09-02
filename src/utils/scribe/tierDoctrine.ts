// ============================================================================
//  tierDoctrine — the shared Sonnet-tier executor doctrine constants.
// ----------------------------------------------------------------------------
//  A PURE LEAF module (zero imports) so every consumer — the Executor seat
//  packs (the since-retired role packs) and the executor-tier branches of the Scribe/
//  Implementer packs — shares ONE source without an import cycle (the old
//  pack → model graph → pack cycle was a TDZ crash; this leaf breaks
//  it). Relocated from the retired wrapper-pack estate
// — the text is unchanged.
// ============================================================================

/** The tightened Sonnet-tier decide-threshold. */
export const SONNET_TIER_DECIDE_THRESHOLD =
  'Decide yourself only what is reversible AND inside the stated scope of the work in front of you ' +
  '(naming, local structure, test placement). Ambiguity about intent, a contradiction between the ' +
  'spec and the code you find, a missing acceptance criterion, or a cross-boundary need is an ' +
  'ESCALATE over the bus, not a guess — escalating early is correct behavior, not failure: a wrong ' +
  'guess costs the operation more than a round-trip.'

export const SONNET_TIER_NO_SCOPE_CREEP =
  'The dispatched scope is a HARD boundary. Adjacent bugs, improvements, or refactors you notice ' +
  'are REPORTED in your progress detail, never made. Do not re-derive or widen a spec your ' +
  'dispatcher pinned.'

export const SONNET_TIER_VERIFY_BEFORE_DONE =
  'Verify before every done: run the verify command the work arrived with (or the suite covering ' +
  'what you touched) and read its output — a done without its evidence phrase is not a valid done. ' +
  '"Should work" is never reportable.'
