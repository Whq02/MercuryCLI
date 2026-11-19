import type { Tools } from '../../../../Tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
} from '../../../../types/message.js'
import { streamFaultAfterPartialText } from '../../../api/errors.js'
import { streamCutForensicsDetail } from '../streamCutForensics.js'
import type { Options } from '../../anthropic/streamCore.js'
import {
  type OpenaiRequestAuth,
} from '../openaiAccounts.js'
import { type EffortAdjustedV1 } from '../../../../utils/effort.js'
import { streamIdleTimeoutMsForRoute, typedStreamEndOf } from '../../streamIdleBudget.js'
import { type BusyRetryLadder } from '../../busyRetry.js'
import { isTemporaryStreamFault } from '../../temporaryStreamError.js'
import { type EffortStampV1 } from '../../../../utils/effortStamp.js'
import type {
  OpenaiFault,
  OpenaiResponsesRequest,
  OpenaiStreamEvent,
} from '../openaiWire.js'
import { MODEL_NOT_FOUND_CODE, apiErrorMessage, overflowOf } from './faults.js'
import { openAttemptBlocks, streamEvent } from './attemptBlocks.js'
import { openAttemptEvents, readAttemptEvents } from './attemptEvents.js'
import { emitFinishNotes, settleAttemptToolCalls, settleAttemptUsage } from './attemptSettle.js'

export type AttemptOutcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'fault'; fault: OpenaiFault; retryEligible: boolean }

export type OpenaiAttemptCtx = {
  _eventsForTesting?: AsyncIterable<OpenaiStreamEvent>
  request: OpenaiResponsesRequest
  auth: OpenaiRequestAuth
  signal: AbortSignal
  tools: Tools
  options: Options
  modelId: string
  messages: Message[]
  settlementNotes: readonly string[]
  effortAdjusted?: EffortAdjustedV1
  effort?: EffortStampV1
  contractDigest: string
  deferredUnadmitted?: (name: string) => boolean
  attempt?: number
  busy?: { ladder: BusyRetryLadder; fault: OpenaiFault }
}

export async function* streamOneOpenaiAttempt(ctx: OpenaiAttemptCtx): AsyncGenerator<StreamEvent | AssistantMessage, AttemptOutcome> {
  const { auth, signal } = ctx
  const requestStartedAtMs = Date.now()
  const w = openAttemptBlocks(ctx)
  const events = openAttemptEvents(ctx)
  const read = yield* readAttemptEvents(events, w, ctx)
  const { finish, fault, settledOnFault } = read
  const { blocks, minted, ensureMessageStart, closeOpenBlock, emitLeadingNotes } = w

  if (fault?.kind === 'cancelled' || signal.aborted) {
    if (blocks.open?.kind === 'text' && blocks.open.value.length > 0) yield* closeOpenBlock()
    return { kind: 'cancelled' }
  }
  const nothingYielded = !w.messageStarted && minted.length === 0
  const retryTemporary = fault !== undefined && isTemporaryStreamFault(fault) && (finish?.toolCalls.length ?? 0) === 0
  if (fault && nothingYielded && (!finish || retryTemporary)) {
    return { kind: 'fault', fault, retryEligible: true }
  }
  const typedEnd =
    fault !== undefined && !finish && !retryTemporary && !MODEL_NOT_FOUND_CODE.test(fault.code)
      ? typedStreamEndOf({
          fault,
          provider: 'OpenAI',
          tailStands:
            blocks.open === null &&
            minted.at(-1)?.message.content[0]?.type === 'text' &&
            !settledOnFault.some(item => item.type === 'function_call'),
          silentMs: streamIdleTimeoutMsForRoute('openai'),
        })
      : null

  yield* ensureMessageStart()
  yield* closeOpenBlock()
  yield* emitLeadingNotes()
  const settled = yield* settleAttemptToolCalls(ctx, w, finish)
  yield* emitFinishNotes(w, read)

  const { stopReason, finalUsage } = settleAttemptUsage(ctx, minted, read, settled, requestStartedAtMs, typedEnd)
  yield streamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: finalUsage,
  })
  yield streamEvent({ type: 'message_stop' })

  if (fault && MODEL_NOT_FOUND_CODE.test(fault.code)) return { kind: 'fault', fault, retryEligible: false }
  if (fault && retryTemporary) return { kind: 'fault', fault, retryEligible: true }
  if (fault && typedEnd === null) {
    const faultRow = apiErrorMessage(
      streamFaultAfterPartialText(auth.account.label, fault.code, fault.message),
      undefined,
      fault.forensics === undefined ? undefined : streamCutForensicsDetail(fault, fault.forensics),
      overflowOf(fault),
    )
    yield ctx.effort !== undefined ? { ...faultRow, effort: ctx.effort } : faultRow
  }
  return { kind: 'done' }
}
