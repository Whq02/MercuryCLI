const POLL_MS = 20
const FALLBACK_BUDGET_MS = 5_000

export function rowWaitBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const suiteSeconds = Number(env.MERCURY_SUITE_TIMEOUT ?? '')
  if (Number.isFinite(suiteSeconds) && suiteSeconds > 0) return Math.min(FALLBACK_BUDGET_MS, Math.floor((suiteSeconds * 1000) / 10))
  return FALLBACK_BUDGET_MS
}

export interface RowWait<T> {
  row: T | undefined
  polls: number
  waitedMs: number
  exhausted: boolean
}

export async function waitForRow<T>(read: () => Promise<T | undefined>, budgetMs: number = rowWaitBudgetMs()): Promise<RowWait<T>> {
  const started = Date.now()
  let polls = 0
  for (;;) {
    polls++
    const row = await read()
    const waitedMs = Date.now() - started
    if (row !== undefined) return { row, polls, waitedMs, exhausted: false }
    if (waitedMs >= budgetMs) return { row: undefined, polls, waitedMs, exhausted: true }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}
