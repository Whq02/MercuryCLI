import type { runToolUse } from '../tools/toolExecution.js'

type RunsAToolCall = typeof runToolUse

let howAToolCallRuns: RunsAToolCall | undefined

export function tellEvalHowAToolCallRuns(run: RunsAToolCall): void {
  howAToolCallRuns = run
}

export const toolCallForEval: RunsAToolCall = (...call) => howAToolCallRuns!(...call)
