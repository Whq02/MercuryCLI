import { FallbackTriggeredError } from '../../requests/withRetry.js'
import { backupEngineNoticeLine, engineLadderOf, type EngineLadder } from '../../requests/backupEngines.js'
import { ImageSizeError } from '../../requests/imageValidation.js'
import { ImageResizeError, imagesLeftOutMarked, imagesLeftOutNoticeLine, takeImagesLeftOutReceipt } from '../../../platform/images/imageResizer.js'
import { describeInvalidArgTypeError } from '../../../platform/errors/errors.js'
import { effortAdjustedReceiptLine, isTurnOwningQuerySource } from '../../../models/effort/effort.js'
import type { AssistantMessage } from '../../message-shapes/message.js'
import { logError } from '../../../platform/logs/errorLog.js'
import {
  createSystemMessage,
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '../../messages/messages.js'
import { createAttachmentMessage } from '../../attachments/attachments.js'
import { streamEndReceiptLine } from '../../../models/roads/streamIdleBudget.js'
import { rosterOwnerFromToolUseContext } from '../../run-owner/resolveOwner.js'
import type { Terminal } from '../../turn-entry/transitions.js'
import { resetForRetry } from '../model-lane.js'
import type { ModelCallReference } from '../call-reference.js'
import type { RunEvent } from '../events.js'
import { operatorPauseGate, pauseGateKeyOf, pauseGateModelWords, pauseGateSeatOf } from '../pauseGate.js'
import { acquireModelPermit, releaseModelPermitByCall } from '../../../crew/capacity/governor.js'
import { refreshGovernorCeilings } from '../../../crew/capacity/composeCeilings.js'
import type { EventMint, IterationState, RunCtx } from './turnState.js'

const streamEndsReceipted = new Set<string>()
const effortAdjustmentsReceipted = new Set<string>()

export function* emitSyntheticSettlements(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
  outcome: 'error' | 'aborted',
  emit: EventMint,
): Generator<RunEvent> {
  for (const assistantMessage of assistantMessages) {
    for (const block of assistantMessage.message.content) {
      if (block.type !== 'tool_use') continue
      yield emit({
        kind: 'tool_settled',
        toolUseId: block.id,
        outcome,
        synthetic: true,
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: errorMessage,
              is_error: true,
              tool_use_id: block.id,
            },
          ],
          toolUseResult: errorMessage,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      })
    }
  }
}

export type StreamOutcome =
  | { kind: 'streamed' }
  | { kind: 'terminal'; terminal: Terminal }

export type ModelCall = {
  callId: string
  effortValue: IterationState['appState']['effortValue']
  callReference: ModelCallReference
  streamController: AbortController
}

type CallSteps = {
  announce: (iter: IterationState, emit: EventMint, callId: string) => Generator<RunEvent, Pick<ModelCall, 'effortValue' | 'callReference'>>
  stream: (run: RunCtx, iter: IterationState, emit: EventMint, call: ModelCall, backups: EngineLadder) => AsyncGenerator<RunEvent>
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
    if (leftOut !== null && !imagesLeftOutMarked(iter.messagesForRequest)) {
      yield emit({ kind: 'notice', message: createSystemMessage(imagesLeftOutNoticeLine(leftOut), 'warning') })
      yield emit({ kind: 'attachment', message: createAttachmentMessage({ type: 'images_left_out', count: leftOut.count, images: leftOut.images, sidePx: leftOut.sidePx }) })
    }
  }
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

export async function* callWithPolicy(
  run: RunCtx,
  iter: IterationState,
  emit: EventMint,
  steps: CallSteps,
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
        const { effortValue, callReference } = yield* steps.announce(iter, emit, callId)
        parentSignal.addEventListener('abort', onAbort, { once: true })
        if (parentSignal.aborted) onAbort()
        yield* steps.stream(run, iter, emit, { callId, effortValue, callReference, streamController }, backups)
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
