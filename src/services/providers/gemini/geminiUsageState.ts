
export const GEMINI_USAGE_ABSENCE_NOTE =
  'Usage bills to your Google account; the Gemini API exposes no usage endpoint — monitor spend in the Google Cloud console.'

export type GeminiLimitWindow =
  | { state: 'limited'; resetsAtMs: number; observedAtMs: number }
  | { state: 'clear' }

let observed: { resetsAtMs: number; observedAtMs: number } | null = null

export function recordGeminiUsageLimit(
  resetsAtMs: number | undefined,
  now: () => number = Date.now,
): void {
  if (resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) return
  observed = { resetsAtMs, observedAtMs: now() }
}

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
  }
}

export function geminiLimitWindow(now: () => number = Date.now): GeminiLimitWindow {
  if (observed === null || observed.resetsAtMs <= now()) return { state: 'clear' }
  return { state: 'limited', resetsAtMs: observed.resetsAtMs, observedAtMs: observed.observedAtMs }
}

export function geminiObservedWall(): { resetsAtMs: number; observedAtMs: number } | null {
  return observed
}

export function forgetGeminiObservedLimit(): void {
  observed = null
}

export function __resetGeminiUsageStateForTest(): void {
  observed = null
}
