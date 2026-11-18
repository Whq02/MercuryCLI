import type { ToolUseBlock } from '../../types/wire.js'
import type { AutoCompactTrackingState } from '../../services/compact/autoCompact.js'
import type {
  OverflowEpisode,
  OverflowRung,
} from '../../services/compact/overflowRecovery.js'
import type { OverflowSignal } from '../../services/api/overflowSignal.js'
import type { ToolCallChain, ToolUseContext } from '../../Tool.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ReplyMark,
  ToolUseSummaryMessage,
  UserMessage,
  RefusedToolCall,
} from '../../types/message.js'
import {
  trimChantedReplyMessages,
  type ChantDetection,
} from '../../services/tools/chantGuard.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { EarlyStarts } from '../../services/tools/earlyStarts.js'
import type { RequestContextPlan } from '../../services/run/requestContextPlan.js'
import type { QueryConfig } from '../../query/config.js'
import type { QueryDeps } from '../../query/deps.js'
import type { Terminal, Continue } from '../../query/transitions.js'
import type { BudgetGuard } from '../budget-guard.js'
import type { createEventMint, RunEvent } from '../events.js'
import type { QueryParams } from '../turn-machine.js'

export type EventMint = ReturnType<typeof createEventMint>

export type TurnState = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  lastOutputLimitReply?: string
  maxOutputTokensOverride: number | undefined
  streamFaultRecoveryCount: number
  toolCallRefusalRecoveryCount: number
  cutToolCallRecoveryCount?: number
  pauseTurnContinuations?: number
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
  emptyReplyRecoveryCount?: number
  chantRecoveryCount?: number
  reasoningOnlyRecoveryCount?: number
  overflowEpisode: OverflowEpisode
  pendingOverflow: { signal: OverflowSignal; rung: OverflowRung } | undefined
}

export type RunCtx = {
  params: QueryParams
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  fallbackModel: string | undefined
  querySource: QuerySource
  skipCacheWrite: boolean | undefined
  deps: QueryDeps
  config: QueryConfig
  budgetGuard: BudgetGuard
  emit: EventMint
  consumedCommandUuids: string[]
  checkpointSettleWarned: boolean
  announcedStepNudges: number
  awaitingReply: ReplyMark[]
  pendingMemoryWrites: RefusedToolCall[]
  holdMemoryWriteRefusals: (refusals: readonly RefusedToolCall[]) => void
  memoryWriteLostEvent: () => RunEvent | null
}

export type IterationState = {
  state: TurnState
  turnId: string
  ordinal: number
  requestPlan: RequestContextPlan
  messagesForQuery: Message[]
  toolUseContext: ToolUseContext
  callChain: ToolCallChain
  chainIdForAnalytics: string
  tracking: AutoCompactTrackingState | undefined
  fullSystemPrompt: SystemPrompt
  appState: ReturnType<ToolUseContext['getAppState']>
  currentModel: string
  maxOutputTokensOverride: number | undefined
  assistantMessages: AssistantMessage[]
  toolResults: (UserMessage | AttachmentMessage)[]
  thinkingRecords: AttachmentMessage[]
  toolUseBlocks: ToolUseBlock[]
  needsFollowUp: boolean
  closingTurn: boolean
  callOrdinal: number
  replyTo: ReplyMark[]
  early: EarlyStarts
  streamChant?: ChantDetection
  overflowEpisode: OverflowEpisode
  allRefusedToolCalls: RefusedToolCall[]
  refusedToolCalls: RefusedToolCall[]
  answeredRefusalIds: Set<string>
  shouldPreventContinuation: boolean
  loopStoppedCycle: string[] | null
  loopStoppedRecord: Message | null
  updatedToolUseContext: ToolUseContext
}

export type SettledDecision = { kind: 'hand_over'; next: TurnState } | { kind: 'end'; terminal: Terminal }

export type TurnDecision = { kind: 'go_on' } | SettledDecision

export type RequestDecision = { kind: 'go_on'; iter: IterationState } | SettledDecision

export type TurnStep = (run: RunCtx, iter: IterationState) => AsyncGenerator<RunEvent, TurnDecision>

export function* trimChantedIteration(iter: IterationState, detection: ChantDetection, emit: EventMint): Generator<RunEvent> {
  const cleaned = trimChantedReplyMessages(iter.assistantMessages, detection)
  for (const message of iter.assistantMessages) {
    if (!cleaned.includes(message)) yield emit({ kind: 'assistant_retracted', message })
  }
  for (const message of cleaned) {
    if (!iter.assistantMessages.includes(message)) yield emit({ kind: 'assistant_settled', callId: `${iter.turnId}.c${iter.callOrdinal}`, message, withheld: false })
  }
  iter.assistantMessages.splice(0, iter.assistantMessages.length, ...cleaned)
}
