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

  getTurnOutputTokens(): number {
    return this.ledger.getTotalOutputTokens() - this.outputTokensAtTurnStart
  }

  getCurrentTurnTokenBudget(): number | null {
    return this.currentTurnTokenBudget
  }

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
