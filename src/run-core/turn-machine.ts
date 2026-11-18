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
import { createSystemMessage } from '../utils/messages.js'
import type { QuerySource } from '../constants/querySource.js'
import { memorySignalScope } from '../mneme/mnemeSignal.js'
import { buildQueryConfig } from '../query/config.js'
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

type ContextFacts = Record<string, string>

export type ComposedPrompt = { systemPrompt: SystemPrompt; userContext: ContextFacts; systemContext: ContextFacts }

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: ContextFacts
  systemContext: ContextFacts
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
  return yield* memorySignalScope(runEventMachine(params, consumedCommandUuids))
}

const STEPS_BEFORE_THE_LAST: readonly TurnStep[] = [modelReply, noToolReply, runToolCalls]

async function* settleTurn(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, SettledDecision> {
  for (const step of STEPS_BEFORE_THE_LAST) {
    const decision = yield* step(run, iter)
    if (decision.kind !== 'go_on') return decision
  }
  return yield* afterTools(run, iter)
}

async function* runEventMachine(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<RunEvent, Terminal> {
  const emit = createEventMint()
  const { systemPrompt, userContext, systemContext } = params
  const {
    fallbackModel,
    querySource,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  let state: TurnState = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    streamFaultRecoveryCount: 0,
    toolCallRefusalRecoveryCount: 0,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
    overflowEpisode: FRESH_OVERFLOW_EPISODE,
    pendingOverflow: undefined,
  }

  const budgetGuard = new BudgetGuard()

  const config = buildQueryConfig()

  const pendingMemoryWrites: RefusedToolCall[] = []
  const holdMemoryWriteRefusals = (refusals: readonly RefusedToolCall[]): void => {
    for (const refusal of memoryWriteRefusals(refusals)) {
      if (!pendingMemoryWrites.some(held => held.id === refusal.id && held.argumentsRaw === refusal.argumentsRaw)) pendingMemoryWrites.push(refusal)
    }
  }
  const memoryWriteLostEvent = (): RunEvent | null => {
    if (pendingMemoryWrites.length === 0) return null
    const line = memoryWriteLostNotice(pendingMemoryWrites)
    pendingMemoryWrites.length = 0
    return emit({ kind: 'notice', message: createSystemMessage(line, 'error') })
  }

  const run: RunCtx = {
    params,
    systemPrompt,
    userContext,
    systemContext,
    fallbackModel,
    querySource,
    skipCacheWrite,
    deps,
    config,
    budgetGuard,
    emit,
    consumedCommandUuids,
    checkpointSettleWarned: false,
    announcedStepNudges: 0,
    awaitingReply: [],
    pendingMemoryWrites,
    holdMemoryWriteRefusals,
    memoryWriteLostEvent,
  }

  yield emit({
    kind: 'run_started',
    querySource,
    agentId: params.toolUseContext.agentId,
  })

  let iterationOrdinal = 0

  while (true) {
    const request = yield* makeRequest(run, state, ++iterationOrdinal)
    const settled = request.kind === 'go_on' ? yield* settleTurn(run, request.iter) : request
    if (settled.kind === 'end') return settled.terminal
    state = settled.next
  }
}
