import sumBy from 'lodash-es/sumBy.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

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

export type WorkloadUsage = Unbuilt
export type WorkloadUnpricedTurns = Unbuilt

export class UsageLedgerOwner {
  totalCostUSD: number = unbuilt('src/bootstrap/runtime/usage-ledger.ts:19')
  totalAPIDuration: number = unbuilt('src/bootstrap/runtime/usage-ledger.ts:20')
  totalAPIDurationWithoutRetries: number = unbuilt('src/bootstrap/runtime/usage-ledger.ts:21')
  totalToolDuration: number = unbuilt('src/bootstrap/runtime/usage-ledger.ts:22')
  startTime: number = unbuilt('src/bootstrap/runtime/usage-ledger.ts:23')
  totalLinesAdded: number = unbuilt('src/bootstrap/runtime/usage-ledger.ts:24')
  totalLinesRemoved: number = unbuilt('src/bootstrap/runtime/usage-ledger.ts:25')
  hasUnknownModelCost: boolean = unbuilt('src/bootstrap/runtime/usage-ledger.ts:26')
  modelUsage: { [modelName: string]: ModelUsage } = unbuilt('src/bootstrap/runtime/usage-ledger.ts:27')
  unpricedTurns: { [modelName: string]: number } = unbuilt('src/bootstrap/runtime/usage-ledger.ts:28')
  workloadUsage: WorkloadUsage = unbuilt('src/bootstrap/runtime/usage-ledger.ts:29')
  workloadUnpricedTurns: WorkloadUnpricedTurns = unbuilt('src/bootstrap/runtime/usage-ledger.ts:30')

  addToTotalDurationState(
    duration: number,
    durationWithoutRetries: number,
  ): void {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:32')
  }

  addToTotalCostState(cost: number, modelUsage: ModelUsage, model: string): void {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:40')
  }

  recordUnpricedTurn(model: string): void {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:45')
  }

  addToWorkloadUsageState(workload: string, delta: ModelUsage, model: string): void {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:49')
  }

  recordWorkloadUnpricedTurn(workload: string, model: string): void {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:68')
  }

  getTotalUnpricedTurns(): number {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:73')
  }

  addToolDuration(duration: number): void {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:77')
  }

  addToTotalLinesChanged(added: number, removed: number): void {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:81')
  }

  getTotalDuration(): number {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:86')
  }

  getTotalInputTokens(): number {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:90')
  }

  getTotalOutputTokens(): number {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:94')
  }

  getTotalCacheReadInputTokens(): number {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:98')
  }

  getTotalCacheCreationInputTokens(): number {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:102')
  }

  getTotalWebSearchRequests(): number {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:106')
  }

  resetCostState(): void {
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:110')
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
    return notBuilt('src/bootstrap/runtime/usage-ledger.ts:125')
  }
}
