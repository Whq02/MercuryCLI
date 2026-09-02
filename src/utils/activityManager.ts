
type ActiveTimeCounter = {
  add(value: number, attributes: Record<string, string>): void
}

type ActivityManagerOptions = {
  clock?: () => number
  getActiveTimeCounter?: () => ActiveTimeCounter | undefined
}

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
  private lastUserActivityMs = 0
  private cliActive = false
  private cliReferenceTimeMs: number

  private constructor(options?: ActivityManagerOptions) {
    this.clock = options?.clock ?? (() => Date.now())
    this.getActiveTimeCounter = options?.getActiveTimeCounter ?? (() => undefined)
    this.cliReferenceTimeMs = this.clock()
  }

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

  endCLIActivity(operationId: string): void {
    this.activeOperations.delete(operationId)
    if (this.activeOperations.size === 0) {
      const now = this.clock()
      const elapsedMs = now - this.cliReferenceTimeMs
      if (elapsedMs > 0) {
        this.getActiveTimeCounter()?.add(elapsedMs / 1000, { type: 'cli' })
      }
      this.cliReferenceTimeMs = now
      this.cliActive = false
    }
  }

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

export const activityManager = ActivityManager.getInstance()
