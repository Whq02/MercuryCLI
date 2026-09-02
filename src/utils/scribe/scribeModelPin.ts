// ============================================================================
//  Scribe model+effort pin — the pure decision core for the carousel's scribe
//  station. Scribe Mode "Amanuensis" is a COUPLED model+effort-pinned mode:
//  unlike supercode (which pins effort only), entering the scribe station pins
//  BOTH the foreground session model (claude-fable-5[1m], env-swappable) AND effort
//  (xhigh — the refining FRONT; max's payoff is the Implementer's), and restores
//  the operator's prior model+effort on leave.
//
//  This module is pure + side-effect-free so it's unit-testable under `bun run`
//  (PromptInput.tsx is not loadable there). The PromptInput wiring stashes the
//  current model+effort on engage, applies the pin, and on disengage consults
//  decideScribeRestore() to restore — but only if the operator hasn't manually
//  switched off the pinned model in the meantime (don't clobber a newer choice).
// ============================================================================
import type { EffortValue } from '../effort.js'
import { modelSupportsXHighEffort } from '../effort.js'
import { resolveScribeSeat, resolveScribeSeatModel } from '../model/seatSlots.js'
import { focusedOptionSupports1m } from '../model/modelOptions.js'

/** The model the Scribe foreground session is pinned to while scribe mode is on.
 *  Default `claude-fable-5[1m]` (D-02a two-tier repin, superseding the
 *  both-agents-opus-4-8 decision);
 *  slot-swappable — MERCURY_SCRIBE_MODEL > the persisted operator slot > the pin
 * VALIDATED
 *  through the seat-slot machinery since router-party P1: a Haiku/off-list/junk
 *  override fails CLOSED down the ladder (the resolver note carries the reason).
 *  LIVE read since: the persisted tier can change under a
 *  running process (a picker reslot), so the pin resolves per call — the old
 *  load-time const would have frozen the boot-time slot for the whole session. */
export function scribeSeatModel(): string {
  return resolveScribeSeatModel().model
}

/** The effort the Scribe (the refining FRONT) is pinned to — the persisted
 *  operator slot > the xhigh pin (no env tier exists for scribe effort). The
 *  Scribe routes + refines rather than writing deep code, so xhigh is the
 *  ratified default — max effort's payoff is reserved for the Implementer (the
 *  executor), per the effort-payoff doctrine. */
export function scribeSeatEffort(): EffortValue {
  return resolveScribeSeat().effort
}

/**
 * Session-scoped 1M-context preference for the Scribe pin (the /model picker's `c`
 * toggle on the "two-stream router" option):
 *   undefined → use SCRIBE_MODEL as-is (the default — claude-fable-5[1m], i.e. 1M)
 *   true      → force the [1m] (1M) variant
 *   false     → force the 200k variant (strip [1m])
 * Set BEFORE engage from the picker's choice; cleared (→ undefined) AFTER disengage
 * so modelIsScribePin still matches the pinned variant during restore.
 */
let scribeContext1mPref: boolean | undefined = undefined

/** Set the session 1M-context preference (see scribeContext1mPref). */
export function setScribeContext1mPref(use1m: boolean | undefined): void {
  scribeContext1mPref = use1m
}

/**
 * The effective Scribe model after the 1M-context preference is applied — the
 * single source of truth for "what the pin is right now". Every decision below
 * routes through it so the pin-match (modelIsScribePin) and restore stay coherent
 * when the operator picks the 200k variant. Default (pref undefined) ⇒ SCRIBE_MODEL.
 */
export function resolvedScribeModel(): string {
  const pinned = scribeSeatModel()
  if (scribeContext1mPref === undefined) return pinned
  const base = pinned.replace(/\[1m\]$/i, '')
  // FAMILY-AWARE: the [1m] suffix is a Claude
  // VARIANT mechanism — appending it to a base with no 1M variant (a
  // gpt/glm-slotted scribe seat) minted an id that exists nowhere
  // (gpt-5.6-sol[1m]), which failed scribePinIsApplicable() and made the
  // foreground pin SILENTLY skip on engage (the session kept its old model
  // while the receipt announced the router). The pref applies only where the
  // picker's own gate says a 1M variant exists; otherwise the bare seat id
  // stands — and the pin engages.
  if (!focusedOptionSupports1m(base)) return base
  return scribeContext1mPref ? `${base}[1m]` : base
}

/**
 * A model setting as carried in AppState.mainLoopModelForSession: a model id
 * string, or null/undefined when there is no per-session override.
 */
export type ScribeModelSetting = string | null | undefined

/** Snapshot of the foreground model+effort, stashed on engage for later restore. */
export type ScribePinSnapshot = {
  model: ScribeModelSetting
  effort: EffortValue | undefined
}

/**
 * Should the scribe pin actually engage? The pin is meaningful only when the
 * pinned model supports the pinned effort (so 'max' resolves to 'max' rather
 * than being clamped to 'high' by resolveAppliedEffort). For SCRIBE_MODEL this
 * is true; the guard keeps the helper honest if the constants ever change.
 */
export function scribePinIsApplicable(): boolean {
  return modelSupportsXHighEffort(resolvedScribeModel())
}

/**
 * Decide the model+effort to apply on scribe ENGAGE. Returns the pinned pair
 * when applicable; otherwise null (caller leaves the session untouched — the
 * persona pack + hook still engage, just no model switch). Pure.
 */
export function decideScribeEngage(): ScribePinSnapshot | null {
  if (!scribePinIsApplicable()) return null
  return { model: resolvedScribeModel(), effort: scribeSeatEffort() }
}

/**
 * Decide what to restore on scribe DISENGAGE, given the snapshot captured at
 * engage and the CURRENT foreground model.
 *
 * Edge case (operator changed model while in scribe mode): if the foreground
 * model is not the pinned SCRIBE_MODEL, the operator deliberately moved
 * off it — restoring the stash would clobber their newer choice. In that case
 * return null (caller leaves model+effort as-is). Only when the foreground is
 * still the pinned model do we restore the stashed pair.
 *
 * `snapshot` null (engage didn't pin — e.g. not applicable) ⇒ null (nothing to
 * restore). Pure.
 */
export function decideScribeRestore(
  snapshot: ScribePinSnapshot | null,
  currentModel: ScribeModelSetting,
  currentEffort?: EffortValue | undefined,
): ScribePinSnapshot | null {
  if (snapshot === null) return null
  if (!modelIsScribePin(currentModel)) return null
  // Mirror the model-axis guard onto the EFFORT axis: if the operator manually
  // changed /effort while still on the pinned model, that newer choice is theirs
  // — restore the stashed model but keep their live effort (don't clobber it).
  if (currentEffort !== undefined && currentEffort !== scribeSeatEffort()) {
    return { model: snapshot.model, effort: currentEffort }
  }
  return snapshot
}

/** Is the given model setting the pinned Scribe model? (exact-id match against the
 *  RESOLVED pin, so it tracks the 1M-context preference). */
export function modelIsScribePin(model: ScribeModelSetting): boolean {
  return model === resolvedScribeModel()
}

/**
 * The UNIFIED, idempotent engage decision used by EVERY scribe-engage path
 * (the /model "two-stream router" selection, a MERCURY_SCRIBE=1 launch's mount
 * effect, and the headless -p resolution) — so a launched Scribe is reliably
 * on its pinned pair, not just one path. Given the CURRENT foreground {model, effort}, returns:
 *   - `next`     : the pinned pair to write (SCRIBE_MODEL @ SCRIBE_EFFORT), and
 *   - `snapshot` : the current pair to stash for restore-on-disengage.
 *
 * Returns null (NO write, NO re-stash) when:
 *   - the pin isn't applicable (constants drifted off a max-capable model), or
 *   - the session is ALREADY on the scribe pin — making the decision idempotent:
 *     a StrictMode double-invoke, a re-render, or a second engage is a no-op and
 *     can never clobber the stashed restore target with the pin itself.
 *
 * Pure + side-effect-free (no AppState, no React) so it's unit-testable under
 * `bun run`; the imperative write/stash lives in engageScribeSession.ts.
 */
export function decideScribeSessionModel(
  current: ScribePinSnapshot,
): { next: ScribePinSnapshot; snapshot: ScribePinSnapshot } | null {
  if (!scribePinIsApplicable()) return null
  // Idempotent ONLY when BOTH axes already match the pin. If the model is the pin
  // but the effort is NOT the pinned effort (e.g. the operator left the foreground on
  // the pinned model at high, or a 3P provider that stores the literal id), we must
  // STILL pin effort to the scribe-seat effort — the documented "pinned effort on
  // every engage path" (scribe-audit #1). Stash the prior effort so disengage restores it.
  if (modelIsScribePin(current.model) && current.effort === scribeSeatEffort()) return null
  return {
    next: { model: resolvedScribeModel(), effort: scribeSeatEffort() },
    snapshot: { model: current.model, effort: current.effort },
  }
}
