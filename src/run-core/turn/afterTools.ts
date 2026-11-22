import { FRESH_OVERFLOW_EPISODE } from '../../services/compact/overflowRecovery.js'
import type { ToolUseContext } from '../../Tool.js'
import type { RunEvent } from '../events.js'
import type { IterationState, NextTurn, RunCtx, SettledDecision } from './state.js'
import { notBuilt } from '../../pi/holes.js'

export const MAX_TURNS_CLOSING_TEXT =
  'The turn budget is spent: no further tool call will run. Answer in text only — what was done, what was found, and what remains.'

function refreshTurnTools(context: ToolUseContext): ToolUseContext {
  const { options } = context
  if (!options.refreshTools) return context
  const tools = options.refreshTools()
  if (tools === options.tools) return context
  return { ...context, options: { ...options, tools } }
}

export async function* afterTools(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, SettledDecision> {
  return notBuilt('src/run-core/turn/afterTools.ts:105')
}
