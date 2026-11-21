import type { ToolUseBlock } from '../../types/wire.js'
import { FallbackTriggeredError } from '../../services/api/withRetry.js'
import { backupEngineNoticeLine, engineLadderOf } from '../../services/api/backupEngines.js'
import { swarmPresented, swarmRoad } from '../../services/crewBoard/seam.js'
import {
  classifyThinkingDrops,
  createDroppedThinkingAttachment,
  deadThinkingMarks,
  describePrefixRewrite,
  describeThinkingDrops,
  droppedThinkingMarks,
  freshDrops,
  turnOrdinalOfWirePath,
  inputTransformationsOf,
  marksFromDrops,
  modelSwitchReceipt,
  prefixMarkOf,
  recordPrefixRewriteLedger,
  recordThinkingDropLedger,
  takeRewriteNoticeOnce,
} from '../../services/providers/anthropic/thinkingBinding.js'
import { recordDroppedThinking, takePrefixVerdict, takeSidePrefixVerdict, pendingPrefixVerdict } from '../../services/providers/anthropic/prefixLedger.js'
import { foldCacheUsage } from '../../services/compact/cacheEpoch.js'
import { boundPrefixRecordToEmit } from '../../services/providers/anthropic/boundPrefixRecord.js'
import { logForDebugging } from '../../utils/debug.js'
import { overflowLadderArmed } from '../../services/compact/overflowRecovery.js'
import { overflowSignalOf } from '../../services/api/overflowSignal.js'
import { ImageSizeError } from '../../services/imageValidation.js'
import { ImageResizeError, imagesLeftOutMarked, imagesLeftOutNoticeLine, takeImagesLeftOutReceipt } from '../../utils/imageResizer.js'
import { describeInvalidArgTypeError } from '../../utils/errors.js'
import { findToolByName } from '../../Tool.js'
import {
  effortAdjustedReceiptLine,
  isTurnOwningQuerySource,
} from '../../utils/effort.js'
import type { AssistantMessage } from '../../types/message.js'
import { logError } from '../../utils/log.js'
import {
  createUserMessage,
  createSystemMessage,
  createBusyRecoveryMessage,
  createThinkingNoteMessage,
  createAssistantAPIErrorMessage,
} from '../../services/messages.js'
import { StreamChantWatch } from '../../services/tools/chantGuard.js'
import { prependUserContext, firstTurnUserContext } from '../../services/messages/api.js'
import { latestUserContextBody } from '../../utils/attachments/userContext.js'
import { createAttachmentMessage } from '../../services/attachments.js'
import { reconcileAppliedPlanUsage } from '../../services/run/requestContextPlan.js'
import { calibrationKeyFor } from '../../services/run/contextCalibration.js'
import { bindRequestGauge, settleRequestGauge } from '../../services/run/requestGauge.js'
import { getContextEpoch } from '../../services/run/contextEpochs.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { streamEndReceiptLine } from '../../services/providers/streamIdleBudget.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { recordSentRequest } from '../../services/agents/forkedAgent.js'
import type { Terminal } from '../../query/transitions.js'
import {
  backfillCloneForYield,
  isWithheldMaxOutputTokens,
  resetForRetry,
} from '../model-lane.js'
import { stampReply } from '../attachment-drain.js'
import { buildModelCallReference } from '../call-reference.js'
import type { RunEvent } from '../events.js'
import { operatorPauseGate, pauseGateKeyOf, pauseGateModelWords, pauseGateSeatOf } from '../pauseGate.js'
import { acquireModelPermit, releaseModelPermitByCall } from '../../services/capacity/governor.js'
import { refreshGovernorCeilings } from '../../services/capacity/composeCeilings.js'
import type { PrefixVerdict } from '../../services/providers/anthropic/prefixLedger.js'
import type { EventMint, IterationState, RunCtx } from './state.js'

const switchReceipts = new Set<string>()

const responsesClassified = new Set<string>()
const streamEndsReceipted = new Set<string>()
const effortAdjustmentsReceipted = new Set<string>()
const busyRecoveriesReceipted = new Set<string>()
const RESPONSES_CLASSIFIED_CAP = 64
function rememberClassifiedResponse(id: string): void {
  responsesClassified.add(id)
  while (responsesClassified.size > RESPONSES_CLASSIFIED_CAP) {
    const oldest = responsesClassified.values().next().value
    if (oldest === undefined) break
    responsesClassified.delete(oldest)
  }
}

export function* emitSyntheticSettlements(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
  outcome: 'error' | 'aborted',
  emit: EventMint,
): Generator<RunEvent> {
  for (const assistantMessage of assistantMessages) {
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    for (const toolUse of toolUseBlocks) {
      yield emit({
        kind: 'tool_settled',
        toolUseId: toolUse.id,
        outcome,
        synthetic: true,
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: errorMessage,
              is_error: true,
              tool_use_id: toolUse.id,
            },
          ],
          toolUseResult: errorMessage,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      })
    }
  }
}

type StreamOutcome =
  | { kind: 'streamed' }
  | { kind: 'terminal'; terminal: Terminal }

type ModelCall = {
  callId: string
  effortValue: IterationState['appState']['effortValue']
  callReference: ReturnType<typeof buildModelCallReference>
  streamController: AbortController
}

export async function* waitForModelPermit(run: RunCtx, iter: IterationState, emit: EventMint): AsyncGenerator<RunEvent, { callId: string; permitKey: string } | null> {
  const { toolUseContext } = iter
  if (operatorPauseGate.holds(pauseGateKeyOf(toolUseContext))) {
    toolUseContext.onSeatWait?.(pauseGateModelWords())
    await operatorPauseGate.park(toolUseContext.abortController.signal, pauseGateSeatOf(toolUseContext), pauseGateKeyOf(toolUseContext))
    toolUseContext.onSeatWait?.(null)
    if (toolUseContext.abortController.signal.aborted) return null
  }
  const callId = `${iter.turnId}.c${++iter.callOrdinal}`
  const permitKey = `${iter.callChain.key}:${callId}`
  refreshGovernorCeilings(iter.currentModel, iter.appState.effortValue)
  let permit: Awaited<ReturnType<typeof acquireModelPermit>>
  try {
    permit = await acquireModelPermit({
      lane:
        toolUseContext.agentId !== undefined
          ? 'background-session'
          : isTurnOwningQuerySource(run.querySource)
            ? 'foreground'
            : 'service',
      callId: permitKey,
      ...(toolUseContext.seatHolder !== undefined ? { holder: toolUseContext.seatHolder } : {}),
      signal: toolUseContext.abortController.signal,
      ...(toolUseContext.onSeatWait !== undefined ? { onWait: toolUseContext.onSeatWait } : {}),
    })
  } catch (waitError) {
    if (toolUseContext.abortController.signal.aborted) return null
    throw waitError
  }
  let handedOn = false
  try {
    yield emit({
      kind: 'model_permit',
      callId,
      lane: permit.lane,
      waitedMs: permit.waitedMs,
      reacquired: permit.reacquired,
    })
    handedOn = true
  } finally {
    if (!handedOn) releaseModelPermitByCall(permitKey)
  }
  return { callId, permitKey }
}

export function* announceModelCall(iter: IterationState, emit: EventMint, callId: string): Generator<RunEvent, Pick<ModelCall, 'effortValue' | 'callReference'>> {
  const { toolUseContext } = iter
  const effortValue = iter.appState.effortValue
  const callReference = buildModelCallReference({
    model: iter.currentModel,
    effort: effortValue,
    maxOutputTokensOverride: iter.maxOutputTokensOverride,
    tools: toolUseContext.options.tools,
  })
  yield emit({
    kind: 'model_call_started',
    callId,
    model: iter.currentModel,
    effort: effortValue,
    maxOutputTokensOverride: iter.maxOutputTokensOverride,
    reference: callReference,
  })
  {
    const receipt = modelSwitchReceipt(
      String(ownerFromToolUseContext(toolUseContext)),
      iter.messagesForQuery,
      iter.currentModel,
    )
    if (receipt !== null && !switchReceipts.has(receipt.key)) {
      switchReceipts.add(receipt.key)
      logForDebugging(`preserved thinking: ${receipt.text}`)
      yield emit({ kind: 'notice', message: createSystemMessage(receipt.text, 'suggestion') })
    }
  }
  return { effortValue, callReference }
}

type ReplySettling = {
  callId: string
  projectedReplies: Map<string, AssistantMessage>
  settleGauge: (message: AssistantMessage) => void
  fixedPrefix: PrefixVerdict['fixedPrefix']
}

export function* classifyDroppedThinking(run: RunCtx, iter: IterationState, emit: EventMint, settling: ReplySettling, message: AssistantMessage): Generator<RunEvent> {
  const { toolUseContext } = iter
  if (!responsesClassified.has(message.message.id)) {
    rememberClassifiedResponse(message.message.id)
    const allDrops = inputTransformationsOf(message.message)
    const prefixVerdict = isTurnOwningQuerySource(run.querySource)
      ? takePrefixVerdict(String(rosterOwnerFromToolUseContext(toolUseContext)))
      : takeSidePrefixVerdict(String(rosterOwnerFromToolUseContext(toolUseContext)))
    settling.fixedPrefix = prefixVerdict?.fixedPrefix
    if (allDrops.length > 0) recordDroppedThinking(String(rosterOwnerFromToolUseContext(toolUseContext)), allDrops)
    const strippedMarks = deadThinkingMarks(iter.messagesForQuery)
    const drops = freshDrops(allDrops, prefixVerdict?.wireMessageIds ?? [], strippedMarks, droppedThinkingMarks(iter.messagesForQuery))
    if (drops.length < allDrops.length) logForDebugging(`preserved thinking: the API dropped ${allDrops.length - drops.length} already-dropped block(s) again; they stay on the wire unbilled and the cached prefix stands`)
    const rewrite = prefixVerdict?.mismatch ?? null
    const outcome = classifyThinkingDrops(
      String(ownerFromToolUseContext(toolUseContext)),
      drops,
      prefixMarkOf(
        iter.messagesForQuery,
        iter.currentModel,
        { permissionMode: toolUseContext.getAppState().toolPermissionContext.mode },
        { requestPlan: iter.requestPlan },
      ),
      { byteMoved: rewrite !== null },
    )
    if (rewrite !== null && outcome.kind !== 'none' && outcome.lawful === null) outcome.part = rewrite.part
    const recordBehind = prefixVerdict?.behind ?? 0
    if (recordBehind > 0 && outcome.kind !== 'none' && outcome.lawful === null) outcome.behind = recordBehind
    const dropNotice = describeThinkingDrops(drops, outcome, turnOrdinalOfWirePath(outcome.path, prefixVerdict?.wireMessageIds ?? [], iter.messagesForQuery))
    if (outcome.kind !== 'none') {
      recordThinkingDropLedger(outcome, iter.currentModel, dropNotice)
      logForDebugging(`preserved thinking: ${JSON.stringify(drops)}`, { level: 'warn' })
    }
    if (dropNotice !== null) {
      const lawful = outcome.kind === 'lawful'
      logForDebugging(`preserved thinking: ${lawful ? 'note' : 'warning'}: ${dropNotice}`)
      yield emit({ kind: 'notice', message: createThinkingNoteMessage(dropNotice, lawful ? 'info' : 'warning') })
    } else if (rewrite !== null && outcome.kind === 'none') {
      const rewriteNotice = describePrefixRewrite(rewrite.part, rewrite.path)
      recordPrefixRewriteLedger(rewrite.part, rewrite.path, iter.currentModel, rewriteNotice)
      if (takeRewriteNoticeOnce(String(ownerFromToolUseContext(toolUseContext)))) {
        yield emit({ kind: 'notice', message: createThinkingNoteMessage(rewriteNotice, 'warning') })
      }
    }
    const dropped = marksFromDrops(drops, prefixVerdict?.wireMessageIds ?? [], strippedMarks)
    if (dropped.length > 0) {
      logForDebugging(`preserved thinking: ${dropped.length} dropped block(s) recorded as dropped; they stay on the wire as the API returned them (${dropped.map(mark => `${mark.messageId}#${mark.blockIndex}`).join(', ')})`)
      const record = createDroppedThinkingAttachment(dropped)
      yield emit({ kind: 'attachment', message: record })
      iter.thinkingRecords.push(record)
    }
  }
}

export async function* settleReply(run: RunCtx, iter: IterationState, emit: EventMint, settling: ReplySettling, message: AssistantMessage, yieldMessage: AssistantMessage): AsyncGenerator<RunEvent> {
  const { toolUseContext } = iter
  const { callId, projectedReplies, settleGauge } = settling
  projectedReplies.set(message.uuid, yieldMessage as AssistantMessage)
  settleGauge(message)
  const busyRecovery = message.busyRecovery
  if (busyRecovery !== undefined && !busyRecoveriesReceipted.has(message.uuid)) {
    busyRecoveriesReceipted.add(message.uuid)
    yield emit({
      kind: 'notice',
      message: createBusyRecoveryMessage({
        provider: busyRecovery.provider,
        retries: busyRecovery.retries,
        elapsedMs: busyRecovery.elapsedMs,
        content: busyRecovery.detail,
        ...(busyRecovery.status !== undefined ? { status: busyRecovery.status } : {}),
        ...(busyRecovery.code !== undefined ? { code: busyRecovery.code } : {}),
      }),
    })
  }
  stampReply(message, iter.replyTo)
  if (yieldMessage !== message && message.inReplyTo !== undefined) (yieldMessage as AssistantMessage).inReplyTo = message.inReplyTo
  yield emit({
    kind: 'assistant_settled',
    callId,
    message: yieldMessage,
    withheld:
      iter.streamChant !== undefined ||
      isWithheldMaxOutputTokens(message) ||
      (overflowSignalOf(message) !== null && overflowLadderArmed(run.querySource)),
  })
  iter.assistantMessages.push(message)
  yield* classifyDroppedThinking(run, iter, emit, settling, message)
  if (toolUseContext.rosterOwner === undefined) {
    const boundRecord = await boundPrefixRecordToEmit(
      String(rosterOwnerFromToolUseContext(toolUseContext)),
      iter.messagesForQuery,
      iter.currentModel,
      toolUseContext.agentId != null
        ? { rosterOnly: true, context: { userContext: run.userContext, systemContext: run.systemContext } }
        : { rosterOnly: false },
    )
    if (boundRecord !== null) yield emit({ kind: 'attachment', message: boundRecord })
  }

  const msgToolUseBlocks = message.message.content.filter(
    content => content.type === 'tool_use',
  ) as ToolUseBlock[]
  if (msgToolUseBlocks.length > 0) {
    iter.toolUseBlocks.push(...msgToolUseBlocks)
    if (!iter.closingTurn) for (const block of msgToolUseBlocks) iter.early.offer(block, message, iter.toolUseBlocks.indexOf(block))
    iter.needsFollowUp = true
  }
}

export function* streamReceipts(iter: IterationState, emit: EventMint, settleGauge: (message: AssistantMessage) => void): Generator<RunEvent> {
  const { toolUseContext } = iter
  for (const settled of iter.assistantMessages) {
    settleGauge(settled)
    if (settled.streamEnd === undefined || streamEndsReceipted.has(settled.uuid)) continue
    streamEndsReceipted.add(settled.uuid)
    yield emit({
      kind: 'notice',
      message: createSystemMessage(streamEndReceiptLine(settled.streamEnd), 'warning'),
    })
  }
  for (const settled of iter.assistantMessages) {
    const adjusted = settled.effortAdjusted
    if (adjusted === undefined) continue
    const key = `${toolUseContext.agentId ?? 'main'}:${adjusted.model}:${adjusted.asked}>${adjusted.sent ?? ''}`
    if (effortAdjustmentsReceipted.has(key)) continue
    effortAdjustmentsReceipted.add(key)
    yield emit({
      kind: 'notice',
      message: createSystemMessage(effortAdjustedReceiptLine(adjusted), 'warning'),
    })
  }
  {
    const owner = String(rosterOwnerFromToolUseContext(toolUseContext))
    const leftOut = takeImagesLeftOutReceipt(owner)
    if (leftOut !== null && !imagesLeftOutMarked(iter.messagesForQuery)) {
      yield emit({ kind: 'notice', message: createSystemMessage(imagesLeftOutNoticeLine(leftOut), 'warning') })
      yield emit({ kind: 'attachment', message: createAttachmentMessage({ type: 'images_left_out', count: leftOut.count, images: leftOut.images, sidePx: leftOut.sidePx }) })
    }
  }
}

export async function* streamOneCall(run: RunCtx, iter: IterationState, emit: EventMint, call: ModelCall, backups: ReturnType<typeof engineLadderOf>): AsyncGenerator<RunEvent> {
  const { toolUseContext, callChain } = iter
  const { callId, effortValue, callReference, streamController } = call
  let chantWatch = new StreamChantWatch()
  let streamingFallbackOccured = false
  let boardPresented = false
  const requestMessages =
    latestUserContextBody(iter.messagesForQuery) === null
      ? prependUserContext(iter.messagesForQuery, await firstTurnUserContext(run.userContext, run.systemContext, toolUseContext.options.engineModel, toolUseContext.agentId, iter.messagesForQuery))
      : iter.messagesForQuery
  const presentBoard = (): void => {
    if (boardPresented || !swarmRoad(toolUseContext.agentId)) return
    boardPresented = true
    try { swarmPresented(toolUseContext.agentId, requestMessages, callId) } catch (error) { logForDebugging(`crew board accounting: ${String(error)}`) }
  }
  if (isTurnOwningQuerySource(run.querySource)) {
    recordSentRequest(String(rosterOwnerFromToolUseContext(toolUseContext)), requestMessages)
  }
  const requestGauge = iter.requestPlan.gauge === undefined ? undefined : bindRequestGauge(
    iter.messagesForQuery,
    calibrationKeyFor(declaredRouteOf(iter.currentModel) ?? 'unrecognised', iter.currentModel),
    getContextEpoch(ownerFromToolUseContext(toolUseContext)).epoch,
    iter.requestPlan.gauge.fixed,
    iter.requestPlan.gauge.rebase,
  )
  if (requestGauge !== undefined && requestGauge.digest === iter.requestPlan.gauge?.digest) requestGauge.sourceDigest = iter.requestPlan.gauge.sourceDigest
  const projectedReplies = new Map<string, AssistantMessage>()
  const settleGauge = (message: AssistantMessage): void => {
    if (!requestGauge || message.contextGauge) return
    const anchor = settleRequestGauge(requestGauge, message)
    if (!anchor) return
    const boundary = iter.messagesForQuery.findLast(row => row.type === 'system' && row.subtype === 'compact_boundary' && row.compactMetadata.cacheEpoch !== undefined)
    if (boundary?.type === 'system' && boundary.subtype === 'compact_boundary' && !iter.messagesForQuery.some(row => row.type === 'assistant' && row.foldLanding?.boundaryId === boundary.uuid)) {
      const usage = foldCacheUsage(message.message.usage)
      if (usage) message.foldLanding = { boundaryId: boundary.uuid, usage, fixedPrefix: settling.fixedPrefix ?? pendingPrefixVerdict(String(rosterOwnerFromToolUseContext(toolUseContext)))?.fixedPrefix }
    }
    const projected = projectedReplies.get(message.uuid)
    if (projected) { projected.contextGauge = anchor; projected.foldLanding = message.foldLanding }
    if (callId === `${iter.turnId}.c1`) {
      const u = message.message.usage
      reconcileAppliedPlanUsage(ownerFromToolUseContext(toolUseContext), (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
    }
  }
  const settling: ReplySettling = { callId, projectedReplies, settleGauge, fixedPrefix: undefined }
  for await (const message of run.deps.callModel({
    messages: requestMessages,
    systemPrompt: iter.fullSystemPrompt,
    thinkingConfig: toolUseContext.options.thinkingConfig,
    tools: toolUseContext.options.tools,
    signal: streamController.signal,
    options: {
      async getToolPermissionContext() {
        const appState = toolUseContext.getAppState()
        return appState.toolPermissionContext
      },
      model: iter.currentModel,
      toolChoice: iter.closingTurn ? { type: 'none' } : undefined,
      isNonInteractiveSession:
        toolUseContext.options.isNonInteractiveSession,
      fallbackModel: backups.next(iter.currentModel),
      onStreamingFallback: () => {
        streamingFallbackOccured = true
      },
      onWait: wait => toolUseContext.setSDKStatus?.({ wait }),
      onStreamActivity: atMs => {
        toolUseContext.setSDKStatus?.({ streamActivity: atMs })
        presentBoard()
      },
      querySource: run.querySource,
      agents: toolUseContext.options.agentDefinitions.activeAgents,
      allowedAgentTypes:
        toolUseContext.options.agentDefinitions.allowedAgentTypes,
      hasAppendSystemPrompt: !!toolUseContext.options.appendSystemPrompt,
      maxOutputTokensOverride: iter.maxOutputTokensOverride,
      mcpTools: iter.appState.mcp.tools,
      hasPendingMcpServers: iter.appState.mcp.clients.some(
        c => c.type === 'pending',
      ),
      callReference,
      callChain,
      effortValue,
      skipCacheWrite: run.skipCacheWrite,
      agentId: toolUseContext.agentId,
      ownerKey: String(rosterOwnerFromToolUseContext(toolUseContext)),
      addNotification: toolUseContext.addNotification,
    },
  })) {
    if (message.type === 'stream_event' || (message.type === 'assistant' && !message.isApiErrorMessage)) presentBoard()
    if (streamingFallbackOccured) {
      streamingFallbackOccured = false
      for (const msg of iter.assistantMessages) {
        if (msg.inReplyTo !== undefined) iter.replyTo.unshift(...msg.inReplyTo)
        yield emit({ kind: 'assistant_retracted', message: msg })
      }

      iter.needsFollowUp = resetForRetry(iter).needsFollowUp
      chantWatch = new StreamChantWatch()
    }
    if (message.type === 'stream_event' && iter.streamChant === undefined) {
      const detection = chantWatch.feed(message.event)
      if (detection !== null) {
        iter.streamChant = detection
        streamController.abort('stream-chant')
      }
    }
    const yieldMessage: typeof message = backfillCloneForYield(
      message,
      name => findToolByName(toolUseContext.options.tools, name),
    )
    if (message.type === 'assistant') {
      yield* settleReply(run, iter, emit, settling, message, yieldMessage as AssistantMessage)
    } else {
      if (iter.streamChant === undefined || message.type !== 'stream_event') yield emit({ kind: 'stream_delta', callId, raw: yieldMessage })
    }
  }
  yield* streamReceipts(iter, emit, settleGauge)
}

export function* modelCallFailed(iter: IterationState, emit: EventMint, error: unknown): Generator<RunEvent, StreamOutcome> {
  iter.early.reset()
  logError(error)
  const errorMessage =
    describeInvalidArgTypeError(error) ??
    (error instanceof Error ? error.message : String(error))

  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    yield emit({
      kind: 'notice',
      message: createAssistantAPIErrorMessage({
        content: error.message,
      }),
    })
    return { kind: 'terminal', terminal: { reason: 'image_error' } }
  }

  yield* emitSyntheticSettlements(
    iter.assistantMessages,
    errorMessage,
    'error',
    emit,
  )

  yield emit({
    kind: 'notice',
    message: createAssistantAPIErrorMessage({
      content: errorMessage,
    }),
  })

  return { kind: 'terminal', terminal: { reason: 'model_error', error } }
}

export async function* streamModel(
  run: RunCtx,
  iter: IterationState,
  emit: EventMint,
): AsyncGenerator<RunEvent, StreamOutcome> {
  const { toolUseContext } = iter
  const backups = engineLadderOf(run, run.fallbackModel)
  let attemptWithFallback = true

  try {
    while (attemptWithFallback) {
      attemptWithFallback = false
      const permit = yield* waitForModelPermit(run, iter, emit)
      if (permit === null) return { kind: 'streamed' }
      const { callId, permitKey } = permit
      const streamController = new AbortController()
      const parentSignal = toolUseContext.abortController.signal
      const onAbort = (): void => streamController.abort(parentSignal.reason)
      try {
        const { effortValue, callReference } = yield* announceModelCall(iter, emit, callId)
        parentSignal.addEventListener('abort', onAbort, { once: true })
        if (parentSignal.aborted) onAbort()
        yield* streamOneCall(run, iter, emit, { callId, effortValue, callReference, streamController }, backups)
      } catch (innerError) {
        if (innerError instanceof FallbackTriggeredError && backups.take(innerError.fallbackModel)) {
          iter.currentModel = innerError.fallbackModel
          attemptWithFallback = true

          yield* emitSyntheticSettlements(
            iter.assistantMessages,
            'Model fallback triggered',
            'error',
            emit,
          )
          iter.needsFollowUp = resetForRetry(iter).needsFollowUp

          toolUseContext.options.engineModel = innerError.fallbackModel


          yield emit({
            kind: 'notice',
            message: createSystemMessage(backupEngineNoticeLine(innerError), 'warning'),
          })

          continue
        }
        throw innerError
      } finally {
        parentSignal.removeEventListener('abort', onAbort)
        releaseModelPermitByCall(permitKey)
      }
    }
  } catch (error) {
    return yield* modelCallFailed(iter, emit, error)
  }

  return { kind: 'streamed' }
}
