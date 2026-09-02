import { flagEnv, flagEnvLoose } from '../substrate/flagRegistry.js'

export const DEFAULT_BREAKER_CONSECUTIVE_FAILS = 5
export const DEFAULT_BREAKER_WINDOW = 10
export const DEFAULT_BREAKER_RATE = 0.8
export const DEFAULT_BREAKER_COOLDOWN_MS = 60 * 1000

function intEnv(name: string, dflt: number): number {
  const raw = flagEnvLoose(name)
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : dflt
}

function rateEnv(name: string, dflt: number): number {
  const raw = flagEnvLoose(name)
  const parsed = raw ? parseFloat(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : dflt
}

export type DaemonBreakerConfig = {
  consecutiveFails?: number
  windowSize?: number
  failureRate?: number
  cooldownMs?: number
  now?: () => number
}

export type BreakerState = 'closed' | 'open' | 'half-open'

export type BreakerStatus = {
  state: BreakerState
  consecutiveFailures: number
  cooldownRemainingMs: number
  windowFilled: number
  windowFailures: number
}

export class DaemonBreaker {
  private readonly consecutiveFails: number
  private readonly windowSize: number
  private readonly failureRate: number
  private readonly cooldownMs: number
  private readonly now: () => number

  private state: BreakerState = 'closed'
  private consecutiveFailures = 0
  private window: boolean[] = []
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

  private settleCooldown(): void {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open'
    }
  }

  private trip(): void {
    this.state = 'open'
    this.openedAt = this.now()
  }

  static isFailureExit(code: number | null | undefined): boolean {
    return code !== 0
  }

  static timeoutIsFleetFailure(): boolean {
    return flagEnv('MERCURY_DAEMON_BREAKER_TIMEOUT_OK') !== '1'
  }

  recordResult(ok: boolean): BreakerState {
    this.settleCooldown()

    this.window.push(!ok)
    if (this.window.length > this.windowSize) this.window.shift()

    if (ok) {
      this.consecutiveFailures = 0
      if (this.state === 'half-open') {
        this.state = 'closed'
        this.window = []
      }
      return this.state
    }

    this.consecutiveFailures++

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

  recordTimeout(): BreakerState {
    this.settleCooldown()

    this.window.push(true)
    if (this.window.length > this.windowSize) this.window.shift()

    this.consecutiveFailures = 0

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

  shouldSuppressFire(): boolean {
    this.settleCooldown()
    return this.state === 'open'
  }

  getState(): BreakerState {
    this.settleCooldown()
    return this.state
  }

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

  getConsecutiveFailThreshold(): number {
    return this.consecutiveFails
  }

  getCooldownMs(): number {
    return this.cooldownMs
  }
}
