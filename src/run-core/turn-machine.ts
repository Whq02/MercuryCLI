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
import { runAgentLoop } from '../pi/loop/agent-loop.js'

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
  return yield* memorySignalScope(runTurns(params, consumedCommandUuids))
}

const STEPS_BEFORE_THE_LAST: readonly TurnStep[] = [modelReply, noToolReply, runToolCalls]

async function* settleTurn(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, SettledDecision> {
  for (const step of STEPS_BEFORE_THE_LAST) {
    const decision = yield* step(run, iter)
    if (decision.kind !== 'go_on') return decision
  }
  return yield* afterTools(run, iter)
}

function createRunCtx(params: QueryParams, consumedCommandUuids: string[]): RunCtx {
  const run: RunCtx = {
    params,
    querySource: params.querySource,
    fallbackModel: params.fallbackModel,
    skipCacheWrite: params.skipCacheWrite,
    consumedCommandUuids,
    systemPrompt: params.systemPrompt,
    systemContext: params.systemContext,
    userContext: params.userContext,
    deps: params.deps ?? productionDeps(),
    emit: createEventMint(),
    budgetGuard: new BudgetGuard(),
    awaitingReply: [],
    announcedStepNudges: 0,
    checkpointSettleWarned: false,
    pendingMemoryWrites: [],
    holdMemoryWriteRefusals: refused => {
      for (const refusal of memoryWriteRefusals(refused)) {
        const held = run.pendingMemoryWrites.some(pending => pending.id === refusal.id && pending.argumentsRaw === refusal.argumentsRaw)
        if (!held) run.pendingMemoryWrites.push(refusal)
      }
    },
    memoryWriteLostEvent: () => {
      if (run.pendingMemoryWrites.length === 0) return null
      const message = createSystemMessage(memoryWriteLostNotice(run.pendingMemoryWrites), 'error')
      run.pendingMemoryWrites.length = 0
      return run.emit({ kind: 'notice', message })
    },
  }
  return run
}

function firstTurnOf(params: QueryParams): TurnState {
  return {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    turnCount: 1,
    transition: undefined,
    stopHookActive: undefined,
    autoCompactTracking: undefined,
    overflowEpisode: FRESH_OVERFLOW_EPISODE,
    pendingOverflow: undefined,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    maxOutputTokensRecoveryCount: 0,
    streamFaultRecoveryCount: 0,
    toolCallRefusalRecoveryCount: 0,
  }
}

async function* runTurn(run: RunCtx, state: TurnState, ordinal: number): AsyncGenerator<RunEvent, SettledDecision> {
  const request = yield* makeRequest(run, state, ordinal)
  return request.kind === 'go_on' ? yield* settleTurn(run, request.iter) : request
}

async function* runTurns(params: QueryParams, consumedCommandUuids: string[]): AsyncGenerator<RunEvent, Terminal> {
  const run = createRunCtx(params, consumedCommandUuids)
  return yield* runAgentLoop({
    emit: run.emit,
    querySource: params.querySource,
    agentId: params.toolUseContext.agentId,
    firstTurn: firstTurnOf(params),
    runTurn: (state: TurnState, ordinal) => runTurn(run, state, ordinal),
  })
}
