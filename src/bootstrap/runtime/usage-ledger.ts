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

export type LedgerMark = {
  costUSD: number
  apiDuration: number
  modelUsage: { [modelName: string]: ModelUsage }
  unpricedTurns: { [modelName: string]: number }
}

const LEDGER_COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD'] as const

export function usageSince(current: Record<string, ModelUsage>, baseline: Record<string, ModelUsage>): Record<string, ModelUsage> {
  const result: Record<string, ModelUsage> = {}
  for (const [model, row] of Object.entries(current)) {
    const delta = { ...row }
    for (const counter of LEDGER_COUNTERS) {
      delta[counter] = Math.max(0, row[counter] - (baseline[model]?.[counter] ?? 0))
    }
    if (LEDGER_COUNTERS.some(counter => delta[counter] > 0)) result[model] = delta
  }
  return result
}

export function advanceLedgerMark(mark: LedgerMark, spent: LedgerMark): void {
  mark.costUSD += spent.costUSD
  mark.apiDuration += spent.apiDuration
  for (const [model, row] of Object.entries(spent.modelUsage)) {
    const held = (mark.modelUsage[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 })
    for (const counter of LEDGER_COUNTERS) held[counter] += row[counter]
  }
  for (const [model, turns] of Object.entries(spent.unpricedTurns)) mark.unpricedTurns[model] = (mark.unpricedTurns[model] ?? 0) + turns
}

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
    this.modelUsage[model] = modelUsage
    this.totalCostUSD += cost
  }

  recordUnpricedTurn(model: string): void {
    this.unpricedTurns[model] = (this.unpricedTurns[model] ?? 0) + 1
  }

  mark(): LedgerMark {
    return {
      costUSD: this.totalCostUSD,
      apiDuration: this.totalAPIDuration,
      modelUsage: Object.fromEntries(Object.entries(this.modelUsage).map(([model, row]) => [model, { ...row }])),
      unpricedTurns: { ...this.unpricedTurns },
    }
  }

  spentSince(mark: LedgerMark): LedgerMark {
    const unpricedTurns: { [modelName: string]: number } = {}
    for (const [model, turns] of Object.entries(this.unpricedTurns)) {
      if (turns > (mark.unpricedTurns[model] ?? 0)) unpricedTurns[model] = turns - (mark.unpricedTurns[model] ?? 0)
    }
    return {
      costUSD: Math.max(0, this.totalCostUSD - mark.costUSD),
      apiDuration: Math.max(0, this.totalAPIDuration - mark.apiDuration),
      modelUsage: usageSince(this.modelUsage, mark.modelUsage),
      unpricedTurns,
    }
  }

  addToWorkloadUsageState(workload: string, delta: ModelUsage, model: string): void {
    const bucket = (this.workloadUsage[workload] ??= {})
    const record = bucket[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
    }
    record.inputTokens += delta.inputTokens
    record.outputTokens += delta.outputTokens
    record.cacheReadInputTokens += delta.cacheReadInputTokens
    record.cacheCreationInputTokens += delta.cacheCreationInputTokens
    record.webSearchRequests += delta.webSearchRequests
    record.costUSD += delta.costUSD
    bucket[model] = record
  }

  recordWorkloadUnpricedTurn(workload: string, model: string): void {
    const bucket = (this.workloadUnpricedTurns[workload] ??= {})
    bucket[model] = (bucket[model] ?? 0) + 1
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
    this.workloadUsage = {}
    this.workloadUnpricedTurns = {}
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
    workloadUsage,
    workloadUnpricedTurns,
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
    workloadUsage?: WorkloadUsage | undefined
    workloadUnpricedTurns?: WorkloadUnpricedTurns | undefined
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
    if (workloadUsage) {
      this.workloadUsage = workloadUsage
    }
    if (workloadUnpricedTurns) {
      this.workloadUnpricedTurns = workloadUnpricedTurns
    }

    if (lastDuration) {
      this.startTime = Date.now() - lastDuration
    }
  }
}
