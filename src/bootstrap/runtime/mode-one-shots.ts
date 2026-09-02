// ============================================================================
//  src/bootstrap/runtime/mode-one-shots.ts — the mode-transition one-shot
//  owner.
//
//  Scope: CONVERSATION — the plan/auto exit-attachment one-shots and their
//  transition tables (the auto↔plan skip rows are deliberate — see
//  handleAutoModeTransition), plus the per-session LSP-recommendation and
//  exited-plan-mode marks. The full transition matrix is pinned by
//  prove-state-contract LAW 4.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports nothing. src/bootstrap/
//  state.ts is the ONLY sanctioned importer; every consumer goes through the
//  frozen facade.
// ============================================================================

export class ModeOneShotOwner {
  // Strategy mode was exited at least once this session — re-entry gets the
  // "a plan already exists" guidance instead of a cold start.
  hasExitedPlanMode = false
  // Pending one-shot: the strategy-mode exit attachment should ride the next
  // turn (then clear).
  needsPlanModeExitAttachment = false
  // Pending one-shot: the flow exit attachment should ride the next turn.
  needsAutoModeExitAttachment = false
  //  (NEW-2): a mode-exit one-shot is SCOPED to the process that
  // actually entered the mode — a cold session replaying a stale persisted
  // 'strategy'/'flow' at boot must never one-shot a ghost "Exited …" reminder
  // (the field case: a fresh session told it exited strategy mode, no plan file
  // anywhere). Entry is recorded here; the plan injector additionally
  // accepts a REAL plan file as the referent (a mid-plan resume that then
  // exits legitimately announces).
  hasEnteredPlanModeThisSession = false
  hasEnteredAutoModeThisSession = false

  handlePlanModeTransition(fromMode: string, toMode: string): void {
    // Entering strategy: record the entry and cancel any pending exit
    // one-shot — a quick out-and-back-in toggle must not deliver both
    // plan_mode and plan_mode_exit in the same turn.
    if (toMode === 'strategy' && fromMode !== 'strategy') {
      this.hasEnteredPlanModeThisSession = true
      this.needsPlanModeExitAttachment = false
    }

    // Leaving strategy: arm the plan_mode_exit one-shot.
    if (fromMode === 'strategy' && toMode !== 'strategy') {
      this.needsPlanModeExitAttachment = true
    }
  }

  handleAutoModeTransition(fromMode: string, toMode: string): void {
    // flow↔strategy is owned elsewhere: prepareContextForPlanMode carries
    // flow through strategy when opted in, and ExitPlanMode restores the
    // mode on the way out. Both directions are skipped here so this owner
    // handles only DIRECT flow entries and exits.
    if (
      (fromMode === 'flow' && toMode === 'strategy') ||
      (fromMode === 'strategy' && toMode === 'flow')
    ) {
      return
    }
    const fromIsAuto = fromMode === 'flow'
    const toIsAuto = toMode === 'flow'

    // Entering flow: record the entry and cancel any pending exit one-shot —
    // a quick toggle must not deliver auto_mode and auto_mode_exit together.
    if (toIsAuto && !fromIsAuto) {
      this.hasEnteredAutoModeThisSession = true
      this.needsAutoModeExitAttachment = false
    }

    // Leaving flow: arm the auto_mode_exit one-shot — but only for a session
    // that actually ENTERED flow (NEW-2: flow has no file referent, so the
    // in-process entry mark IS the validation).
    if (fromIsAuto && !toIsAuto && this.hasEnteredAutoModeThisSession) {
      this.needsAutoModeExitAttachment = true
    }
  }
}
