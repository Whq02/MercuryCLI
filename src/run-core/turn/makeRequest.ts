import { LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js'
import { resetSessionEnvNoticeOnCompaction } from '../../tools/shared/sessionEnvNotice.js'
import type { AutoCompactTrackingState } from '../../services/compact/autoCompact.js'
import {
  splitCarriedOperatorTail,
  type OverflowEpisode,
} from '../../services/compact/overflowRecovery.js'
import { advanceToolCallChain, type ToolUseContext } from '../../Tool.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type { AttachmentMessage, Message } from '../../types/message.js'
import { appendSystemContext, firstTurnUserContext } from '../../services/messages/api.js'
import { latestUserContextBody } from '../../utils/attachments/userContext.js'
import { createAttachmentMessage } from '../../services/attachments.js'
import { headlessProfilerCheckpoint } from '../../utils/headlessProfiler.js'
import { tokenCountWithEstimation } from '../../services/context/tokens.js'
import { EarlyStarts } from '../../services/tools/earlyStarts.js'
import { emitCompactionTrace } from '../../utils/observability/invocationTrace.js'
import { flushSessionStorage, recordContentReplacement } from '../../utils/sessionStorage.js'
import { buildRequestContextPlan, type RequestContextPlan } from '../../services/run/requestContextPlan.js'
import { calibrationKeyFor } from '../../services/run/contextCalibration.js'
import { randomUUID, type UUID } from 'node:crypto'
import { requestGaugeFixed } from '../../services/run/requestGauge.js'
import { ERROR_MESSAGE_USER_ABORT } from '../../services/compact/compact.js'
import { toolToAPISchema } from '../../services/messages/api.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { planToolPayloadUnseeded, toolsOnTheWire } from '../../services/providers/toolEconomy.js'
import { localPromptFitRefusal, localPromptFits } from '../../services/providers/local/localCallModel.js'
import { countToolDefinitionTokens, TOOL_TOKEN_COUNT_OVERHEAD } from '../../services/context/analyzeContext.js'
import { tellHowToolDefinitionsAreCounted } from '../../services/messages/toolSearch.js'
import type { QueryDeps } from '../../query/deps.js'
import type { Terminal } from '../../query/transitions.js'
import type { RunEvent } from '../events.js'
import type { IterationState, NextTurn, RequestDecision, RunCtx, SettledDecision, TurnState } from './state.js'
import { notBuilt } from '../../pi/holes.js'

tellHowToolDefinitionsAreCounted(countToolDefinitionTokens, TOOL_TOKEN_COUNT_OVERHEAD)

type Autocompacted = Awaited<ReturnType<QueryDeps['autocompact']>>

type PlannedContext = {
  requestPlan: RequestContextPlan
  messagesForQuery: Message[]
  prunedTokensFreed: number
  thinkingRecords: AttachmentMessage[]
  fullSystemPrompt: SystemPrompt
}

type FoldedContext = {
  kind: 'go_on'
  messagesForQuery: Message[]
  tracking: AutoCompactTrackingState | undefined
  overflowEpisode: OverflowEpisode
  fullSystemPrompt: SystemPrompt
  compactionResult: Autocompacted['compactionResult']
  consecutiveFailures: Autocompacted['consecutiveFailures']
  measuredRawTokenCount: Autocompacted['measuredRawTokenCount']
  compactionRefusal: Autocompacted['refusal']
  foldSplit: ReturnType<typeof splitCarriedOperatorTail>
}

type FittingRequest = {
  kind: 'go_on'
  toolUseContext: ToolUseContext
  appState: ReturnType<ToolUseContext['getAppState']>
  currentModel: string
}

export async function* planContext(run: RunCtx, state: TurnState, toolUseContext: ToolUseContext): AsyncGenerator<RunEvent, PlannedContext> {
  return notBuilt('src/run-core/turn/makeRequest.ts:106')
}

export async function* foldContext(run: RunCtx, state: TurnState, toolUseContext: ToolUseContext, opened: Pick<FoldedContext, 'tracking' | 'overflowEpisode'>, planned: PlannedContext): AsyncGenerator<RunEvent, FoldedContext | SettledDecision> {
  return notBuilt('src/run-core/turn/makeRequest.ts:214')
}

export async function* holdBlockingLimit(run: RunCtx, state: TurnState, toolUseContext: ToolUseContext, planned: PlannedContext, folded: FoldedContext): AsyncGenerator<RunEvent, FittingRequest | SettledDecision> {
  return notBuilt('src/run-core/turn/makeRequest.ts:359')
}

export async function* makeRequest(run: RunCtx, state: TurnState, ordinal: number): AsyncGenerator<RunEvent, RequestDecision> {
  const turnId = `t${ordinal}`
  yield run.emit({ kind: 'turn_started', turnId, n: ordinal })
  if (state.toolUseContext.agentId === undefined) headlessProfilerCheckpoint('query_started')

  const callChain = advanceToolCallChain(state.toolUseContext, run.deps.uuid)
  const toolUseContext: ToolUseContext = { ...state.toolUseContext, callChain }
  const planned = yield* planContext(run, state, toolUseContext)
  const folded = yield* foldContext(run, state, toolUseContext, { tracking: state.autoCompactTracking, overflowEpisode: state.overflowEpisode }, planned)
  if (folded.kind !== 'go_on') return folded
  const fitting = yield* holdBlockingLimit(run, state, toolUseContext, planned, folded)
  if (fitting.kind !== 'go_on') return fitting

  const iter: IterationState = {
    state,
    turnId,
    requestPlan: planned.requestPlan,
    messagesForQuery: folded.messagesForQuery,
    toolUseContext: fitting.toolUseContext,
    callChain,
    tracking: folded.tracking,
    fullSystemPrompt: folded.fullSystemPrompt,
    appState: fitting.appState,
    currentModel: fitting.currentModel,
    maxOutputTokensOverride: state.maxOutputTokensOverride,
    assistantMessages: [],
    toolResults: [],
    thinkingRecords: planned.thinkingRecords,
    toolUseBlocks: [],
    needsFollowUp: false,
    closingTurn: run.budgetGuard.maxTurnsExceeded(state.turnCount, run.params.maxTurns),
    callOrdinal: 0,
    replyTo: run.awaitingReply,
    early: new EarlyStarts(fitting.toolUseContext, run.params.canUseTool),
    overflowEpisode: folded.overflowEpisode,
    allRefusedToolCalls: [],
    refusedToolCalls: [],
    answeredRefusalIds: new Set(),
    shouldPreventContinuation: false,
    loopStoppedCycle: null,
    loopStoppedRecord: null,
    updatedToolUseContext: fitting.toolUseContext,
  }
  return { kind: 'go_on', iter }
}
