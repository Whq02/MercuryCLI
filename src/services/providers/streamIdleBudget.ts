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

// ── the first-byte budget ────────────────────────────────────────────────────
//  The idle watchdog above arms once the response headers have arrived; the
//  wait BEFORE them — the provider ingesting the prompt — rode the SDK's
//  ten-minute request timeout alone, while the status row promised the
//  idle budget. A cold prefix (a model switch, the first request after a
//  compaction, a fresh session's first turn on a large prompt) is billed
//  uncached and ingests slowly and lawfully: the operator's turn sat
//  silent for five minutes at "the watchdog aborts at 1m". The first-byte
//  budget is the one number both the request (its timeout) and the status
//  row (its promise) read: the idle budget on a warm prefix, and on a cold
//  one the idle budget plus a per-token ingest allowance, bounded.

/** The ingest allowance a cold prefix earns per thousand prompt tokens. */
export const COLD_INGEST_MS_PER_1K_TOKENS = 1_200
/** No first-byte budget grows past this, however large the prompt. */
export const FIRST_BYTE_BUDGET_CEILING_MS = 300_000

export function firstByteBudgetMs(args: { cold: boolean; promptTokens: number; idleMs?: number }): number {
  const idle = args.idleMs ?? streamIdleTimeoutMs()
  if (!args.cold) return idle
  const tokens = Number.isFinite(args.promptTokens) && args.promptTokens > 0 ? args.promptTokens : 0
  const allowance = Math.round((tokens / 1000) * COLD_INGEST_MS_PER_1K_TOKENS)
  return Math.min(FIRST_BYTE_BUDGET_CEILING_MS, Math.max(idle, idle + allowance))
}

/** The request's prompt size at send time — the wire body's own bytes,
 *  four to a token (system, tools and messages alike; a coarse but
 *  send-time figure the budget and the status row share). */
export function estimateRequestTokens(body: unknown): number {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(body ?? '').length / 4))
  } catch {
    return 1
  }
}

/** A prefix the provider cannot serve from its cache: the newest response
 *  came from another model (a switch re-bills the prompt uncached), a
 *  compaction boundary stands after it (the folded prefix is new bytes), or
 *  no response exists yet (a fresh session's first turn). */
export function coldPrefixOf(messages: ReadonlyArray<unknown>, model: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index] as { type?: unknown; subtype?: unknown; message?: { model?: unknown } | null }
    if (row.type === 'system' && row.subtype === 'compact_boundary') return true
    if (row.type === 'assistant') {
      const stamped = row.message?.model
      if (typeof stamped !== 'string' || stamped === '' || stamped === '<synthetic>') continue
      return stamped !== model
    }
  }
  return true
}

/** What the runner is waiting on right now, as the status row and the
 *  spinner speak it — published by the request lane, relayed by a hosting
 *  seat, cleared when the first byte lands. */
export type RequestWaitV1 =
  | {
      kind: 'first-byte'
      cold: boolean
      promptTokens: number
      /** The model's display name (the row's word). */
      model: string
      budgetMs: number
      sinceMs: number
      attempt: number
    }
  | {
      kind: 'retry'
      attempt: number
      of: number
      /** "a 529", "a connection error" — the cause in the row's words. */
      reason: string
      delayMs: number
      sinceMs: number
    }

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))} s`
const kTokens = (tokens: number): string => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k-token` : `${tokens}-token`)

/** The wait's own line: what is being waited on, and the budget that fires. */
export function requestWaitLine(wait: RequestWaitV1): string {
  if (wait.kind === 'retry') {
    return `retrying — attempt ${wait.attempt} of ${wait.of} after ${wait.reason}${wait.delayMs > 0 ? ` · in ${seconds(wait.delayMs)}` : ''}`
  }
  const again = wait.attempt > 1 ? ` (attempt ${wait.attempt})` : ''
  return wait.cold
    ? `ingesting a ${kTokens(wait.promptTokens)} prompt on ${wait.model} — first byte expected within ${seconds(wait.budgetMs)}${again}`
    : `waiting for the first byte from ${wait.model} — within ${seconds(wait.budgetMs)}${again}`
}

/** The typed row when the first-byte budget fires: what was waited on,
 *  for how long, and why it was slow — the retry ladder appends its own
 *  "reissued" / "aborted" words. */
export function firstByteTimeoutLine(wait: Extract<RequestWaitV1, { kind: 'first-byte' }>): string {
  return `no first byte from ${wait.model} after ${seconds(wait.budgetMs)} (${
    wait.cold ? `a ${kTokens(wait.promptTokens)} prompt ingesting uncached` : 'the request was accepted and nothing arrived'
  })`
}

/** A wait as it arrives off the wire (a runner's status frame, a seat's
 *  tail projection): the exact shape or null — never a cast-through. */
export function decodeRequestWait(raw: unknown): RequestWaitV1 | null {
  if (raw === null || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  if (w.kind === 'first-byte') {
    const promptTokens = num(w.promptTokens)
    const budgetMs = num(w.budgetMs)
    const sinceMs = num(w.sinceMs)
    if (typeof w.model !== 'string' || promptTokens === null || budgetMs === null || sinceMs === null) return null
    return {
      kind: 'first-byte',
      cold: w.cold === true,
      promptTokens,
      model: w.model.slice(0, 120),
      budgetMs,
      sinceMs,
      attempt: num(w.attempt) ?? 1,
    }
  }
  if (w.kind === 'retry') {
    const attempt = num(w.attempt)
    const of = num(w.of)
    const sinceMs = num(w.sinceMs)
    if (attempt === null || of === null || sinceMs === null || typeof w.reason !== 'string') return null
    return { kind: 'retry', attempt, of, reason: w.reason.slice(0, 120), delayMs: num(w.delayMs) ?? 0, sinceMs }
  }
  return null
}

/** The retry cause in the row's words from a retry notice's status. */
export function retryReasonWords(status: number | null | undefined, message?: string): string {
  if (typeof status === 'number' && status > 0) return `a ${status}`
  if (message !== undefined && /no first byte/.test(message)) return 'a first-byte timeout'
  return 'a connection error'
}
