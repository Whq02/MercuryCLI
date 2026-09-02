// ============================================================================
//  run-core/budget-guard.ts — T8: the budget owner.
//
//  One owner for the three budget families the loop would otherwise thread through
//  scattered locals (prove-runloop-contract pins each):
//
//  • TASK BUDGET — the operator's "+500k"-style token target. The remaining
//    figure carries ACROSS compactions: each boundary subtracts the
//    pre-compact final context window (iterations[-1] is the authoritative
//    window, post server-tool loops — #304930) from the running remainder,
//    clamped at zero. Both the proactive (auto) and reactive (413) paths
//    apply the SAME carryover. The callModel request bag gets {total,
//    remaining} — remaining only once a carryover has happened (the
//    request-contract law digests this shape).
//
//  • MAX TURNS — the cap check at the two exits (the abort path counts the
//    turn in flight; the natural path checks before continuing).
//
//  • TOKEN BUDGET — the +500k auto-continue tracker was hardwired OFF and
//    its pure module (query/tokenBudget.ts) went unreachable when the T8
//    TurnMachine dropped the dead imports — DELETED with the cut. The
//    `token_budget_continuation` transition stays documented in
//    query/transitions.ts: the vocabulary is deliberately wider than the
//    live machine — characterized, not resurrected.
// ============================================================================

export type TaskBudgetParam = { total: number } | undefined

export class BudgetGuard {
  private readonly taskBudget: TaskBudgetParam
  private remaining: number | undefined = undefined

  constructor(taskBudget: TaskBudgetParam) {
    this.taskBudget = taskBudget
  }

  /** A compaction boundary: subtract the pre-compact final window from the
   *  running remainder (first boundary starts from the total). */
  applyCompactionCarryover(preCompactContextTokens: number): void {
    if (!this.taskBudget) return
    this.remaining = Math.max(
      0,
      (this.remaining ?? this.taskBudget.total) - preCompactContextTokens,
    )
  }

  /** The callModel request bag — undefined when no budget was set. */
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
    // A cap is a POSITIVE INTEGER or absent (FC-078): the old truthiness
    // test let 0 and NaN remove the cap entirely and made a negative fire
    // on the first turn. The --max-turns door refuses junk loudly; this
    // guard is the belt for programmatically supplied values (junk caps
    // nothing rather than inverting).
    if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns <= 0) {
      return false
    }
    return turnCount > maxTurns
  }
}
