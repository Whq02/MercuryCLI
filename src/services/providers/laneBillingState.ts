// ============================================================================
//  providers/laneBillingState — the OBSERVED billing refusal, one owner for
//  every dispatch lane.
//
//  No lane has a credit API Mercury can preflight against for every account
//  kind (OpenRouter's /key states caps, DeepSeek/Moonshot state balances, the
//  rest state nothing) — but every lane's WIRE says so when it refuses a turn
//  for billing: a 402, Z.AI's 1113, an "insufficient balance" word. That
//  refusal is the one knowable fact, and a lane that just refused for credit
//  is not usable however present its credential is — a 'ready' row over a
//  credit-dead wire is a lie. The runtimes record the refusal here at their
//  terminal-fault seam (the compat runtime for its seven lanes; the OpenAI
//  Responses and Z.AI runtimes for theirs) with the lane's own documented
//  remedy words, and clear it on the next settled turn (the account was
//  topped up, or the credits cycled — the wire said so). The usability
//  resolver reads THIS record for every lane; the Hugging Face lane keeps
//  its status-driven owner (huggingfaceUsageState) as the same law's first
//  landing. Never a balance claim: 'clear' is absence of evidence.
// ============================================================================
import type { CallModelRoute } from './idSpaces.js'

export type LaneBillingState =
  | { state: 'credit-exhausted'; observedAtMs: number; detail: string; remedy: string }
  | { state: 'clear' }

const observed = new Map<CallModelRoute, { observedAtMs: number; detail: string; remedy: string }>()

/** Record a wire-refused billing fault for a lane: the wire's own words and
 *  the lane's documented remedy (never a secret). Never throws. */
export function recordLaneBillingRefusal(
  lane: CallModelRoute,
  refusal: { detail: string; remedy: string },
  now: () => number = Date.now,
): void {
  observed.set(lane, { observedAtMs: now(), detail: refusal.detail, remedy: refusal.remedy })
}

/** A settled turn on the lane clears its refusal — the wire served. */
export function recordLaneTurnSettled(lane: CallModelRoute): void {
  observed.delete(lane)
}

/** The lane's current billing observation. */
export function laneBillingState(lane: CallModelRoute): LaneBillingState {
  const record = observed.get(lane)
  return record === undefined
    ? { state: 'clear' }
    : { state: 'credit-exhausted', observedAtMs: record.observedAtMs, detail: record.detail, remedy: record.remedy }
}

/** Proof seam. */
export function __resetLaneBillingStateForTest(): void {
  observed.clear()
}
