/**
 * Pure supervision policy for a long-lived stream-json child (a crew
 * teammate, a session worker). The roster (roster.ts) owns the actual
 * ChildProcess glue (spawn / child.on('exit') / stdin.write); this module
 * is the loadable, side-effect-free DECISION logic it drives:
 *
 *   - exponential capped backoff between respawns,
 *   - respawn-until-ceiling-then-degrade,
 *   - the "long-lived respawns are exempt from the shared per-fire breaker"
 *     invariant (so a crash-looping child never trips the cron path's brake),
 *   - stream-json reply-frame normalization (one newline-terminated JSON line).
 *
 * Kept dependency-free so it is unit-testable under bun-run (roster.ts itself
 * reaches the feature() bundler macro and is not loadable there).
 */

export interface LongLivedSupervisorConfig {
  /** Respawns allowed before the supervisor gives up and flags degraded. */
  maxRespawns: number
  /** First-respawn backoff; doubles each respawn. */
  backoffBaseMs: number
  /** Backoff ceiling. */
  backoffCapMs: number
  /** Healthy-uptime bar (ms): a child that ran longer than this before crashing
   *  is NOT crash-looping, so its respawn-loop counter resets. Deliberately well
   *  ABOVE backoffCapMs — reusing the 60s backoff cap as the healthy bar let a
   *  worker that survived ~61s then crashed reset its counter forever and never
   *  degrade (a slow crash-loop). Optional; defaults to DEFAULT_HEALTHY_RESET_MS. */
  healthyResetMs?: number
  /** Lifetime-crash backstop: total crashes (across reset windows) after which the
   *  worker degrades REGARDLESS of the per-loop reset — catches a chronic slow
   *  crash-loop that keeps clearing the healthy bar. Optional; defaults to
   *  DEFAULT_MAX_LIFETIME_CRASHES. */
  maxLifetimeCrashes?: number
}

/** Default healthy-uptime bar — 5min, comfortably above the 60s backoff cap. */
export const DEFAULT_HEALTHY_RESET_MS = 5 * 60 * 1000
/** Default lifetime-crash backstop — a generous multiple of maxRespawns. */
export const DEFAULT_MAX_LIFETIME_CRASHES = 20

export const DEFAULT_LONG_LIVED_CONFIG: LongLivedSupervisorConfig = {
  maxRespawns: 5,
  backoffBaseMs: 1000,
  backoffCapMs: 60_000,
  healthyResetMs: DEFAULT_HEALTHY_RESET_MS,
  maxLifetimeCrashes: DEFAULT_MAX_LIFETIME_CRASHES,
}

/**
 * Long-lived respawns are EXEMPT from the shared DaemonBreaker: a crash-looping
 * seat must never suppress the cron fire path (they have independent
 * failure budgets). The roster reads this when wiring the crash handler.
 */
export const LONG_LIVED_FEEDS_SHARED_BREAKER = false

/** Exponential backoff (capped) for the Nth respawn (n >= 1). */
export function longLivedBackoffMs(
  respawns: number,
  cfg: LongLivedSupervisorConfig = DEFAULT_LONG_LIVED_CONFIG,
): number {
  const n = Math.max(1, respawns)
  return Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** (n - 1))
}

export type RespawnDecision =
  | { action: 'respawn'; delayMs: number; respawns: number }
  | { action: 'degrade'; reason: string; respawns: number }

/**
 * Decide what to do after a crash. `respawns` is the (per-loop) count AFTER
 * incrementing for this crash (1 on the first crash); `lifetimeCrashes` is the
 * TOTAL across reset windows (optional). Respawns with backoff up to and including
 * maxRespawns; degrade past that OR once the lifetime backstop is exceeded — the
 * latter catches a slow crash-loop that keeps clearing the healthy-uptime bar (so
 * the per-loop counter resets forever and the maxRespawns ceiling never trips).
 */
export function decideRespawn(
  respawns: number,
  cfg: LongLivedSupervisorConfig = DEFAULT_LONG_LIVED_CONFIG,
  lifetimeCrashes?: number,
): RespawnDecision {
  const lifetimeCap = cfg.maxLifetimeCrashes ?? DEFAULT_MAX_LIFETIME_CRASHES
  if (lifetimeCrashes !== undefined && lifetimeCrashes > lifetimeCap) {
    return {
      action: 'degrade',
      reason: `long-lived worker exceeded ${lifetimeCap} lifetime crashes (slow crash-loop)`,
      respawns,
    }
  }
  if (respawns > cfg.maxRespawns) {
    return {
      action: 'degrade',
      reason: `long-lived worker exceeded ${cfg.maxRespawns} respawns`,
      respawns,
    }
  }
  return { action: 'respawn', delayMs: longLivedBackoffMs(respawns, cfg), respawns }
}

/** Normalize a reply frame for the child's stdin: exactly one trailing newline. */
export function normalizeStreamJsonFrame(frame: string): string {
  return frame.endsWith('\n') ? frame : `${frame}\n`
}

//
// Reconfigure (W2 per-agent targeting) — the pure respawn-if-idle-else-queue
// decision. The roster owns the kill→respawn glue; this is the loadable core.
//

/** Default idle cap (ms) for the reconfigure respawn-if-idle decision. */
export const DEFAULT_RECONFIGURE_IDLE_MS = 15_000

/**
 * Is a long-lived worker idle enough to respawn it in place right now? The daemon
 * can't see the worker's mailbox replies, so idleness is approximated honestly
 * from delivery activity: `lastDeliveredAt === undefined` (nothing ever delivered,
 * or the live bus is opted out so no dispatch-tick runs) counts as IDLE; otherwise
 * idle once more than `idleMs` has elapsed since the last delivery.
 */
export function workerIsIdle(
  lastDeliveredAt: number | undefined,
  now: number,
  idleMs: number = DEFAULT_RECONFIGURE_IDLE_MS,
): boolean {
  return lastDeliveredAt === undefined || now - lastDeliveredAt > idleMs
}

/** The context-window usage counts carried by a stream-json `assistant`
 *  frame, normalized for calculateContextPercentages. */
export type StreamJsonUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  /** The response's own output — part of the context the worker's next
   *  request carries (the same full figure the compaction trigger reads). */
  output_tokens: number
}

/**
 * Parse ONE stream-json line to its frame, or null (empty, non-`{`, torn
 * JSON, or a non-object). THE drain's single parse: the roster's per-line
 * hot path parses here once and hands the frame to every classifier below
 * — the same line was parsed three times (usage, error, result) before.
 * Defensive: never throws. Pure — unit-testable under `bun run`.
 */
export function parseStreamJsonFrame(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t || t[0] !== '{') return null
  try {
    const parsed = JSON.parse(t) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Extract the LIVE-CONTEXT input/cache token usage from ONE stream-json line
 * (an `assistant` frame's `message.usage`, or a top-level `usage` on a
 * non-`result` frame), or null if the line carries no live-context usage.
 *
 * `result` frames are EXCLUDED by type: their `usage` is the turn's SUMMED
 * API accounting (every call's input+cache tokens added — measured live
 * a measured run: a 10-call turn at ~132k live context summed to
 * ~1.3M, read as 100% of the 1M window, and spuriously auto-cleared a healthy
 * seat mid-mission). Live context is what the per-call assistant frames
 * carry; result usage is billing-shaped, never window-shaped.
 *
 * Defensive: never throws, tolerates partial JSON and missing counts (treats
 * absent as 0), and returns null unless at least one input/cache count is
 * actually present (so a usage-less frame never reports a bogus 0%). Pure —
 * unit-testable under `bun run`.
 */
export function parseUsageFromStreamJsonLine(line: string): StreamJsonUsage | null {
  return usageOfStreamJsonFrame(parseStreamJsonFrame(line))
}

/** The frame-taking body of {@link parseUsageFromStreamJsonLine} (the
 *  parse-once drain hands its one frame here). */
export function usageOfStreamJsonFrame(frame: Record<string, unknown> | null): StreamJsonUsage | null {
  if (frame === null) return null
  if (frame.type === 'result') return null
  const msg = frame.message as Record<string, unknown> | undefined
  const u = (frame.usage ?? msg?.usage) as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return null
  if (
    u.input_tokens === undefined &&
    u.cache_read_input_tokens === undefined &&
    u.cache_creation_input_tokens === undefined
  ) {
    return null
  }
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input_tokens: n(u.input_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens),
    output_tokens: n(u.output_tokens),
  }
}

//
// display truth: the wire snapshot must report what the
// RUNNING child was actually launched with, never the requested next-spawn
// spec. reconfigureLongLived merges a patch into ll.spec IMMEDIATELY even when
// the bounce is queued — so before this split, a queued retarget read as
// already-applied on every board for up to a whole turn.
//

export type WireSpecView = {
  /** What the live child runs (spawn-captured; pre-first-spawn falls to spec). */
  model: string
  effort: string
  /** The REQUESTED next-spawn value, present only while a bounce is actually
   *  owed (queued or in flight) AND it differs from the running value — the
   *  board's "applies at turn end" annotation. */
  pendingModel?: string
  pendingEffort?: string
}

/**
 * PURE: derive the wire model/effort view from the running-vs-spec split.
 * `running` is captured at spawn; `spec` is the merge target reconfigures
 * patch. Pending only surfaces while a reconfigure is owed — a settled
 * running==spec pair carries no annotation.
 */
export function deriveWireSpec(args: {
  running: { model: string; effort: string } | undefined
  spec: { model: string; effort: string }
  pendingReconfigure?: boolean
  reconfiguring?: boolean
}): WireSpecView {
  const model = args.running?.model ?? args.spec.model
  const effort = args.running?.effort ?? args.spec.effort
  const owed = args.pendingReconfigure === true || args.reconfiguring === true
  return {
    model,
    effort,
    ...(owed && args.spec.model !== model ? { pendingModel: args.spec.model } : {}),
    ...(owed && args.spec.effort !== effort ? { pendingEffort: args.spec.effort } : {}),
  }
}

export type ReconfigureDecision = { respawn: boolean; pending: boolean }

/**
 * Decide how to apply a reconfigure (model/effort retarget): respawn-now when the
 * worker is idle, else QUEUE it (pending) so the dispatch-tick applies it on the
 * first idle observation. Pure — the roster owns the actual kill→respawn glue.
 */
export function decideReconfigure(args: {
  lastDeliveredAt: number | undefined
  now: number
  idleMs?: number
}): ReconfigureDecision {
  const idle = workerIsIdle(args.lastDeliveredAt, args.now, args.idleMs ?? DEFAULT_RECONFIGURE_IDLE_MS)
  return idle ? { respawn: true, pending: false } : { respawn: false, pending: true }
}

//
// PRECISE turn-active tracking (#41 bundling phase-out). The delivery-clock
// (workerIsIdle) is a 15s heuristic — under stress a task running longer than
// idleMs looked "idle" and back-pressure released, letting a 2nd dispatch land
// while the worker was still mid-task (violating "strictly one task at a
// time"). The daemon owns the child's stdout, which in stream-json mode emits a
// `result` frame at the END of each turn — so we can track turn-active PRECISELY:
// busy from the user-frame delivery (turn start) until the `result` frame (turn
// end), with a safety cap so a lost/late result frame can never starve the worker.
//

/** Safety cap: a turn cannot be "active" forever. If no `result` frame arrives
 *  within this window the turn is presumed wedged/dead and back-pressure releases
 *  (so a queued task is never starved). Generous — a legit deep task is fine; this
 *  only catches a hung/crashed turn. Env-tunable (MERCURY_IMPLEMENTER_MAX_TURN_MS —
 *  the knob keeps its historical spelling; it tunes every long-lived seat). */
export const DEFAULT_MAX_TURN_MS = 20 * 60 * 1000

/** Resolve the turn safety cap (env-tunable; non-numeric/≤0 ⇒ default). */
export function getMaxTurnMs(env: string | undefined): number {
  const n = env ? parseInt(env, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TURN_MS
}

/** True if a stream-json line is a turn-COMPLETE `result` frame (the signal a `-p`
 *  stream-json turn finished — one per delivered user-frame). Defensive: never
 *  throws, tolerates partial JSON. Pure — unit-testable under bun-run. */
export function isTurnResultFrame(line: string): boolean {
  return isTurnResultParsedFrame(parseStreamJsonFrame(line))
}

/** The frame-taking body of {@link isTurnResultFrame}. */
export function isTurnResultParsedFrame(frame: Record<string, unknown> | null): boolean {
  return frame !== null && frame.type === 'result'
}

/**
 * Extract the error text from an is_error result frame (bounded), else
 * undefined. The respawn-storm note carries this so a crash LOOP names its
 * cause instead of looping silently (the gpt-child incident: a
 * permanent provider/auth refusal exits the -p child per dispatch — the
 * supervisor read every exit as a plain crash and told nobody why).
 */
export function errorTextOfResultFrame(line: string): string | undefined {
  return errorTextOfParsedResultFrame(parseStreamJsonFrame(line))
}

/** The frame-taking body of {@link errorTextOfResultFrame}. */
export function errorTextOfParsedResultFrame(frame: Record<string, unknown> | null): string | undefined {
  if (frame === null || frame.type !== 'result' || frame.is_error !== true) return undefined
  const text = typeof frame.result === 'string' ? frame.result : JSON.stringify(frame.result)
  return (text ?? 'unknown error').slice(0, 240)
}

export type WorkerBusyDecision = { busy: boolean; basis: 'turn' | 'turn-capped' | 'delivery-clock' }

/**
 * PRECISE busy decision for dispatch back-pressure (#41). Prefers the real
 * turn-active signal (set true on delivery, false on the `result` frame); falls
 * back to the delivery-clock only when no turn boundary has been observed yet.
 *   - turnActive===true, within the cap  ⇒ busy (precise; holds under stress).
 *   - turnActive===true, past the cap     ⇒ NOT busy (presumed wedged — safety release).
 *   - turnActive===false                  ⇒ NOT busy (precise; the turn's result arrived).
 *   - turnActive===undefined              ⇒ delivery-clock fallback (workerIsIdle).
 * Pure — the roster owns the turnActive state; this is the loadable decision.
 */
export function decideWorkerBusy(args: {
  turnActive: boolean | undefined
  turnStartedAt: number | undefined
  now: number
  lastDeliveredAt: number | undefined
  idleMs?: number
  maxTurnMs?: number
}): WorkerBusyDecision {
  if (args.turnActive === true) {
    const cap = args.maxTurnMs ?? DEFAULT_MAX_TURN_MS
    if (args.turnStartedAt !== undefined && args.now - args.turnStartedAt > cap) {
      return { busy: false, basis: 'turn-capped' }
    }
    return { busy: true, basis: 'turn' }
  }
  if (args.turnActive === false) return { busy: false, basis: 'turn' }
  return { busy: !workerIsIdle(args.lastDeliveredAt, args.now, args.idleMs), basis: 'delivery-clock' }
}

export type DispatchBackPressure = { hold: boolean; reason: 'busy' | 'idle' | 'unknown' }

/**
 * Dispatch back-pressure (the operator's "stagger"): should a NEW dispatch be HELD
 * because the worker is mid-task? Reuses workerIsIdle as the single busy-truth
 * (busy = a dispatch was delivered within idleMs, so a reply is likely still pending),
 * the SAME approximation decideReconfigure already ships — the daemon can't see the
 * child's mailbox replies, so delivery activity is the honest proxy.
 *   - lastDeliveredAt === undefined (nothing ever dispatched) ⇒ no basis to hold ⇒
 *     {hold:false, reason:'unknown'}.
 *   - idle past idleMs ⇒ {hold:false, reason:'idle'}.
 *   - busy ⇒ hold when within the concurrency window (maxInFlight, default 1 = one
 *     task at a time); batching can later raise maxInFlight to allow a small window.
 * Pure — the bridge owns the actual skip-redeliver glue; an operator-queued
 * (priority:'high') dispatch bypasses this upstream.
 */
export function decideDispatchBackPressure(args: {
  lastDeliveredAt: number | undefined
  now: number
  idleMs?: number
  maxInFlight?: number
}): DispatchBackPressure {
  if (args.lastDeliveredAt === undefined) return { hold: false, reason: 'unknown' }
  const idle = workerIsIdle(args.lastDeliveredAt, args.now, args.idleMs ?? DEFAULT_RECONFIGURE_IDLE_MS)
  if (idle) return { hold: false, reason: 'idle' }
  return { hold: (args.maxInFlight ?? 1) <= 1, reason: 'busy' }
}
