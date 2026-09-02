// ============================================================================
//  providers/openai/openaiLimitState — the OpenAI lane's OBSERVED usage state
//
//
//  This lane has NO polled utilization endpoint — usage truth arrives
//  per-request, live, on the responses the account source already sends:
//
//    · 429 faults carry the reset facts (openaiWire folds resets_in_seconds /
//      x-codex-primary-reset-after-seconds into the fault's resetsAtMs —
//      live receipt on the subscription route, where a Plus
//      weekly window read 328224s ≈ 3.8 days);
//    · SUCCESS responses on the same route may carry the x-codex rate-limit
//      header family per band — used-percent / window-minutes /
//      reset-after-seconds — which is exactly the weekly meter OpenAI's own
//      surfaces render. recordOpenaiRateHeaders decodes whatever bands the
//      response actually states, each stamped observedAtMs.
//
//  The honest quota model is therefore LAST-OBSERVED, never fabricated: a
//  window exists here only when the provider stated it (the quota.ts
//  do-not-fake rule); a meter fed from here lights only on real
//  observations, and an account whose responses carry no usage headers
//  renders an honest labeled absence. One owner: the settings Usage tab,
//  the telemetry rail, and the dispatch-side limit checks all read THIS
//  module's records — the screen and the throttle can never disagree.
// ============================================================================

export type OpenaiLimitWindow =
  | { state: 'limited'; resetsAtMs: number; observedAtMs: number }
  | { state: 'clear' }

/** The account source a wall was observed ON. The two sources are separate
 *  billing pools (the ChatGPT plan windows vs API-key credit) — a wall
 *  recorded source-blind walled the OTHER slot too, refusing work on a
 *  credential with headroom (the observed find). Spelled locally so this
 *  latch stays import-free; openaiAccounts' OpenaiAccountSourceKind is the
 *  same union and the writer passes its value straight through. */
export type OpenaiLimitSource = 'chatgpt-subscription' | 'api-key'

const observedBySource: Record<OpenaiLimitSource, { resetsAtMs: number; observedAtMs: number } | null> = {
  'chatgpt-subscription': null,
  'api-key': null,
}

/** Record a usage-limit fault's reset fact against the source that answered
 *  it (no-op without one — a reset-less 429 carries no window to publish). */
export function recordOpenaiUsageLimit(
  resetsAtMs: number | undefined,
  source: OpenaiLimitSource,
  now: () => number = Date.now,
): void {
  if (resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) return
  observedBySource[source] = { resetsAtMs, observedAtMs: now() }
}

/** ONE source's window: 'limited' only while ITS observed reset is ahead.
 *  The other slot's wall never bleeds over — each source is its own pool. */
export function openaiLimitWindow(source: OpenaiLimitSource, now: () => number = Date.now): OpenaiLimitWindow {
  const observed = observedBySource[source]
  if (observed === null || observed.resetsAtMs <= now()) return { state: 'clear' }
  return { state: 'limited', resetsAtMs: observed.resetsAtMs, observedAtMs: observed.observedAtMs }
}

// ── observed usage windows (the live weekly-meter surface) ──────────────────

/** One provider-stated usage band, exactly as observed — every field except
 *  the observation stamp is optional because only what the source STATED is
 *  recorded (absent ≠ zero, ever). usedPct is 0–100. */
export interface OpenaiObservedWindow {
  usedPct?: number
  /** The band's window length as stated (e.g. 10080 = one week). */
  windowMinutes?: number
  resetsAtMs?: number
  observedAtMs: number
}

export interface OpenaiObservedUsage {
  primary?: OpenaiObservedWindow
  secondary?: OpenaiObservedWindow
}

let observedUsage: OpenaiObservedUsage = {}

function finiteOrUndefined(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Decode the x-codex rate-limit header family from ONE response (success or
 * failure alike — every authenticated response may carry it) and fold any
 * stated band into the observed record. A band records only when it states
 * a finite used-percent in [0, 100]; window/reset ride along only when
 * themselves stated. Absent headers change nothing — the previous
 * observation stands until the source speaks again. Never throws.
 */
export function recordOpenaiRateHeaders(
  headers: Headers | undefined,
  now: () => number = Date.now,
): void {
  if (!headers || typeof headers.get !== 'function') return
  try {
    const next: OpenaiObservedUsage = { ...observedUsage }
    for (const band of ['primary', 'secondary'] as const) {
      const usedPct = finiteOrUndefined(headers.get(`x-codex-${band}-used-percent`))
      if (usedPct === undefined || usedPct < 0 || usedPct > 100) continue
      const windowMinutes = finiteOrUndefined(headers.get(`x-codex-${band}-window-minutes`))
      const resetAfterSeconds = finiteOrUndefined(
        headers.get(`x-codex-${band}-reset-after-seconds`),
      )
      next[band] = {
        usedPct,
        ...(windowMinutes !== undefined && windowMinutes > 0 ? { windowMinutes } : {}),
        ...(resetAfterSeconds !== undefined && resetAfterSeconds >= 0
          ? { resetsAtMs: now() + resetAfterSeconds * 1000 }
          : {}),
        observedAtMs: now(),
      }
    }
    observedUsage = next
  } catch {
    /* usage observation must never fail a request */
  }
}

/** The last-observed usage bands (empty object = nothing observed yet). */
export function openaiObservedUsage(): OpenaiObservedUsage {
  return observedUsage
}

/**
 * Adopt bands another PROCESS observed (the daemon road: the session's
 * runner sees the response headers — this lane has no polled endpoint —
 * and its facts projection carries the record to the screen, which never
 * makes the calls itself). Per-band recency fold: a stated band lands only
 * when its observedAtMs is NEWER than what this process holds — the local
 * record (this process's own traffic, another session's adoption) is never
 * regressed by a stale projection; an absent band changes nothing (absent
 * ≠ zero, ever); a malformed record is ignored whole. Never throws.
 */
export function adoptOpenaiObservedUsage(
  record: { primary?: OpenaiObservedWindow; secondary?: OpenaiObservedWindow } | undefined,
): void {
  if (!record || typeof record !== 'object') return
  try {
    const next: OpenaiObservedUsage = { ...observedUsage }
    let moved = false
    for (const band of ['primary', 'secondary'] as const) {
      const incoming = record[band]
      if (!incoming || typeof incoming !== 'object') continue
      const at = incoming.observedAtMs
      if (typeof at !== 'number' || !Number.isFinite(at)) continue
      const usedPct = incoming.usedPct
      if (typeof usedPct !== 'number' || !Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) continue
      const held = next[band]
      if (held !== undefined && held.observedAtMs >= at) continue
      next[band] = {
        usedPct,
        ...(typeof incoming.windowMinutes === 'number' && incoming.windowMinutes > 0
          ? { windowMinutes: incoming.windowMinutes }
          : {}),
        ...(typeof incoming.resetsAtMs === 'number' && Number.isFinite(incoming.resetsAtMs)
          ? { resetsAtMs: incoming.resetsAtMs }
          : {}),
        observedAtMs: at,
      }
      moved = true
    }
    if (moved) observedUsage = next
  } catch {
    /* usage adoption must never fail a facts read */
  }
}

/** Proof seam. */
export function __resetOpenaiLimitStateForTest(): void {
  observedBySource['chatgpt-subscription'] = null
  observedBySource['api-key'] = null
  observedUsage = {}
}
