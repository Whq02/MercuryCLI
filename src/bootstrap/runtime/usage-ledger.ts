import sumBy from 'lodash-es/sumBy.js'
import type { ModelUsage } from 'src/entrypoints/agentSdkTypes.js'

export class UsageLedgerOwner {
  totalCostUSD = 0
  totalAPIDuration = 0
  totalAPIDurationWithoutRetries = 0
  totalToolDuration = 0
  startTime: number = Date.now()
  totalLinesAdded = 0
  totalLinesRemoved = 0
  hasUnknownModelCost = false
  modelUsage: { [modelName: string]: ModelUsage } = {}
  unpricedTurns: { [modelName: string]: number } = {}

  addToTotalDurationState(
    duration: number,
    durationWithoutRetries: number,
  ): void {
    this.totalAPIDuration += duration
    this.totalAPIDurationWithoutRetries += durationWithoutRetries
  }

  addToTotalCostState(cost: number, modelUsage: ModelUsage, model: string): void {
    this.modelUsage[model] = modelUsage
    this.totalCostUSD += cost
  }

  recordUnpricedTurn(model: string): void {
    this.unpricedTurns[model] = (this.unpricedTurns[model] ?? 0) + 1
  }

  getTotalUnpricedTurns(): number {
    return Object.values(this.unpricedTurns).reduce((sum, turns) => sum + turns, 0)
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
  }

  resetDurationsAndCostForTestsOnly(): void {
    this.totalAPIDuration = 0
    this.totalAPIDurationWithoutRetries = 0
    this.totalCostUSD = 0
  }

  setCostStateForRestore({
    totalCostUSD,
    totalAPIDuration,
    totalAPIDurationWithoutRetries,
    totalToolDuration,
    totalLinesAdded,
    totalLinesRemoved,
    lastDuration,
    modelUsage,
    unpricedTurns,
  }: {
    totalCostUSD: number
    totalAPIDuration: number
    totalAPIDurationWithoutRetries: number
    totalToolDuration: number
    totalLinesAdded: number
    totalLinesRemoved: number
    lastDuration: number | undefined
    modelUsage: { [modelName: string]: ModelUsage } | undefined
    unpricedTurns?: { [modelName: string]: number } | undefined
  }): void {
    this.totalCostUSD = totalCostUSD
    this.totalAPIDuration = totalAPIDuration
    this.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
    this.totalToolDuration = totalToolDuration
    this.totalLinesAdded = totalLinesAdded
    this.totalLinesRemoved = totalLinesRemoved

    if (modelUsage) {
      this.modelUsage = modelUsage
    }
    if (unpricedTurns) {
      this.unpricedTurns = unpricedTurns
    }

    if (lastDuration) {
      this.startTime = Date.now() - lastDuration
    }
  }
}
