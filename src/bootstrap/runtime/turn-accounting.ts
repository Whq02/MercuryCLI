// ============================================================================
//  src/bootstrap/runtime/turn-accounting.ts — the turn-accounting owner
//
//
//  Scope: TURN — the three per-turn duration/count triples, the turn output-
//  token window, and the budget-continuation counter. Moved as ONE step with
//  the usage ledger (the banked sequence's batch 4a) because the two are
//  load-bearingly coupled:
//   - addToToolDuration writes BOTH the ledger total and the turn triple in
//     one call (the dual write lives HERE, explicitly);
//   - getTurnOutputTokens derives from the ledger's modelUsage sums
//     (turn output = total output − the snapshot taken at the turn boundary).
//  Turn resets zero ONLY the turn side; the ledger totals survive
//  (prove-state-contract LAW 3's scope pin).
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): imports only the sibling ledger owner.
//  src/bootstrap/state.ts is the ONLY sanctioned importer; every consumer
//  goes through the frozen facade.
// ============================================================================
import type { UsageLedgerOwner } from './usage-ledger.js'

export class TurnAccountingOwner {
  turnHookDurationMs = 0
  turnHookCount = 0
  turnToolDurationMs = 0
  turnToolCount = 0
  turnClassifierDurationMs = 0
  turnClassifierCount = 0
  private outputTokensAtTurnStart = 0
  private currentTurnTokenBudget: number | null = null
  private budgetContinuationCount = 0

  constructor(private readonly ledger: UsageLedgerOwner) {}

  /** The DUAL write: the ledger total AND the per-turn triple, one call. */
  addToToolDuration(duration: number): void {
    this.ledger.addToolDuration(duration)
    this.turnToolDurationMs += duration
    this.turnToolCount++
  }

  addToTurnHookDuration(duration: number): void {
    this.turnHookDurationMs += duration
    this.turnHookCount++
  }

  resetTurnHookDuration(): void {
    this.turnHookDurationMs = 0
    this.turnHookCount = 0
  }

  resetTurnToolDuration(): void {
    this.turnToolDurationMs = 0
    this.turnToolCount = 0
  }

  addToTurnClassifierDuration(duration: number): void {
    this.turnClassifierDurationMs += duration
    this.turnClassifierCount++
  }

  resetTurnClassifierDuration(): void {
    this.turnClassifierDurationMs = 0
    this.turnClassifierCount = 0
  }

  /** turn output = ledger total output − the turn-boundary snapshot. */
  getTurnOutputTokens(): number {
    return this.ledger.getTotalOutputTokens() - this.outputTokensAtTurnStart
  }

  getCurrentTurnTokenBudget(): number | null {
    return this.currentTurnTokenBudget
  }

  /** The turn boundary: latch the output floor + budget, zero continuation. */
  snapshotOutputTokensForTurn(budget: number | null): void {
    this.outputTokensAtTurnStart = this.ledger.getTotalOutputTokens()
    this.currentTurnTokenBudget = budget
    this.budgetContinuationCount = 0
  }

  getBudgetContinuationCount(): number {
    return this.budgetContinuationCount
  }

  incrementBudgetContinuationCount(): void {
    this.budgetContinuationCount++
  }
}
