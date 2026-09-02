// ============================================================================
//  providers/huggingface/huggingfaceUsageState — the Hugging Face lane's
//  usage truth.
//
//  The documented billing model (huggingface.co/docs/inference-providers/
//  pricing, fetched): monthly credits ($0.10 free · $2 PRO · $2
//  per Team/Enterprise seat), then pay-as-you-go at the provider's own rate
//  with no markup; spend is viewed on huggingface.co/settings/billing and
//  the per-model breakdown on /settings/inference-providers/overview. NO
//  spend, credit or balance API is documented — this lane's honest usage
//  shape is the session ledger plus that absence, never a fabricated meter.
//
//  What the wire does state is folded here: a reached limit arrives as a
//  Retry-After and/or the IETF draft RateLimit headers the Hub answers with
//  (`ratelimit: "<policy>";r=<remaining>;t=<seconds-to-reset>` beside
//  `ratelimit-policy`, observed live on huggingface.co 2026-08-22; the
//  router's own limit headers are on the deferred-live list). Facts exist
//  here only when a response stated them (absent ≠ zero), stamped at
//  observation. ONE owner: the settings Usage tab, the telemetry rail and
//  any dispatch-side throttle read THESE records.
// ============================================================================

export const HUGGINGFACE_USAGE_ABSENCE_NOTE =
  'no spend or credit API is documented for Inference Providers — huggingface.co/settings/billing is the view (monthly credits apply first, then pay-as-you-go at provider rates, no markup)'

export type HuggingfaceLimitWindow =
  | { state: 'limited'; resetsAtMs: number; observedAtMs: number; remaining?: number }
  | { state: 'clear' }

let observedLimit: { resetsAtMs: number; observedAtMs: number; remaining?: number } | null = null
/** The last RateLimit header facts seen on ANY response (remaining + reset),
 *  even when the limit is not reached — the honest "how much is left" fact. */
let observedRate: { remaining: number; resetsAtMs?: number; observedAtMs: number } | null = null

/** Parse the draft RateLimit header value: `"<name>";r=<remaining>;t=<secs>`
 *  (multiple policies separate with commas — the FIRST reached/lowest
 *  remaining wins). Undefined when the header is absent or unparsable. */
export function parseRateLimitHeader(value: string | null): { remaining: number; resetSec?: number } | undefined {
  if (!value) return undefined
  let best: { remaining: number; resetSec?: number } | undefined
  for (const part of value.split(',')) {
    const r = /(?:^|;)\s*r=(\d+)/.exec(part)
    if (!r) continue
    const t = /(?:^|;)\s*t=(\d+)/.exec(part)
    const candidate = { remaining: Number(r[1]), ...(t ? { resetSec: Number(t[1]) } : {}) }
    if (!best || candidate.remaining < best.remaining) best = candidate
  }
  return best
}

/**
 * Fold ONE response's limit facts. Retry-After is RFC seconds-from-now;
 * the draft RateLimit header states remaining + seconds-to-reset; an
 * x-ratelimit-reset epoch (ms or s) is honoured when it parses — an
 * ambiguous value records nothing rather than a fabricated window. A 429
 * status with no usable header still marks the lane limited for a short
 * fixed window so the next dispatch does not burn a request. Never throws.
 */
export function recordHuggingfaceRateHeaders(
  headers: Headers | undefined,
  status?: number,
  now: () => number = Date.now,
): void {
  if (!headers || typeof headers.get !== 'function') return
  try {
    const rate = parseRateLimitHeader(headers.get('ratelimit'))
    if (rate) {
      observedRate = {
        remaining: rate.remaining,
        ...(rate.resetSec !== undefined ? { resetsAtMs: now() + rate.resetSec * 1000 } : {}),
        observedAtMs: now(),
      }
    }
    const retryAfter = Number(headers.get('retry-after') ?? '')
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      observedLimit = { resetsAtMs: now() + retryAfter * 1000, observedAtMs: now(), ...(rate ? { remaining: rate.remaining } : {}) }
      return
    }
    if (rate && rate.remaining === 0 && rate.resetSec !== undefined) {
      observedLimit = { resetsAtMs: now() + rate.resetSec * 1000, observedAtMs: now(), remaining: 0 }
      return
    }
    const reset = Number(headers.get('x-ratelimit-reset') ?? '')
    if (Number.isFinite(reset) && reset > 0 && (status === 429 || rate?.remaining === 0)) {
      if (reset > 1e12) observedLimit = { resetsAtMs: reset, observedAtMs: now() }
      else if (reset > 1e9) observedLimit = { resetsAtMs: reset * 1000, observedAtMs: now() }
      return
    }
    if (status === 429) {
      observedLimit = { resetsAtMs: now() + 30_000, observedAtMs: now() }
    }
  } catch {
    /* usage observation must never fail a request */
  }
}

/** The current window: 'limited' only while the observed reset is ahead. */
export function huggingfaceLimitWindow(now: () => number = Date.now): HuggingfaceLimitWindow {
  if (observedLimit === null || observedLimit.resetsAtMs <= now()) return { state: 'clear' }
  return {
    state: 'limited',
    resetsAtMs: observedLimit.resetsAtMs,
    observedAtMs: observedLimit.observedAtMs,
    ...(observedLimit.remaining !== undefined ? { remaining: observedLimit.remaining } : {}),
  }
}

/** The last RateLimit facts a response stated (null = none stated yet). */
export function huggingfaceObservedRate(): { remaining: number; resetsAtMs?: number; observedAtMs: number } | null {
  return observedRate
}

/** The raw wall record last stated, elapsed or not (null = none observed)
 *  — the failover return law's "observed reset" read. */
export function huggingfaceObservedWall(): { resetsAtMs: number; observedAtMs: number } | null {
  return observedLimit === null ? null : { resetsAtMs: observedLimit.resetsAtMs, observedAtMs: observedLimit.observedAtMs }
}

/** The credential behind the lane left or changed: every observation made
 *  under it goes with it — the wall, the rate facts, the billing refusal
 *  (the records are process-wide, not per credential). */
export function forgetHuggingfaceObservedLimits(): void {
  observedLimit = null
  observedRate = null
  observedBilling = null
}

// ── The observed billing refusal (no credit API exists — the wire's own
//    402 is the ONE knowable fact; a later successful response clears it) ──

export type HuggingfaceBillingState =
  | { state: 'credit-exhausted'; observedAtMs: number }
  | { state: 'clear' }

let observedBilling: { observedAtMs: number } | null = null

/** Fold a response status into the billing observation: 402 marks the
 *  Inference-Providers credits exhausted; any 2xx clears it (the account
 *  was topped up or the credits cycled — the wire said so). Never throws. */
export function recordHuggingfaceBillingStatus(status: number | undefined, now: () => number = Date.now): void {
  if (status === undefined) return
  if (status === 402) observedBilling = { observedAtMs: now() }
  else if (status >= 200 && status < 300) observedBilling = null
}

/** The current billing observation ('clear' = no refusal observed, which is
 *  absence of evidence, never a balance claim). */
export function huggingfaceBillingState(): HuggingfaceBillingState {
  return observedBilling === null
    ? { state: 'clear' }
    : { state: 'credit-exhausted', observedAtMs: observedBilling.observedAtMs }
}

/** Proof seam. */
export function __resetHuggingfaceUsageStateForTest(): void {
  observedLimit = null
  observedRate = null
  observedBilling = null
}
