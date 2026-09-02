// ============================================================================
//  src/bootstrap/runtime/usage-ledger.ts — the cost/usage ledger owner
//
//
//  Scope: CONVERSATION — resetCostState is the /clear + login scope boundary
//  (driven by the facade, which also drops the api-capture promptId there).
//
//  The REWRITE TRAP this owner types explicitly (prove-state-contract LAW 2):
//  `totalCostUSD` ACCUMULATES across adds while `modelUsage[model]` REPLACES
//  the per-model entry — callers pass PRE-ACCUMULATED usage snapshots, so
//  recordModelUsage-style adds must never sum. Stored by reference.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): imports are ONE lodash helper (the same
//  leaf import the old state.ts body carried) and types. No src/utils value
//  imports. src/bootstrap/state.ts is the ONLY sanctioned importer; every
//  consumer goes through the frozen facade.
// ============================================================================
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
  /** Settled turns whose USD is UNRECORDED (no rate on file and no wire-
   *  stated cost), per model: their tokens sit in modelUsage, their cost is
   *  not a number — every surface prints "unpriced" from THIS count, never a
   *  $0.00 that reads as free (the usage-neutrality law). ACCUMULATES. */
  unpricedTurns: { [modelName: string]: number } = {}

  addToTotalDurationState(
    duration: number,
    durationWithoutRetries: number,
  ): void {
    this.totalAPIDuration += duration
    this.totalAPIDurationWithoutRetries += durationWithoutRetries
  }

  /** cost ACCUMULATES; the per-model usage entry is a REPLACE (snapshot
   *  write) — see the header. */
  addToTotalCostState(cost: number, modelUsage: ModelUsage, model: string): void {
    this.modelUsage[model] = modelUsage
    this.totalCostUSD += cost
  }

  /** One settled turn the ledger could not price — counted, never summed
   *  into totalCostUSD as a zero. */
  recordUnpricedTurn(model: string): void {
    this.unpricedTurns[model] = (this.unpricedTurns[model] ?? 0) + 1
  }

  getTotalUnpricedTurns(): number {
    return Object.values(this.unpricedTurns).reduce((sum, turns) => sum + turns, 0)
  }

  /** Total-side tool-duration write. The turn-accounting owner couples this
   *  with the per-turn triple in ONE method (addToToolDuration's dual write). */
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

  /** The /clear + login scope boundary for this family (the facade also
   *  drops the api-capture promptId in the same reset). */
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

  /**
   * Bulk-load the ledger from a persisted session (--resume). The one
   * caller is cost-tracker.ts restoreCostStateForSession.
   */
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
    /** The persisted unpriced-turn counts (a record written before this
     *  field existed restores none — the earlier leg's unpriced turns are
     *  then unknown, never invented). */
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

    // Backdate startTime by the restored wall duration so getTotalDuration()
    // keeps accumulating on top of the previous leg instead of restarting.
    if (lastDuration) {
      this.startTime = Date.now() - lastDuration
    }
  }
}
