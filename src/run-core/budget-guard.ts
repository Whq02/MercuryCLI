
export type TaskBudgetParam = { total: number } | undefined

export class BudgetGuard {
  private readonly taskBudget: TaskBudgetParam
  private remaining: number | undefined = undefined

  constructor(taskBudget: TaskBudgetParam) {
    this.taskBudget = taskBudget
  }

  applyCompactionCarryover(preCompactContextTokens: number): void {
    if (!this.taskBudget) return
    this.remaining = Math.max(
      0,
      (this.remaining ?? this.taskBudget.total) - preCompactContextTokens,
    )
  }

  requestBag(): { total: number; remaining?: number } | undefined {
    if (!this.taskBudget) return undefined
    return {
      total: this.taskBudget.total,
      ...(this.remaining !== undefined && { remaining: this.remaining }),
    }
  }

  taskBudgetRemaining(): number | undefined {
    return this.remaining
  }

  maxTurnsExceeded(turnCount: number, maxTurns: number | undefined): boolean {
    if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns <= 0) {
      return false
    }
    return turnCount > maxTurns
  }
}
