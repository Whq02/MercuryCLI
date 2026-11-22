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
import { effortAdjustedReceiptLine, isTurnOwningQuerySource } from '../../utils/effort.js'
import type { AssistantMessage } from '../../types/message.js'
import { logError } from '../../utils/log.js'
import {
  createSystemMessage,
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
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/run-core/turn/streamModel.ts:88')
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
  return notBuilt('src/run-core/turn/streamModel.ts:178')
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
  return notBuilt('src/run-core/turn/streamModel.ts:271')
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
  return notBuilt('src/run-core/turn/streamModel.ts:358')
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
