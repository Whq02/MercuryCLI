
export class BudgetGuard {
  maxTurnsExceeded(turnCount: number, maxTurns: number | undefined): boolean {
    if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns <= 0) {
      return false
    }
    return turnCount > maxTurns
  }
}
