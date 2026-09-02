
export const HUGGINGFACE_USAGE_ABSENCE_NOTE =
  'no spend or credit API is documented for Inference Providers — huggingface.co/settings/billing is the view (monthly credits apply first, then pay-as-you-go at provider rates, no markup)'

export type HuggingfaceLimitWindow =
  | { state: 'limited'; resetsAtMs: number; observedAtMs: number; remaining?: number }
  | { state: 'clear' }

let observedLimit: { resetsAtMs: number; observedAtMs: number; remaining?: number } | null = null
let observedRate: { remaining: number; resetsAtMs?: number; observedAtMs: number } | null = null

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
  }
}

export function huggingfaceLimitWindow(now: () => number = Date.now): HuggingfaceLimitWindow {
  if (observedLimit === null || observedLimit.resetsAtMs <= now()) return { state: 'clear' }
  return {
    state: 'limited',
    resetsAtMs: observedLimit.resetsAtMs,
    observedAtMs: observedLimit.observedAtMs,
    ...(observedLimit.remaining !== undefined ? { remaining: observedLimit.remaining } : {}),
  }
}

export function huggingfaceObservedRate(): { remaining: number; resetsAtMs?: number; observedAtMs: number } | null {
  return observedRate
}

export function huggingfaceObservedWall(): { resetsAtMs: number; observedAtMs: number } | null {
  return observedLimit === null ? null : { resetsAtMs: observedLimit.resetsAtMs, observedAtMs: observedLimit.observedAtMs }
}

export function forgetHuggingfaceObservedLimits(): void {
  observedLimit = null
  observedRate = null
  observedBilling = null
}


export type HuggingfaceBillingState =
  | { state: 'credit-exhausted'; observedAtMs: number }
  | { state: 'clear' }

let observedBilling: { observedAtMs: number } | null = null

export function recordHuggingfaceBillingStatus(status: number | undefined, now: () => number = Date.now): void {
  if (status === undefined) return
  if (status === 402) observedBilling = { observedAtMs: now() }
  else if (status >= 200 && status < 300) observedBilling = null
}

export function huggingfaceBillingState(): HuggingfaceBillingState {
  return observedBilling === null
    ? { state: 'clear' }
    : { state: 'credit-exhausted', observedAtMs: observedBilling.observedAtMs }
}

export function __resetHuggingfaceUsageStateForTest(): void {
  observedLimit = null
  observedRate = null
  observedBilling = null
}
