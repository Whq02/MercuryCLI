import type { ToolUseBlock } from '../../message-shapes/wire.js'
import type { AutoCompactTrackingState } from '../../compaction/autoFold.js'
import type {
  OverflowEpisode,
  OverflowRung,
} from '../../compaction/overflowRecovery.js'
import type { OverflowSignal } from '../../requests/overflowSignal.js'
import type { ToolCallChain, ToolUseContext } from '../../../tools/kit/tool.js'
import type { SystemPrompt } from '../../system-prompt/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ReplyMark,
  UserMessage,
  RefusedToolCall,
} from '../../message-shapes/message.js'
import { trimChantedReplyMessages, type ChantDetection } from '../../tool-dispatch/chantGuard.js'
import type { QuerySource } from '../../requests/querySource.js'
import type { EarlyStarts } from '../../tool-dispatch/earlyStarts.js'
import type { RequestContextPlan } from '../../run/requestContextPlan.js'
import type { QueryDeps } from '../../turn-entry/turnLoopDeps.js'
import type { Terminal, Continue } from '../../turn-entry/transitions.js'
import type { BudgetGuard } from '../budget-guard.js'
import type { createEventMint, RunEvent } from '../events.js'
import type { QueryParams } from '../turn-machine.js'

export type EventMint = ReturnType<typeof createEventMint>

export type TurnState = {
  messages: Message[]
  toolUseContext: ToolUseContext
  turnCount: number
  transition: Continue | undefined
  stopHookActive: boolean | undefined
  autoCompactTracking: AutoCompactTrackingState | undefined
  overflowEpisode: OverflowEpisode
  pendingOverflow: { signal: OverflowSignal; rung: OverflowRung } | undefined
  maxOutputTokensOverride: number | undefined
  lastOutputLimitReply?: string
  chantRecoveryCount?: number
  cutToolCallRecoveryCount?: number
  emptyReplyRecoveryCount?: number
  maxOutputTokensRecoveryCount: number
  pauseTurnContinuations?: number
  reasoningOnlyRecoveryCount?: number
  streamFaultRecoveryCount: number
  toolCallRefusalRecoveryCount: number
}

export type RunCtx = {
  params: QueryParams
  querySource: QuerySource
  fallbackModel: string | undefined
  skipCacheWrite: boolean | undefined
  consumedCommandUuids: string[]
  systemPrompt: SystemPrompt
  systemContext: { [k: string]: string }
  userContext: { [k: string]: string }
  deps: QueryDeps
  emit: EventMint
  budgetGuard: BudgetGuard
  awaitingReply: ReplyMark[]
  announcedStepNudges: number
  checkpointSettleWarned: boolean
  pendingMemoryWrites: RefusedToolCall[]
  holdMemoryWriteRefusals: (refused: readonly RefusedToolCall[]) => void
  memoryWriteLostEvent: () => RunEvent | null
}

export type IterationState = {
  state: TurnState
  turnId: string
  requestPlan: RequestContextPlan
  messagesForQuery: Message[]
  toolUseContext: ToolUseContext
  callChain: ToolCallChain
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

export type NextTurn = TurnState & { transition: Continue }

export type SettledDecision = { kind: 'hand_over'; next: NextTurn } | { kind: 'end'; terminal: Terminal }

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
