// ============================================================================
//  providers/streamIdleBudget — the ONE owner of the stream idle budget.
//
//  The stream watchdog (anthropic/streamCore) aborts a stream that carries no
//  event for the budget and warns at half of it; the compat clients (openai,
//  zai, openai-compat) guard their byte reads with the same default. The
//  focused chat's status row names a session "stuck" only against the
//  runner's REAL budget, and the runner reports it in its facts answer — so
//  every reader takes the number from here, never from a second constant.
//
//  Env: MERCURY_STREAM_IDLE_TIMEOUT_MS (flagRegistry row) — integer ≥ 1000
//  ms; below-floor or unparseable values fall through to the default. Slow
//  links raise it, fixtures shrink it. The compat clients' guard is not
//  env-tunable (their idle guard reads bytes, not events) — it takes the
//  default alone.
// ============================================================================

/** The default budget every road shares: 90 s. */
export const STREAM_IDLE_DEFAULT_MS = 90_000

/** The budget floor: an env value below it falls through to the default. */
const STREAM_IDLE_FLOOR_MS = 1_000

/** The Anthropic stream watchdog's budget in THIS process (env-tunable). */
export function streamIdleTimeoutMs(): number {
  const raw = process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed >= STREAM_IDLE_FLOOR_MS ? parsed : STREAM_IDLE_DEFAULT_MS
}

/** The compat clients' fixed byte-idle guard. */
export function compatStreamIdleTimeoutMs(): number {
  return STREAM_IDLE_DEFAULT_MS
}

/** The watchdog's warning point for a budget: half of it — the point at
 *  which streamCore logs the silence warning, and the point past which the
 *  status row may say a session "may be stuck". One rule, read by both. */
export function streamIdleWarningMsOf(timeoutMs: number): number {
  return timeoutMs / 2
}

/** The budget the runner of a session on `route` lives under: the
 *  env-tunable watchdog on the first-party road, the fixed guard elsewhere.
 *  `null` route (unknown family) reads the first-party number — the
 *  session's next call is decided by the model owner, and the default is
 *  the same on every road anyway. */
export function streamIdleTimeoutMsForRoute(route: string | null): number {
  return route === null || route === 'anthropic' ? streamIdleTimeoutMs() : compatStreamIdleTimeoutMs()
}
