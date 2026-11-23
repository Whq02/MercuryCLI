import { queryEvents } from '../../turnDoor.js'
import type { Terminal } from '../../turn-entry/transitions.js'
import type { RunEvent } from '../../loop/events.js'
import { legacyYieldsOf } from '../../loop/project-legacy.js'
import type { QueryParams } from '../../loop/turn-machine.js'
import { retryReasonWords } from '../../../models/roads/streamIdleBudget.js'
import { EMPTY_USAGE, type NonNullableUsage } from '../../request-parts/emptyUsage.js'
import { accumulateUsage, updateUsage } from '../../../models/roads/anthropic/cacheAndUsage.js'
import type { AssistantMessage, CompactMetadata, Message, SystemCloseUsageMessage } from '../../message-shapes/message.js'
import type { ApiStreamEvent } from '../../message-shapes/wire.js'
import { isBareMode } from '../../../platform/environment/envUtils.js'
import { type getInMemoryErrors, logError } from '../../../platform/logs/errorLog.js'
import type { HookAttachment } from '../../attachment-shapes/attachmentTypes.js'
import { resolveModelPricing } from '../../../models/usage/modelCost.js'
import { getTokenUsage, messageContextFill } from '../../context-window/contextTokenCount.js'
import { getTotalCostUSD } from '../../../boot/process-state/processState.js'
import { advanceLedgerMark } from './ledgerMark.js'
import { noteRunPhase } from '../../../platform/logs/runPhases.js'
import { flushSessionStorage, recordTranscript } from '../../../sessions/transcripts/sessionStorage.js'
import { recordTurnStart, settleTranscriptMessage } from '../../../sessions/transcripts/writer.js'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
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
import { passedOver } from '../../../platform/errors/passedOver.js'

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
  const { queryParams, config, toolOutcomes, recoveries, scope, openCalls, persistenceDisabled, turnMessages, recordDelta, eagerFlush, steps, cutOpenCalls, endTurn, effectiveModel, trackCalls, rowsOfMessage, hookNoticeRows, latestAnswer, ledgerAtStart, turnStartedAt, notices, messages, turnId, maxTimeReached, timeLimitFacts, syntheticCallsBeforeTurn, seedMessages, denialsBefore, errorWatermark, captureStopReason, capturedStopReasonNow, recoveredUnansweredAskNow } = needs
  let currentUsage: NonNullableUsage = { ...EMPTY_USAGE }
  let currentStreamMessageId: string | null = null
  let currentStreamModel: string = effectiveModel
  let terminal: Terminal | undefined
  let apiErrorMessage: (AssistantMessage & { error?: string }) | null = null

  for await (const event of queryEvents(queryParams) as AsyncGenerator<RunEvent, unknown, unknown>) {
    noteRunPhase('first_canonical_event')
    config.onLiveness?.()
    if (event.kind === 'run_terminal') {
      terminal = event.terminal
      continue
    }
    if (event.kind === 'tool_settled') toolOutcomes.set(event.toolUseId, event.outcome)
    if (event.kind === 'turn_settled') {
      const recovery = recoveryKindOf(event.transition)
      if (recovery !== undefined) recoveries.push({ kind: recovery })
    }
    if (event.kind === 'assistant_retracted') {
      const withdrawn = (event.message as AssistantMessage).message.id
      if (config.partialRows && typeof withdrawn === 'string') yield retractedRow(scope, withdrawn)
      for (const block of (event.message as AssistantMessage).message.content) {
        if (block.type !== 'tool_use' || !openCalls.delete(block.id) || config.partialRows) continue
        yield* toolResultRowsOf(scope, [{ type: 'tool_result', tool_use_id: block.id, content: '', is_error: true }], () => 'aborted')
      }
      if (!persistenceDisabled) await settleTranscriptMessage({ ...(event.message as AssistantMessage), retracted: true })
      const withdrawnUuid = (event.message as AssistantMessage).uuid
      const held = this.mutableMessages.findIndex(row => row.uuid === withdrawnUuid)
      if (held !== -1) this.mutableMessages.splice(held, 1)
      const inTurn = turnMessages.findIndex(row => row.uuid === withdrawnUuid)
      if (inTurn !== -1) {
        turnMessages.splice(inTurn, 1)
        if (inTurn < this.recordCursor) this.recordCursor--
      }
      continue
    }

    for (const projected of legacyYieldsOf(event)) {
      const kind = (projected as { type?: string }).type
      const message = projected as Message & { subtype?: string }
      let shouldRecord = false
      let isBoundary = false

      switch (kind) {
        case 'stream_request_start': {
          if (!persistenceDisabled && !isBareMode()) {
            await recordDelta()
            await flushSessionStorage().catch(passedOver)
          }
          const floor = config.maxBudgetUsd === undefined ? null : inputFloorUsd(this.mutableMessages, currentStreamModel)
          if (config.maxBudgetUsd !== undefined && floor !== null && getTotalCostUSD() + floor > config.maxBudgetUsd) {
            if (eagerFlush) await flushSessionStorage()
            const open = steps.flush()
            if (open !== null) yield open
            const sentence = budgetCannotPaySentence({ maxBudgetUsd: config.maxBudgetUsd, spentUsd: getTotalCostUSD(), inputFloorUsd: floor })
            yield* cutOpenCalls(sentence)
            yield* endTurn('budget_limit', { error: { message: sentence, class: 'budget_limit' } })
            return
          }
          break
        }
        case 'stream_event': {
          const raw = projected as { type: 'stream_event'; event?: ApiStreamEvent }
          const streamEvent = raw.event
          if (streamEvent?.type === 'message_start') {
            currentUsage = updateUsage(EMPTY_USAGE, streamEvent.message.usage)
            currentStreamMessageId = streamEvent.message.id ?? null
            currentStreamModel = (streamEvent.message as { model?: string }).model ?? effectiveModel
            steps.lastModel = currentStreamModel
          } else if (streamEvent?.type === 'message_delta') {
            currentUsage = updateUsage(currentUsage, streamEvent.usage)
            const deltaStop = streamEvent.delta.stop_reason
            if (deltaStop != null) captureStopReason(deltaStop)
          } else if (streamEvent?.type === 'message_stop') {
            this.accumulatedUsage = accumulateUsage(this.accumulatedUsage, currentUsage)
            if (currentStreamMessageId) {
              this.streamFoldedIds.add(currentStreamMessageId)
              const step = steps.settle(currentStreamMessageId, currentUsage, capturedStopReasonNow())
              if (step !== null) yield step
            }
          }
          if (config.partialRows && streamEvent !== undefined) {
            for (const row of partialRowsOf(scope, currentStreamMessageId ?? '', streamEvent as Parameters<typeof partialRowsOf>[2])) yield row
          }
          break
        }
        case 'assistant': {
          const assistant = projected as AssistantMessage & { isApiErrorMessage?: boolean; error?: string }
          const stopReason = assistant.message.stop_reason
          if (stopReason != null && assistant.isApiErrorMessage !== true) captureStopReason(stopReason)
          if (assistant.isApiErrorMessage === true) apiErrorMessage = assistant
          const providerMessageId = assistant.message.id
          if (providerMessageId) {
            const usage = updateUsage(EMPTY_USAGE, assistant.message.usage)
            this.settledUsageById.set(providerMessageId, usage)
            if (assistant.isApiErrorMessage !== true) {
              const flushed = steps.see(providerMessageId, assistant.message.model ?? currentStreamModel, usage, stopReason ?? null)
              if (flushed !== null) yield flushed
            }
          }
          shouldRecord = true
          break
        }
        case 'user':
          shouldRecord = true
          break
        case 'progress': {
          this.mutableMessages.push(message)
          turnMessages.push(message)
          void recordDelta()
          for (const row of trackCalls(rowsOfMessage(message, undefined))) yield row
          break
        }
        case 'attachment': {
          this.mutableMessages.push(message)
          turnMessages.push(message)
          const attachment = (projected as { attachment?: { type?: string } }).attachment
          const attachmentType = attachment?.type
          if (attachmentType === 'dead_thinking' || attachmentType === 'dropped_thinking' || attachmentType === 'bound_prefix' || attachmentType === 'images_left_out') {
            await recordDelta()
            if (!persistenceDisabled) await flushSessionStorage()
          } else {
            void recordDelta()
          }
          if (attachmentType === 'hook') {
            yield* hookNoticeRows(attachment as HookAttachment)
          } else if (attachmentType === 'structured_output') {
            this.structuredOutput = (attachment as { data?: unknown }).data
          } else if (attachmentType === 'max_turns_reached') {
            if (eagerFlush) await flushSessionStorage()
            const open = steps.flush()
            if (open !== null) yield open
            const closingAnswer = latestAnswer()
            yield* endTurn('turn_limit', { error: { message: OUTCOME_SENTENCES.turn_limit({ maxTurns: config.maxTurns }), class: 'turn_limit' }, ...(closingAnswer !== '' ? { answer: closingAnswer } : {}) })
            return
          } else if (attachmentType === 'loop_stopped') {
            if (eagerFlush) await flushSessionStorage()
            const stopped = attachment as { message?: string; cycle?: string[] }
            const open = steps.flush()
            if (open !== null) yield open
            yield* endTurn('loop_stopped', {
              error: {
                message: OUTCOME_SENTENCES.loop_stopped({ message: stopped.message ?? `The loop guard ended the turn: the cycle ${(stopped.cycle ?? []).join(' -> ')} repeated with identical arguments and results` }),
                class: 'loop_stopped',
                ...(stopped.cycle !== undefined && stopped.cycle.length > 0 ? { detail: stopped.cycle } : {}),
              },
            })
            return
          }
          break
        }
        case 'system': {
          const systemMessage = message
          if (systemMessage.subtype === 'close_usage') {
            const close = systemMessage as SystemCloseUsageMessage
            if (close.spent !== undefined) advanceLedgerMark(ledgerAtStart, close.spent)
            yield closeRowOf(scope, close)
            break
          }
          if (systemMessage.subtype === 'api_error') {
            this.mutableMessages.push(systemMessage)
            turnMessages.push(systemMessage)
            await recordDelta()
            const apiError = systemMessage as { retryAttempt?: number; maxRetries?: number; retryInMs?: number; errorDetail?: { status?: number | null }; error?: { status?: number | null; message?: string } }
            const httpStatus = apiError.errorDetail?.status ?? apiError.error?.status ?? null
            yield retryWaitRow(scope, {
              attempt: apiError.retryAttempt,
              of: apiError.maxRetries,
              reason: retryReasonWords(httpStatus, apiError.error?.message),
              delayMs: apiError.retryInMs,
              httpStatus,
              sinceMs: Date.now() - turnStartedAt,
            })
            break
          }
          if (systemMessage.subtype === 'local_command') {
            shouldRecord = true
            break
          }
          if (systemMessage.subtype !== 'compact_boundary') {
            const level = (systemMessage as { level?: string }).level
            if (systemMessage.subtype === 'informational' && (level === 'warning' || level === 'error')) {
              this.mutableMessages.push(systemMessage)
              turnMessages.push(systemMessage)
              await recordDelta()
              const text = String((systemMessage as { content?: unknown }).content ?? '')
              notices.push({ level, text })
              yield noticeRow(scope, level, text)
              break
            }
            this.mutableMessages.push(systemMessage)
            if (level === 'warning' || level === 'error' || level === 'suggestion' || systemMessage.subtype === 'thinking_note' || systemMessage.subtype === 'stream_cut' || systemMessage.subtype === 'busy_recovery') {
              turnMessages.push(systemMessage)
              await recordDelta()
            }
            if (systemMessage.subtype === 'stream_cut') {
              const text = String((systemMessage as { content?: unknown }).content ?? '')
              notices.push({ level: 'warning', text })
              yield noticeRow(scope, 'warning', text)
            }
            break
          }
          shouldRecord = true
          isBoundary = true
          break
        }
        default:
          break
      }

      if (shouldRecord) {
        if (isBoundary && !persistenceDisabled) {
          const boundaryMeta = (message as { compactMetadata?: { preservedSegment?: { tailUuid?: string } } }).compactMetadata
          const tailUuid = boundaryMeta?.preservedSegment?.tailUuid
          const tailIdx = tailUuid ? this.mutableMessages.findIndex(candidate => (candidate as { uuid?: string }).uuid === tailUuid) : -1
          if (tailIdx !== -1) {
            await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1)).catch((error: unknown) => logError(error))
          }
        }
        messages.push(message)
        turnMessages.push(message)
        if (message.type === 'assistant') {
          void recordDelta()
        } else {
          await recordDelta()
          if (isBoundary && !persistenceDisabled) await recordTurnStart(turnId).catch((error: unknown) => logError(error))
          if (!persistenceDisabled) await flushSessionStorage().catch(passedOver)
        }
      }
      if (kind === 'assistant') {
        for (const row of trackCalls(rowsOfMessage(message, undefined))) yield row
      } else if (kind === 'user') {
        for (const row of trackCalls(rowsOfMessage(message, undefined))) yield row
        config.onToolRoundSettled?.(messages)
      } else if (isBoundary) {
        const boundaryMeta = 'compactMetadata' in message ? (message.compactMetadata as CompactMetadata | undefined) : undefined
        const boundaryIndexStore = this.mutableMessages.length - 1
        this.mutableMessages.splice(0, boundaryIndexStore)
        const boundaryIndexTurn = turnMessages.length - 1
        turnMessages.splice(0, boundaryIndexTurn)
        this.recordCursor = Math.max(0, this.recordCursor - boundaryIndexTurn)
        yield compactionEndedRow(scope, { trigger: boundaryMeta?.trigger ?? (event.kind === 'compaction_boundary' ? event.trigger : 'auto'), tokensBefore: boundaryMeta?.preTokens })
      }

      if (config.maxBudgetUsd !== undefined && getTotalCostUSD() >= config.maxBudgetUsd) {
        if (eagerFlush) await flushSessionStorage()
        const open = steps.flush()
        if (open !== null) yield open
        yield* cutOpenCalls(OUTCOME_SENTENCES.budget_limit({ maxBudgetUsd: config.maxBudgetUsd }))
        yield* endTurn('budget_limit', { error: { message: OUTCOME_SENTENCES.budget_limit({ maxBudgetUsd: config.maxBudgetUsd }), class: 'budget_limit' } })
        return
      }
      const moreStepsAhead = kind === 'user' || isBoundary || (kind === 'assistant' && (message as AssistantMessage).message.content.some(block => block.type === 'tool_use'))
      if (moreStepsAhead && maxTimeReached()) {
        if (eagerFlush) await flushSessionStorage()
        const open = steps.flush()
        if (open !== null) yield open
        yield* cutOpenCalls(OUTCOME_SENTENCES.time_limit({ maxTimeMs: config.maxTime?.limitMs }))
        yield* endTurn('time_limit', timeLimitFacts())
        return
      }
      if (kind === 'user' && config.jsonSchema) {
        const retries = this.countSyntheticOutputCalls() - syntheticCallsBeforeTurn
        const maxRetries = Number.parseInt(flagEnv('MERCURY_STRUCTURED_OUTPUT_RETRIES') ?? String(DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES), 10)
        if (retries >= maxRetries) {
          if (eagerFlush) await flushSessionStorage()
          const open = steps.flush()
          if (open !== null) yield open
          yield* endTurn('schema_unmet', { error: { message: OUTCOME_SENTENCES.schema_unmet({}), class: 'schema_unmet', detail: [`Structured output failed after ${retries} attempts`] } })
          return
        }
      }
    }
  }

  yield* settledTurnRows.call(this, { terminal, eagerFlush, steps, latestAnswer, endTurn, timeLimitFacts, turnMessages, seedMessages, denialsBefore, recoveredUnansweredAsk: recoveredUnansweredAskNow(), notices, apiErrorMessage, errorWatermark, config })
}
