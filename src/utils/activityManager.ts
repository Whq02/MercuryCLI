/**
 * Singleton that accounts user-active vs CLI-active wall time into an
 * injected counter.
 *
 * The default counter accessor yields NO counter (and the default clock is
 * the wall clock), so the instance the product actually constructs
 * attributes time to nothing: the state getter and the in-flight set still
 * work, but no seconds are recorded unless a test injects a counter.
 */

type ActiveTimeCounter = {
  add(value: number, attributes: Record<string, string>): void
}

type ActivityManagerOptions = {
  clock?: () => number
  getActiveTimeCounter?: () => ActiveTimeCounter | undefined
}

// A user is considered active for this long after their last activity; spans
// at or beyond it are treated as idle time and not attributed.
const INACTIVITY_TIMEOUT_MS = 5000

export class ActivityManager {
  private static instance: ActivityManager | undefined

  static getInstance(): ActivityManager {
    if (!ActivityManager.instance) {
      ActivityManager.instance = new ActivityManager()
    }
    return ActivityManager.instance
  }

  private readonly clock: () => number
  private readonly getActiveTimeCounter: () => ActiveTimeCounter | undefined
  private readonly activeOperations = new Set<string>()
  // 0 means "no user activity yet".
  private lastUserActivityMs = 0
  private cliActive = false
  private cliReferenceTimeMs: number

  private constructor(options?: ActivityManagerOptions) {
    this.clock = options?.clock ?? (() => Date.now())
    this.getActiveTimeCounter = options?.getActiveTimeCounter ?? (() => undefined)
    this.cliReferenceTimeMs = this.clock()
  }

  /**
   * Attribute the span since the previous user activity as user time — but
   * only when the CLI is not active (a busy CLI wins over the user), only
   * when there was a previous activity, and only when the span is strictly
   * positive and strictly below the inactivity timeout. The timestamp is
   * updated unconditionally afterwards, including when nothing was
   * attributed.
   */
  recordUserActivity(): void {
    const now = this.clock()
    if (!this.cliActive && this.lastUserActivityMs !== 0) {
      const elapsedMs = now - this.lastUserActivityMs
      if (elapsedMs > 0 && elapsedMs < INACTIVITY_TIMEOUT_MS) {
        this.getActiveTimeCounter()?.add(elapsedMs / 1000, { type: 'user' })
      }
    }
    this.lastUserActivityMs = now
  }

  /**
   * Start a CLI operation. An id that is already in flight is force-ended
   * first: a surface can die without ever ending its operation, and a stale
   * entry would otherwise keep the CLI marked busy for the rest of the
   * session — ending it early loses a little accounted time, which is the
   * tolerable direction of error.
   */
  startCLIActivity(operationId: string): void {
    if (this.activeOperations.has(operationId)) {
      this.endCLIActivity(operationId)
    }
    if (this.activeOperations.size === 0) {
      this.cliActive = true
      this.cliReferenceTimeMs = this.clock()
    }
    this.activeOperations.add(operationId)
  }

  /**
   * End a CLI operation. Deliberately not conditioned on the id having been
   * started: ending an unknown id while nothing is in flight still takes the
   * "set became empty" path, attributing the span since the last reference
   * point as CLI time and re-basing the reference. A "known id" guard would
   * change the numbers.
   */
  endCLIActivity(operationId: string): void {
    this.activeOperations.delete(operationId)
    if (this.activeOperations.size === 0) {
      // One clock read per end call: the elapsed computation and the
      // re-based reference use the SAME reading.
      const now = this.clock()
      const elapsedMs = now - this.cliReferenceTimeMs
      if (elapsedMs > 0) {
        this.getActiveTimeCounter()?.add(elapsedMs / 1000, { type: 'cli' })
      }
      this.cliReferenceTimeMs = now
      this.cliActive = false
    }
  }

  /** Track an async operation, ending it in a finally. */
  async trackOperation<T>(operationId: string, fn: () => Promise<T>): Promise<T> {
    this.startCLIActivity(operationId)
    try {
      return await fn()
    } finally {
      this.endCLIActivity(operationId)
    }
  }

  getActivityStates(): {
    isUserActive: boolean
    isCLIActive: boolean
    activeOperationCount: number
  } {
    return {
      isUserActive:
        this.lastUserActivityMs !== 0 &&
        this.clock() - this.lastUserActivityMs < INACTIVITY_TIMEOUT_MS,
      isCLIActive: this.cliActive,
      activeOperationCount: this.activeOperations.size,
    }
  }
}

// Bound once at module load.
export const activityManager = ActivityManager.getInstance()
