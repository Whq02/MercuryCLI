import type { CanUseToolFn } from '../Tool.js'
import { FRESH_OVERFLOW_EPISODE } from '../services/compact/overflowRecovery.js'
import type { ToolUseContext } from '../Tool.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'
import type {
  Message,
  RefusedToolCall,
} from '../types/message.js'
import {
  memoryWriteLostNotice,
  memoryWriteRefusals,
} from '../services/providers/toolCallGate.js'
import { createSystemMessage } from '../services/messages.js'
import type { QuerySource } from '../constants/querySource.js'
import { memorySignalScope } from '../mneme/mnemeSignal.js'
import { productionDeps, type QueryDeps } from '../query/deps.js'
import type { Terminal } from '../query/transitions.js'
import { BudgetGuard } from './budget-guard.js'
import { createEventMint, type RunEvent } from './events.js'
import { afterTools } from './turn/afterTools.js'
import { makeRequest } from './turn/makeRequest.js'
import { modelReply } from './turn/modelReply.js'
import { noToolReply } from './turn/noToolReply.js'
import { runToolCalls } from './turn/runToolCalls.js'
import type { IterationState, RunCtx, SettledDecision, TurnState, TurnStep } from './turn/state.js'
import { notBuilt } from '../pi/holes.js'

export {
  PAUSE_TURN_CONTINUATION_LIMIT,
  decideCutToolCallRecovery,
  decideEmptyReplyRecovery,
  decidePauseTurnContinuation,
  decideReasoningOnlyRecovery,
  decideStreamFaultRecovery,
  decideToolCallRefusalRecovery,
  type CutToolCallDecision,
} from './turn/judgements.js'
export { MAX_TURNS_CLOSING_TEXT } from './turn/afterTools.js'

export type ComposedPrompt = { systemPrompt: SystemPrompt; userContext: { [k: string]: string }; systemContext: { [k: string]: string } }

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  recompose?: () => Promise<ComposedPrompt>
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  deps?: QueryDeps
}

export async function* runEventCore(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<RunEvent, Terminal> {
  return notBuilt('src/run-core/turn-machine.ts:59')
}

const STEPS_BEFORE_THE_LAST: readonly TurnStep[] = [modelReply, noToolReply, runToolCalls]

async function* settleTurn(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, SettledDecision> {
  for (const step of STEPS_BEFORE_THE_LAST) {
    const decision = yield* step(run, iter)
    if (decision.kind !== 'go_on') return decision
  }
  return yield* afterTools(run, iter)
}
