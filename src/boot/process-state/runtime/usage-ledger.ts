import sumBy from 'lodash-es/sumBy.js'

export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow?: number
  maxOutputTokens?: number
  lastUsedAtMs?: number
}

export type WorkloadUsage = { [workload: string]: { [modelName: string]: ModelUsage } }
export type WorkloadUnpricedTurns = { [workload: string]: { [modelName: string]: number } }

export class UsageLedgerOwner {
  totalCostUSD: number = 0
  totalAPIDuration: number = 0
  totalAPIDurationWithoutRetries: number = 0
  totalToolDuration: number = 0
  startTime: number = Date.now()
  totalLinesAdded: number = 0
  totalLinesRemoved: number = 0
  hasUnknownModelCost: boolean = false
  modelUsage: { [modelName: string]: ModelUsage } = {}
  unpricedTurns: { [modelName: string]: number } = {}
  workloadUsage: WorkloadUsage = {}
  workloadUnpricedTurns: WorkloadUnpricedTurns = {}

  addToTotalDurationState(
    duration: number,
    durationWithoutRetries: number,
  ): void {
    this.totalAPIDuration += duration
    this.totalAPIDurationWithoutRetries += durationWithoutRetries
  }

  addToTotalCostState(cost: number, modelUsage: ModelUsage, model: string): void {
    this.totalCostUSD += cost
    this.modelUsage[model] = modelUsage
  }

  recordUnpricedTurn(model: string): void {
    this.unpricedTurns[model] = (this.unpricedTurns[model] ?? 0) + 1
  }

  addToWorkloadUsageState(workload: string, delta: ModelUsage, model: string): void {
    let byModel = this.workloadUsage[workload]
    if (!byModel) {
      byModel = {}
      this.workloadUsage[workload] = byModel
    }
    let entry = byModel[model]
    if (!entry) {
      entry = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
      }
      byModel[model] = entry
    }
    entry.inputTokens += delta.inputTokens
    entry.outputTokens += delta.outputTokens
    entry.cacheReadInputTokens += delta.cacheReadInputTokens
    entry.cacheCreationInputTokens += delta.cacheCreationInputTokens
    entry.webSearchRequests += delta.webSearchRequests
    entry.costUSD += delta.costUSD
  }

  recordWorkloadUnpricedTurn(workload: string, model: string): void {
    let byModel = this.workloadUnpricedTurns[workload]
    if (!byModel) {
      byModel = {}
      this.workloadUnpricedTurns[workload] = byModel
    }
    byModel[model] = (byModel[model] ?? 0) + 1
  }

  getTotalUnpricedTurns(): number {
    return Object.values(this.unpricedTurns).reduce((sum, count) => sum + count, 0)
  }

  addToolDuration(duration: number): void {
    this.totalToolDuration += duration
  }

  addToTotalLinesChanged(added: number, removed: number): void {
    this.totalLinesAdded += added
    this.totalLinesRemoved += removed
  }

  getTotalDuration(): number {
    return Date.now() - this.startTime
  }

  getTotalInputTokens(): number {
    return sumBy(Object.values(this.modelUsage), 'inputTokens')
  }

  getTotalOutputTokens(): number {
    return sumBy(Object.values(this.modelUsage), 'outputTokens')
  }

  getTotalCacheReadInputTokens(): number {
    return sumBy(Object.values(this.modelUsage), 'cacheReadInputTokens')
  }

  getTotalCacheCreationInputTokens(): number {
    return sumBy(Object.values(this.modelUsage), 'cacheCreationInputTokens')
  }

  getTotalWebSearchRequests(): number {
    return sumBy(Object.values(this.modelUsage), 'webSearchRequests')
  }

  resetCostState(): void {
    this.totalCostUSD = 0
    this.totalAPIDuration = 0
    this.totalAPIDurationWithoutRetries = 0
    this.totalToolDuration = 0
    this.startTime = Date.now()
    this.totalLinesAdded = 0
    this.totalLinesRemoved = 0
    this.hasUnknownModelCost = false
    this.modelUsage = {}
    this.unpricedTurns = {}
    this.workloadUsage = {}
    this.workloadUnpricedTurns = {}
  }

  setCostStateForRestore(arg0: {
    totalCostUSD: number
    totalAPIDuration: number
    totalAPIDurationWithoutRetries: number
    totalToolDuration: number
    totalLinesAdded: number
    totalLinesRemoved: number
    lastDuration: number | undefined
    modelUsage: { [modelName: string]: ModelUsage } | undefined
    unpricedTurns?: { [modelName: string]: number } | undefined
    workloadUsage?: WorkloadUsage | undefined
    workloadUnpricedTurns?: WorkloadUnpricedTurns | undefined
  }): void {
    this.totalCostUSD = arg0.totalCostUSD
    this.totalAPIDuration = arg0.totalAPIDuration
    this.totalAPIDurationWithoutRetries = arg0.totalAPIDurationWithoutRetries
    this.totalToolDuration = arg0.totalToolDuration
    this.totalLinesAdded = arg0.totalLinesAdded
    this.totalLinesRemoved = arg0.totalLinesRemoved
    if (arg0.lastDuration !== undefined && arg0.lastDuration !== 0) {
      this.startTime = Date.now() - arg0.lastDuration
    }
    if (arg0.modelUsage !== undefined) {
      this.modelUsage = arg0.modelUsage
    }
    if (arg0.unpricedTurns !== undefined) {
      this.unpricedTurns = arg0.unpricedTurns
    }
    if (arg0.workloadUsage !== undefined) {
      this.workloadUsage = arg0.workloadUsage
    }
    if (arg0.workloadUnpricedTurns !== undefined) {
      this.workloadUnpricedTurns = arg0.workloadUnpricedTurns
    }
  }
}
