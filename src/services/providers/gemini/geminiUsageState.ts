// ============================================================================
//  providers/gemini/geminiUsageState — the Gemini lane's observed usage
//  truth.
//
//  VERIFIED ABSENCE (the truth doctrine's negative finding): the Gemini API
//  (generativelanguage.googleapis.com) exposes NO usage/spend endpoint —
//  billing and quota monitoring live in the Google Cloud console
//  (ai.google.dev/gemini-api/docs/billing, checked; programmatic
//  quota reads sit on the separate cloudquotas.googleapis.com surface and a
//  project-scoped credential Mercury does not hold). The honest usage shape
//  for this lane is therefore: the session ledger + LAST-OBSERVED limit
//  facts folded from real responses — never a fabricated meter.
//
//  This module mirrors openaiLimitState's minimal observed-window record:
//  the wire fold (provider-wire lane) records 429 reset facts as they are
//  actually stated (Retry-After header seconds / a decoded RetryInfo delay).
// ============================================================================

/** The one-line absence copy usage surfaces render for this lane. */
export const GEMINI_USAGE_ABSENCE_NOTE =
  'Usage bills to your Google account; the Gemini API exposes no usage endpoint — monitor spend in the Google Cloud console.'

export type GeminiLimitWindow =
  | { state: 'limited'; resetsAtMs: number; observedAtMs: number }
  | { state: 'clear' }

let observed: { resetsAtMs: number; observedAtMs: number } | null = null

/** Record a usage-limit fault's reset fact (no-op without one — a reset-less
 *  429 carries no window to publish). */
export function recordGeminiUsageLimit(
  resetsAtMs: number | undefined,
  now: () => number = Date.now,
): void {
  if (resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) return
  observed = { resetsAtMs, observedAtMs: now() }
}

/** Fold ONE response's stated retry facts (Retry-After seconds — the RFC
 *  meaning). Absent headers change nothing. Never throws. */
export function recordGeminiRateHeaders(
  headers: Headers | undefined,
  now: () => number = Date.now,
): void {
  if (!headers || typeof headers.get !== 'function') return
  try {
    const retryAfter = Number(headers.get('retry-after') ?? '')
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      observed = { resetsAtMs: now() + retryAfter * 1000, observedAtMs: now() }
    }
  } catch {
    /* usage observation must never fail a request */
  }
}

/** The current window: 'limited' only while the observed reset is ahead. */
export function geminiLimitWindow(now: () => number = Date.now): GeminiLimitWindow {
  if (observed === null || observed.resetsAtMs <= now()) return { state: 'clear' }
  return { state: 'limited', resetsAtMs: observed.resetsAtMs, observedAtMs: observed.observedAtMs }
}

/** Proof seam. */
export function __resetGeminiUsageStateForTest(): void {
  observed = null
}
