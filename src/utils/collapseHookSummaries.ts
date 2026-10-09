import type {
  RenderableMessage,
  StopHookInfo,
  SystemStopHookSummaryMessage,
} from '../types/message.js'

type LabelledSummary = SystemStopHookSummaryMessage & { hookLabel: string }

type RunTally = {
  head: LabelledSummary
  rows: number
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  hasOutput: boolean
  wallClockMs: number
}

function labelledSummaryOf(row: RenderableMessage): LabelledSummary | null {
  if (row.type !== 'system' || row.subtype !== 'stop_hook_summary') return null
  return typeof row.hookLabel === 'string' ? (row as LabelledSummary) : null
}

function openRun(head: LabelledSummary): RunTally {
  return {
    head,
    rows: 1,
    hookCount: head.hookCount,
    hookInfos: [...head.hookInfos],
    hookErrors: [...head.hookErrors],
    preventedContinuation: head.preventedContinuation,
    hasOutput: head.hasOutput,
    wallClockMs: head.totalDurationMs ?? 0,
  }
}

function absorb(run: RunTally, row: LabelledSummary): void {
  run.rows += 1
  run.hookCount += row.hookCount
  run.hookInfos.push(...row.hookInfos)
  run.hookErrors.push(...row.hookErrors)
  run.preventedContinuation ||= row.preventedContinuation
  run.hasOutput ||= row.hasOutput
  run.wallClockMs = Math.max(run.wallClockMs, row.totalDurationMs ?? 0)
}

function settle(run: RunTally): RenderableMessage {
  if (run.rows === 1) return run.head
  return {
    ...run.head,
    hookCount: run.hookCount,
    hookInfos: run.hookInfos,
    hookErrors: run.hookErrors,
    preventedContinuation: run.preventedContinuation,
    hasOutput: run.hasOutput,
    totalDurationMs: run.wallClockMs,
  }
}

export function collapseHookSummaries(
  messages: RenderableMessage[],
): RenderableMessage[] {
  const out: RenderableMessage[] = []
  let run: RunTally | null = null
  for (const row of messages) {
    const summary = labelledSummaryOf(row)
    if (summary && run && run.head.hookLabel === summary.hookLabel) {
      absorb(run, summary)
      continue
    }
    if (run) out.push(settle(run))
    run = summary ? openRun(summary) : null
    if (!summary) out.push(row)
  }
  if (run) out.push(settle(run))
  return out
}
