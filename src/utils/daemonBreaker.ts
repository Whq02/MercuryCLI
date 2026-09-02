import { flagEnv, flagEnvLoose } from '../substrate/flagRegistry.js'
// ITEM 6.4 — Daemon/fleet circuit-breaker.
//
// The autonomous daemon (src/daemon/main.ts) already carries TWO local brakes:
//   • a PER-CHAIN empty-fire brake (loopStopPolicy.ts) — stops ONE recurring
//     task that produces N consecutive no-progress fires, and
//   • an inFlight CAP — back-pressure against a fast cadence.
// What it lacks is a GLOBAL brake: nothing notices when MANY different fires are
// failing across the fleet (children crashing, non-zero exits, spawn failures).
//
// This is that breaker — the same idea as a fleet circuit-
// breaker: a single lever that, once tripped, pauses
// ALL firing. It trips when the daemon sees too much failure in a window:
//   • N CONSECUTIVE child failures (non-zero / null exit), default 5, OR
//   • a failure RATE over a sliding window of recent outcomes (default: >= 80%
//     failures over the last 10 outcomes, once the window has filled).
// When TRIPPED it goes OPEN: every fire is suppressed for a cooldown. After the
// cooldown it HALF-OPENS to test the waters — it lets fires through again, and a
// single success closes it (full recovery) while a fresh failure re-opens it for
// another cooldown.
//
// SAFETY — additive, suppress-only, conservative:
//   • The breaker can only ever SUPPRESS a fire, NEVER add one. A wedged or
//     mis-tuned breaker degrades to "the daemon fires less / not at all", which
//     is the safe direction for an autonomous spawner.
//   • Defaults are conservative: it trips only on REAL repeated failure (5 in a
//     row, or a saturated failing window), so a healthy daemon never notices it.
//   • Pure + in-memory + scoped to one daemon process; nothing persisted. A
//     restarted daemon starts CLOSED (a fresh chance) — we never permanently
//     brick the scheduler, we only pause a failing fleet within one run.
//   • Always on for the daemon (the daemon is itself opt-in via `mercury daemon`);
//     it is imported ONLY by the daemon, so non-daemon / a bare stamp paths are
//     untouched.
//
// Env-tunable (read at construction, like loopStopPolicy):
//   MERCURY_DAEMON_BREAKER_FAILS      consecutive failures to trip   (default 5)
//   MERCURY_DAEMON_BREAKER_WINDOW     sliding-window size            (default 10)
//   MERCURY_DAEMON_BREAKER_RATE       failure-rate trip threshold    (default 0.8)
//   MERCURY_DAEMON_BREAKER_COOLDOWN_MS  open-state cooldown, ms      (default 60000)

/** Default consecutive child failures before the breaker trips OPEN. */
export const DEFAULT_BREAKER_CONSECUTIVE_FAILS = 5
/** Default sliding-window size for the failure-rate trip. */
export const DEFAULT_BREAKER_WINDOW = 10
/** Default failure-rate (0..1) over a FULL window that trips the breaker. */
export const DEFAULT_BREAKER_RATE = 0.8
/** Default cooldown the breaker stays OPEN before half-opening, in ms. */
export const DEFAULT_BREAKER_COOLDOWN_MS = 60 * 1000

/** Resolve a positive integer env override, else the default. */
function intEnv(name: string, dflt: number): number {
  const raw = flagEnvLoose(name)
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : dflt
}

/** Resolve a 0<rate<=1 float env override, else the default. */
function rateEnv(name: string, dflt: number): number {
  const raw = flagEnvLoose(name)
  const parsed = raw ? parseFloat(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : dflt
}

/** Tuning for {@link DaemonBreaker}. All optional; env / defaults fill the rest. */
export type DaemonBreakerConfig = {
  /** Consecutive failures to trip. Default DEFAULT_BREAKER_CONSECUTIVE_FAILS. */
  consecutiveFails?: number
  /** Sliding-window size for the rate trip. Default DEFAULT_BREAKER_WINDOW. */
  windowSize?: number
  /** Failure-rate (0..1) over a FULL window to trip. Default DEFAULT_BREAKER_RATE. */
  failureRate?: number
  /** Cooldown the breaker stays OPEN, in ms. Default DEFAULT_BREAKER_COOLDOWN_MS. */
  cooldownMs?: number
  /** Injectable clock (ms) for deterministic tests. Default Date.now. */
  now?: () => number
}

/** Breaker states (classic three-state circuit breaker). */
export type BreakerState = 'closed' | 'open' | 'half-open'

/** A snapshot of breaker state for logging / introspection. */
export type BreakerStatus = {
  state: BreakerState
  consecutiveFailures: number
  /** ms remaining in the OPEN cooldown (0 when not OPEN). */
  cooldownRemainingMs: number
  /** Number of outcomes currently in the sliding window. */
  windowFilled: number
  /** Failures within the current window. */
  windowFailures: number
}

/**
 * In-memory, per-daemon-process circuit breaker. Record every child outcome via
 * {@link recordResult}; before each fire, consult {@link shouldSuppressFire}.
 *
 * State machine:
 *   CLOSED      — normal; fires allowed. Trips OPEN on N consecutive failures or
 *                 a saturated failing window.
 *   OPEN        — tripped; ALL fires suppressed until the cooldown elapses, then
 *                 transitions to HALF-OPEN (lazily, on the next check/record).
 *   HALF-OPEN   — probationary; fires allowed. One success → CLOSED (recovered);
 *                 one failure → OPEN again (fresh cooldown).
 */
export class DaemonBreaker {
  private readonly consecutiveFails: number
  private readonly windowSize: number
  private readonly failureRate: number
  private readonly cooldownMs: number
  private readonly now: () => number

  private state: BreakerState = 'closed'
  private consecutiveFailures = 0
  /** Most-recent-last ring of booleans (true = failure), capped at windowSize. */
  private window: boolean[] = []
  /** Wall time (ms) the breaker tripped OPEN; drives the cooldown. */
  private openedAt = 0

  constructor(config: DaemonBreakerConfig = {}) {
    this.consecutiveFails =
      config.consecutiveFails ??
      intEnv('MERCURY_DAEMON_BREAKER_FAILS', DEFAULT_BREAKER_CONSECUTIVE_FAILS)
    this.windowSize =
      config.windowSize ??
      intEnv('MERCURY_DAEMON_BREAKER_WINDOW', DEFAULT_BREAKER_WINDOW)
    this.failureRate =
      config.failureRate ??
      rateEnv('MERCURY_DAEMON_BREAKER_RATE', DEFAULT_BREAKER_RATE)
    this.cooldownMs =
      config.cooldownMs ??
      intEnv('MERCURY_DAEMON_BREAKER_COOLDOWN_MS', DEFAULT_BREAKER_COOLDOWN_MS)
    this.now = config.now ?? (() => Date.now())
  }

  /**
   * Lazily transition OPEN → HALF-OPEN once the cooldown has elapsed. Called at
   * the head of every public method so state is always current without a timer.
   */
  private settleCooldown(): void {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open'
    }
  }

  /** Trip the breaker OPEN and start the cooldown clock. */
  private trip(): void {
    this.state = 'open'
    this.openedAt = this.now()
  }

  /**
   * Map an exit code to ok/fail. Non-zero OR null (killed / spawn fail) = fail.
   * NOTE this cannot tell a wall-clock TIMEOUT (also a SIGKILL ⇒ `code === null`)
   * apart from a genuine crash — that distinction is carried out-of-band by the
   * runner's `HeadlessResult.timedOut` flag and routed to {@link recordTimeout} at
   * the feed site only when {@link timeoutIsFleetFailure} is false (opt-in).
   */
  static isFailureExit(code: number | null | undefined): boolean {
    return code !== 0
  }

  /**
   * Should a wall-clock TIMEOUT (a run SIGTERM/SIGKILLed at the per-run cap) count
   * as a full fleet failure that feeds the consecutive-failure trip?
   *
   * DEFAULT YES — byte-identical to today: a timeout closes with `code === null`,
   * so the feed sites already treat it as a hard failure via `recordResult(false)`.
   * The softer carve-out (route it through {@link recordTimeout}, which never feeds
   * the consecutive trip) is OPT-IN behind `MERCURY_DAEMON_BREAKER_TIMEOUT_OK=1`:
   * set it when long legitimate fires should not pause the whole fleet. Read at the
   * feed site, like every other daemon brake knob.
   */
  static timeoutIsFleetFailure(): boolean {
    return flagEnv('MERCURY_DAEMON_BREAKER_TIMEOUT_OK') !== '1'
  }

  /**
   * Record one child outcome. `ok=false` is a failure (non-zero / null exit, a
   * spawn failure, or a thrown error in supervision). Advances the consecutive
   * counter and the sliding window, and trips / recovers the state machine.
   *
   * @returns the breaker's BreakerState AFTER recording (so the caller can log a
   *   transition into OPEN).
   */
  recordResult(ok: boolean): BreakerState {
    this.settleCooldown()

    // Maintain the sliding window (true = failure).
    this.window.push(!ok)
    if (this.window.length > this.windowSize) this.window.shift()

    if (ok) {
      this.consecutiveFailures = 0
      // A success in HALF-OPEN means the fleet recovered — fully close.
      if (this.state === 'half-open') {
        this.state = 'closed'
        this.window = []
      }
      return this.state
    }

    // Failure.
    this.consecutiveFailures++

    // A failure while probing (HALF-OPEN) re-opens for a fresh cooldown.
    if (this.state === 'half-open') {
      this.trip()
      return this.state
    }

    if (this.state === 'closed') {
      const consecutiveTrip = this.consecutiveFailures >= this.consecutiveFails
      const windowTrip =
        this.window.length >= this.windowSize &&
        this.window.filter(Boolean).length / this.window.length >=
          this.failureRate
      if (consecutiveTrip || windowTrip) {
        this.trip()
      }
    }
    return this.state
  }

  /**
   * Record one wall-clock TIMEOUT (a run SIGTERM/SIGKILLed at the per-run cap,
   * surfaced by the runner's `timedOut` flag). A timeout is a WEAK fleet-health
   * signal, not a crash, so — unlike {@link recordResult} on a failure — it:
   *   • advances the sliding WINDOW as a failure (so a fleet that is ALL timing
   *     out still trips the window-rate path, the runaway-leash backstop), but
   *   • does NOT advance the consecutive-failure counter, and in fact RESETS it
   *     (a long task is not a crash streak), so N long fires in a row can never
   *     trip the consecutive path and pause the fleet, and
   *   • never re-opens a HALF-OPEN breaker on its own (a long task is not proof
   *     the fleet is still broken — the next REAL outcome decides recovery).
   * Reached only when {@link timeoutIsFleetFailure} is false (the OPT-IN carve-out,
   * MERCURY_DAEMON_BREAKER_TIMEOUT_OK=1); otherwise a timeout flows through
   * {@link recordResult}(false) as a hard failure (the default). Returns the state
   * AFTER recording (for symmetry / logging).
   */
  recordTimeout(): BreakerState {
    this.settleCooldown()

    // Maintain the sliding window (true = failure) so an all-timeout fleet still
    // trips the rate path — the leash for a genuinely wedged spawner.
    this.window.push(true)
    if (this.window.length > this.windowSize) this.window.shift()

    // A timeout is NOT a crash: clear any primed consecutive streak so a long
    // task can never be the Nth failure that trips the consecutive path.
    this.consecutiveFailures = 0

    // Only the window-rate path may trip on timeouts (CLOSED only — never re-open
    // a HALF-OPEN probe on a timeout alone).
    if (this.state === 'closed') {
      const windowTrip =
        this.window.length >= this.windowSize &&
        this.window.filter(Boolean).length / this.window.length >=
          this.failureRate
      if (windowTrip) {
        this.trip()
      }
    }
    return this.state
  }

  /**
   * Should the daemon SUPPRESS firing right now? True only while OPEN (cooling
   * down). HALF-OPEN allows a probe fire; CLOSED always allows. Settles a lapsed
   * cooldown first, so a long-idle OPEN breaker half-opens on the next check
   * without needing a recorded outcome.
   *
   * Pure query (no mutation). HALF-OPEN single-probe concurrency is enforced by
   * the CALLER (the daemon caps in-flight runs to 1 while half-open via getState)
   * — keeping it caller-side avoids leaking an "admitted" flag when the caller
   * has an early-return between this check and recordResult (e.g. a concurrency
   * cap or a throw), which would otherwise wedge the breaker half-open.
   */
  shouldSuppressFire(): boolean {
    this.settleCooldown()
    return this.state === 'open'
  }

  /** Current state (after settling any lapsed cooldown). Test / log seam. */
  getState(): BreakerState {
    this.settleCooldown()
    return this.state
  }

  /** A snapshot for logging. Does not mutate beyond settling the cooldown. */
  getStatus(): BreakerStatus {
    this.settleCooldown()
    const remaining =
      this.state === 'open'
        ? Math.max(0, this.cooldownMs - (this.now() - this.openedAt))
        : 0
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      cooldownRemainingMs: remaining,
      windowFilled: this.window.length,
      windowFailures: this.window.filter(Boolean).length,
    }
  }

  /** The consecutive-failure threshold this breaker trips on. */
  getConsecutiveFailThreshold(): number {
    return this.consecutiveFails
  }

  /** The cooldown (ms) the breaker stays OPEN. */
  getCooldownMs(): number {
    return this.cooldownMs
  }
}
