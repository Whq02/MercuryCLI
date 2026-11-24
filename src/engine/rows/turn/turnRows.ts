import { randomUUID } from 'node:crypto'
import { getSessionId, isSessionPersistenceDisabled } from '../../../boot/process-state/processState.js'
import type { TurnParams } from '../../loop/turn-machine.js'
import type { Message } from '../../message-shapes/message.js'
import type { ContentBlockParam } from '../../message-shapes/wire.js'
import { createAttachmentMessage } from '../../attachments/turnAttachments.js'
import { droppedMentionLine } from '../../attachments/fileAttachments.js'
import { getQueuedCommandAttachments } from '../../attachments/queuedCommands.js'
import { createGetAppStateWithAllowedTools } from '../../../crew/agents/forkedAgent.js'
import { isBareMode, isEnvTruthy } from '../../../platform/environment/envUtils.js'
import { fileHistoryMakeSnapshot } from '../../../tools/engines/change-transaction/fileHistory.js'
import { headlessProfilerCheckpoint } from '../../../platform/logs/headlessProfiler.js'
import { forgetWardFirings } from '../../../permissions/guards/wardsGuard.js'
import { getInMemoryErrors, logError } from '../../../platform/logs/errorLog.js'
import type { DroppedImageAttachment, HookAttachment } from '../../attachment-shapes/attachmentTypes.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import { getModelUsage } from '../../../boot/process-state/processState.js'
import { ledgerMark } from './ledgerMark.js'
import { noteRunPhase } from '../../../platform/logs/runPhases.js'
import { processUserInput } from '../../user-input/processUserInput.js'
import { flushSessionStorage } from '../../../sessions/transcripts/sessionStorage.js'
import { setCwd } from '../../../platform/shell/shellExec.js'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import type { ThinkingConfig } from '../../../models/effort/thinking.js'
import { shouldEnableThinkingByDefault } from '../../../models/effort/thinking.js'
import { noticeRow, outcomeRow, turnStartedRow, type OutcomeFacts, type RowDraft, type RowScope } from '../project.js'
import { HOOK_NOTICE_CODES, MENTION_DROPPED_CODE, OUTCOME_SENTENCES, type OutcomeStatus } from '../vocabulary.js'
import type { RecoveryKind } from '../vocabulary.js'
import { StepLedger } from './steps.js'
import { messageRowsOf } from './messageRows.js'
import { canUseToolKeepingDenials } from './asks.js'
import { systemPromptComposer } from './prompt.js'
import { armTurnGuards } from './guards.js'
import { contextBuilder } from './context.js'
import { latestAnswerOf } from './answer.js'
import { openCallsCutter } from './cut.js'
import { MaxTimeCut } from './settle.js'
import { outcomeFacts } from './outcome.js'
import { turnEnder } from './end.js'
import { commandTurnRows } from './command.js'
import { modelTurnRows, type ModelNeeds } from './modelRows.js'
import type { TurnOptions } from '../turn.js'
import type { ConversationState } from './state.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export async function* turnRows(this: ConversationState, prompt: string | ContentBlockParam[], options?: TurnOptions): AsyncGenerator<RowDraft, void, unknown> {
  const config = this.config
  this.discoveredSkillNames.clear()
  setCwd(config.cwd)
  const persistenceDisabled = isSessionPersistenceDisabled()
  const turnStartedAt = Date.now()
  const modelUsageAtStart = Object.fromEntries(Object.entries(getModelUsage()).map(([model, row]) => [model, { ...row }]))
  const ledgerAtStart = { ...ledgerMark(), modelUsage: modelUsageAtStart }
  const eagerFlush = isEnvTruthy(flagEnv('MERCURY_EAGER_FLUSH'))
  const errorWatermark = getInMemoryErrors().at(-1)
  this.turnOrdinal += 1
  const turnOrdinal = options?.turn ?? this.turnOrdinal
  const turnId = randomUUID()
  this.turnToOpen = turnId
  const promptUuid = options?.uuid ?? randomUUID()
  const scope: RowScope = { session_id: getSessionId(), turn: turnOrdinal }
  const notices: Array<{ level: 'warning' | 'error'; text: string }> = []
  const recoveries: Array<{ kind: RecoveryKind }> = []
  const hookNoticeRows = (hookRow: HookAttachment): RowDraft[] => {
    if (hookRow.outcome !== 'failed' && hookRow.outcome !== 'block' && hookRow.outcome !== 'stop' && hookRow.outcome !== 'notice') return []
    const text = hookRow.outcome === 'failed' || hookRow.outcome === 'notice' ? hookRow.words : `hook ${hookRow.name} ${hookRow.outcome === 'block' ? 'blocked' : 'stopped'} ${hookRow.event}: ${hookRow.words}`
    notices.push({ level: 'warning', text })
    return [noticeRow(scope, 'warning', text, HOOK_NOTICE_CODES[hookRow.outcome])]
  }
  const droppedMentionRow = (dropped: DroppedImageAttachment): RowDraft => {
    const text = droppedMentionLine(dropped)
    notices.push({ level: 'warning', text })
    return noticeRow(scope, 'warning', text, MENTION_DROPPED_CODE)
  }
  const steps = new StepLedger(scope)
  const toolOutcomes = new Map<string, 'ok' | 'error' | 'aborted'>()
  const callScopes = new Map<string, RowScope>()
  const denialsBefore = this.denials.length
  forgetWardFirings(scope.session_id)

  const wrappedCanUseTool = canUseToolKeepingDenials(config, this.denials, this.unansweredAsks)

  const appStateSnapshot = config.getAppState()
  const resolvedModel = this.userSpecifiedModel ?? getEngineModel()
  const thinkingConfig: ThinkingConfig =
    config.thinkingConfig ?? (shouldEnableThinkingByDefault() ? ({ type: 'adaptive' } as ThinkingConfig) : ({ type: 'disabled' } as ThinkingConfig))

  const compose = systemPromptComposer(config, resolvedModel, appStateSnapshot, prompt)
  headlessProfilerCheckpoint('before_getSystemPrompt')
  const promptParts = await compose()
  headlessProfilerCheckpoint('after_getSystemPrompt')
  const systemPrompt = promptParts.systemPrompt

  const sessionId = getSessionId()
  armTurnGuards(config, sessionId)

  const buildContext = contextBuilder({ config, thinkingConfig, turnId, abortController: this.abortController, readFileState: this.readFileState, contentReplacementState: this.contentReplacementState, discoveredSkillNames: this.discoveredSkillNames, loadedNestedMemoryPaths: this.loadedNestedMemoryPaths })
  if (options?.initialNotices?.length) {
    const attachments = await getQueuedCommandAttachments(options.initialNotices, { messages: this.mutableMessages, model: resolvedModel })
    this.mutableMessages.push(...attachments.map(createAttachmentMessage))
    if (!persistenceDisabled) await this.recordDelta(this.mutableMessages)
  }
  let toolUseContext = buildContext(this.mutableMessages, resolvedModel)

  const messageIds = [promptUuid, ...(options?.batchUuids ?? []).filter(uuid => uuid !== promptUuid)]
  yield turnStartedRow(scope, { turnId, messageIds, model: resolvedModel })

  const rowsOfMessage = messageRowsOf({ scope, steps, toolOutcomes, callScopes })

  const syntheticCallsBeforeTurn = this.countSyntheticOutputCalls()
  const priorUuids = new Set<string>(this.mutableMessages.map(message => message.uuid))

  const inputResult = await processUserInput({
    input: prompt,
    syntaxInput: options?.syntaxInput,
    mode: options?.mode ?? 'prompt',
    setToolJSX: () => {},
    context: toolUseContext as Parameters<typeof processUserInput>[0]['context'],
    messages: this.mutableMessages,
    uuid: promptUuid,
    ...(options?.batchUuids !== undefined ? { batchUuids: options.batchUuids } : {}),
    ...(options?.batchTail !== undefined ? { batchTail: options.batchTail } : {}),
    isMeta: options?.isMeta,
    ...(options?.operatorPrompt !== undefined ? { operatorPrompt: options.operatorPrompt } : {}),
    ...(options?.origin !== undefined ? { origin: options.origin } : {}),
    ...(options?.skipSlashCommands === true ? { skipSlashCommands: true } : {}),
    querySource: 'sdk',
    canUseTool: wrappedCanUseTool,
  })

  for (const message of inputResult.messages) {
    if (priorUuids.has(message.uuid) || message.type !== 'attachment') continue
    if (message.attachment.type === 'hook') yield* hookNoticeRows(message.attachment)
    else if (message.attachment.type === 'dropped_image_file') yield droppedMentionRow(message.attachment)
  }
  this.mutableMessages.push(...inputResult.messages)
  let turnMessages: Message[] = [...this.mutableMessages]
  const seedMessages = new Set<Message>(turnMessages)

  if (!persistenceDisabled && inputResult.messages.length > 0) {
    const recordPromise = this.recordDelta(turnMessages)
    if (isBareMode()) {
      void recordPromise
    } else {
      await recordPromise
      if (eagerFlush) await flushSessionStorage()
    }
  } else {
    this.recordCursor = turnMessages.length
  }

  const effectiveModel = inputResult.model ?? resolvedModel
  steps.lastModel = effectiveModel
  toolUseContext = buildContext(turnMessages, effectiveModel)
  toolUseContext.getAppState = createGetAppStateWithAllowedTools(toolUseContext.getAppState, inputResult.allowedTools ?? [])

  let capturedStopReason: string | null = null

  const outcomeFactsOf = (status: OutcomeStatus, extra: Partial<OutcomeFacts> = {}): OutcomeFacts => outcomeFacts.call(this, { ledgerAtStart, modelUsageAtStart, turnId, capturedStopReason, steps, turnStartedAt, recoveries, denialsBefore, notices, scope }, status, extra)
  const openCalls = new Map<string, string>()
  let recoveredUnansweredAsk = false
  const containsUnansweredAsk = (callId: string): boolean => this.denials.slice(denialsBefore).some(denial => {
    if (!this.unansweredAsks.has(denial.call_id)) return false
    const seen = new Set<string>()
    let parent = callScopes.get(denial.call_id)?.parent_call_id
    while (parent !== undefined && !seen.has(parent)) {
      if (parent === callId) return true
      seen.add(parent)
      parent = callScopes.get(parent)?.parent_call_id
    }
    return false
  })
  const cutCalls: string[] = []
  const signal = this.abortController.signal
  const trackCalls = (rows: RowDraft[]): RowDraft[] => {
    for (const row of rows) {
      const call = row as RowDraft & { call_id?: string; tool?: string; status?: string }
      if (call.type === 'tool_call' && call.call_id !== undefined) openCalls.set(call.call_id, call.tool ?? '')
      if (call.type === 'tool_result' && call.call_id !== undefined) {
        const tool = openCalls.get(call.call_id)
        if (this.unansweredAsks.has(call.call_id)) recoveredUnansweredAsk = false
        else if (call.status === 'ok' && tool !== undefined && tool !== 'ToolSearch' && !containsUnansweredAsk(call.call_id)) recoveredUnansweredAsk = true
        if ((call.status === 'aborted' || signal.aborted) && tool !== undefined) cutCalls.push(tool)
        openCalls.delete(call.call_id)
      }
    }
    return rows
  }
  const closeTurn = (status: OutcomeStatus, extra: Partial<OutcomeFacts> = {}) => outcomeRow({ ...scope, turn: turnOrdinal }, outcomeFactsOf(status, extra))
  let timeLimitTimer: ReturnType<typeof setTimeout> | null = null
  const clearTimeLimit = (): void => {
    if (timeLimitTimer !== null) {
      stopTimeout(timeLimitTimer)
      timeLimitTimer = null
    }
  }
  const endTurn = turnEnder.call(this, { clearTimeLimit, closeTurn, turnId, cutCalls, openCalls, sessionId, toolUseContext, persistenceDisabled, turnMessages, scope, inputResult, seedMessages })

  headlessProfilerCheckpoint('turn_row_yielded')
  noteRunPhase('assembly')

  if (!inputResult.shouldQuery) {
    yield* commandTurnRows.call(this, { inputResult, priorUuids, options, scope, prompt, persistenceDisabled, turnMessages, eagerFlush, endTurn })
    return
  }

  if (!persistenceDisabled) {
    const snapshots: Promise<void>[] = []
    for (const message of inputResult.messages) {
      if (message.type !== 'user') continue
      if ((message as { isMeta?: boolean }).isMeta === true) continue
      const uuid = (message as { uuid?: string }).uuid
      if (uuid) {
        snapshots.push(fileHistoryMakeSnapshot(toolUseContext.updateFileHistoryState, uuid as Parameters<typeof fileHistoryMakeSnapshot>[1]).catch((error: unknown) => logError(error)))
      }
    }
    await Promise.all(snapshots)
  }

  const recordDelta = async (): Promise<void> => {
    if (persistenceDisabled) return
    await this.recordDelta(turnMessages)
  }
  const messages = this.mutableMessages
  const latestAnswer = latestAnswerOf(turnMessages)
  const maxTimeReached = (): boolean => config.maxTime !== undefined && Date.now() >= config.maxTime.at
  const timeLimitFacts = (): Partial<OutcomeFacts> => ({ error: { message: OUTCOME_SENTENCES.time_limit({ maxTimeMs: config.maxTime?.limitMs }), class: 'time_limit' } })
  const cutOpenCalls = openCallsCutter({ turnMessages, messages, openCalls, toolOutcomes, persistenceDisabled, recordDelta, trackCalls, rowsOfMessage })
  if (maxTimeReached()) {
    yield* endTurn('time_limit', timeLimitFacts())
    return
  }
  if (config.maxTime !== undefined) {
    const sentence = OUTCOME_SENTENCES.time_limit({ maxTimeMs: config.maxTime.limitMs })
    timeLimitTimer = startTimeout(() => this.abortController.abort(new MaxTimeCut(sentence)), Math.max(0, config.maxTime.at - Date.now()))
    timeLimitTimer.unref?.()
  }

  const queryParams: TurnParams = {
    messages: turnMessages,
    systemPrompt,
    userContext: promptParts.userContext,
    systemContext: promptParts.systemContext,
    recompose: compose,
    canUseTool: wrappedCanUseTool,
    toolUseContext,
    fallbackModel: config.fallbackModel,
    querySource: 'sdk' as TurnParams['querySource'],
    maxTurns: config.maxTurns,
  }

  const captureStopReason = (reason: string): void => {
    capturedStopReason = reason
  }
  const capturedStopReasonNow = (): string | null => capturedStopReason
  const recoveredUnansweredAskNow = (): boolean => recoveredUnansweredAsk
  const needs: ModelNeeds = { queryParams, config, toolOutcomes, recoveries, scope, openCalls, persistenceDisabled, turnMessages, recordDelta, eagerFlush, steps, cutOpenCalls, endTurn, effectiveModel, trackCalls, rowsOfMessage, hookNoticeRows, latestAnswer, ledgerAtStart, turnStartedAt, notices, messages, turnId, maxTimeReached, timeLimitFacts, syntheticCallsBeforeTurn, seedMessages, denialsBefore, errorWatermark, captureStopReason, capturedStopReasonNow, recoveredUnansweredAskNow }
  yield* modelTurnRows.call(this, needs)
}
