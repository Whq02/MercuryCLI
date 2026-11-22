import { queryEvents } from '../../query.js'
import type { Terminal } from '../../query/transitions.js'
import type { RunEvent } from '../../run-core/events.js'
import { legacyYieldsOf } from '../../run-core/project-legacy.js'
import type { QueryParams } from '../../run-core/turn-machine.js'
import { retryReasonWords } from '../../services/providers/streamIdleBudget.js'
import { EMPTY_USAGE, type NonNullableUsage } from '../../utils/api/emptyUsage.js'
import { accumulateUsage, updateUsage } from '../../services/providers/anthropic/cacheAndUsage.js'
import type { AssistantMessage, CompactMetadata, Message, SystemCloseUsageMessage } from '../../types/message.js'
import type { ApiStreamEvent } from '../../types/wire.js'
import { isBareMode } from '../../utils/envUtils.js'
import { type getInMemoryErrors, logError } from '../../utils/log.js'
import type { HookAttachment } from '../../utils/attachments/types.js'
import { resolveModelPricing } from '../../services/usage/modelCost.js'
import { getTokenUsage, messageContextFill } from '../../services/context/tokens.js'
import { getTotalCostUSD } from '../../bootstrap/state.js'
import { advanceLedgerMark } from '../../utils/ledgerMark.js'
import { noteRunPhase } from '../../utils/runPhases.js'
import { flushSessionStorage, recordTranscript } from '../../utils/sessionStorage.js'
import { recordTurnStart, settleTranscriptMessage } from '../../utils/sessionStorage/writer.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { compactionEndedRow, noticeRow, partialRowsOf, retractedRow, retryWaitRow, toolResultRowsOf, type OutcomeFacts, type RowDraft, type RowScope } from '../project.js'
import { budgetCannotPaySentence, OUTCOME_SENTENCES } from '../vocabulary.js'
import { recoveryKindOf, type RecoveryKind } from '../vocabulary.js'
import type { StepLedger } from './steps.js'
import type { messageRowsOf } from './messageRows.js'
import type { latestAnswerOf } from './answer.js'
import type { openCallsCutter } from './cut.js'
import { closeRowOf } from './close.js'
import type { ConversationState } from './state.js'
import type { ConversationConfig } from '../turn.js'
import type { turnEnder } from './end.js'
import { settledTurnRows } from './settle.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

const DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES = 5


function inputFloorUsd(messages: readonly Message[], model: string): number | null {
  const pricing = resolveModelPricing(model)
  if (pricing.basis !== 'recorded' && pricing.basis !== 'floor') return null
  if (messageContextFill(messages, model).source !== 'usage') return null
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (!usage) continue
    const carried = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    return (carried * Math.min(pricing.costs.promptCacheReadTokens, pricing.costs.inputTokens)) / 1e6
  }
  return null
}

interface ModelNeeds {
  queryParams: QueryParams
  config: ConversationConfig
  toolOutcomes: Map<string, 'ok' | 'error' | 'aborted'>
  recoveries: Array<{ kind: RecoveryKind }>
  scope: RowScope
  openCalls: Map<string, string>
  persistenceDisabled: boolean
  turnMessages: Message[]
  recordDelta: () => Promise<void>
  eagerFlush: boolean
  steps: StepLedger
  cutOpenCalls: ReturnType<typeof openCallsCutter>
  endTurn: ReturnType<typeof turnEnder>
  effectiveModel: string
  trackCalls: (rows: RowDraft[]) => RowDraft[]
  rowsOfMessage: ReturnType<typeof messageRowsOf>
  hookNoticeRows: (hookRow: HookAttachment) => RowDraft[]
  latestAnswer: ReturnType<typeof latestAnswerOf>
  ledgerAtStart: Parameters<typeof advanceLedgerMark>[0]
  turnStartedAt: number
  notices: Array<{ level: 'warning' | 'error'; text: string }>
  messages: Message[]
  turnId: string
  maxTimeReached: () => boolean
  timeLimitFacts: () => Partial<OutcomeFacts>
  syntheticCallsBeforeTurn: number
  seedMessages: Set<Message>
  denialsBefore: number
  errorWatermark: ReturnType<typeof getInMemoryErrors>[number] | undefined
  captureStopReason: (reason: string) => void
  capturedStopReasonNow: () => string | null
  recoveredUnansweredAskNow: () => boolean
}

export async function* modelTurnRows(this: ConversationState, needs: ModelNeeds): AsyncGenerator<RowDraft> {
  return notBuilt('src/rows/turn/modelRows.ts:88')
}
