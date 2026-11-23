import {
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '../../../../utils/api/sdkErrors.js'
import type {
  ContentBlock as BetaContentBlock,
  ApiStreamEvent as BetaRawMessageStreamEvent,
} from '../../../../types/wire.js'
import { cacheClockObserve } from 'src/utils/cache/cacheClock.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { noteRunPhase } from 'src/utils/runPhases.js'
import { noteCacheDiagnostics } from '../cacheDiagnostics.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { calculateUSDCost } from 'src/services/usage/modelCost.js'
import type { ConnectorTextBlock } from '../../../../types/connectorText.js'
import type { AssistantMessage, Message } from '../../../../types/message.js'
import { settleTranscriptMessage } from '../../../../utils/sessionStorage/writer.js'
import {
  clearAnthropicUsageLimit,
  extractQuotaStatusFromHeaders,
} from '../../../anthropicLimits.js'
import { malformedStreamFrameText } from '../../../api/errors.js'
import { EMPTY_USAGE } from '../../../api/logging.js'
import { checkResponseForCacheBreak } from '../../../api/promptCacheBreakDetection.js'
import { updateUsage } from '../cacheAndUsage.js'
import {
  createStreamActivityRelay,
  createStreamIdleWatchdog,
  type RequestWaitV1,
} from '../../streamIdleBudget.js'
import type { Options } from '../streamCore.js'
import type { CallState, StreamPass } from './state.js'
export function openStreamPass(): StreamPass {
  const firstByte: { wait: Extract<RequestWaitV1, { kind: 'first-byte' }> | null } = { wait: null }
  const pass: StreamPass = {
    noteTransportActivity: null,
    transportSawByte: false,
    firstByte,
    streamIdleAborted: false,
    streamedToolUse: false,
    sawFirstStreamEvent: false,
    streamEventCount: 0,
    streamWatchdogFiredAt: null,
    sawMessageStop: false,
    isFirstChunk: true,
    lastEventTime: null,
    totalStallTime: 0,
    stallCount: 0,
  }
  return pass
}

export function resetStreamAttempt(call: CallState, settleUnpricedAttempt: () => void, newMessages: AssistantMessage[], contentBlocks: (BetaContentBlock | ConnectorTextBlock)[], stoppedBlockIndices: Set<number>): void {
  settleUnpricedAttempt()
  newMessages.length = 0
  call.ttftMs = 0
  call.partialMessage = undefined
  contentBlocks.length = 0
  stoppedBlockIndices.clear()
  call.usage = EMPTY_USAGE
  call.stopReason = null
  call.ledgerSettled = false
}

export function noteStreamEvent(pass: StreamPass, streamIdleWatchdog: ReturnType<typeof createStreamIdleWatchdog>, activityRelay: ReturnType<typeof createStreamActivityRelay>, options: Options): void {
  const STALL_THRESHOLD_MS = 30_000
  streamIdleWatchdog.noteActivity()
  activityRelay.noteEvent()
  pass.sawFirstStreamEvent = true
  pass.streamEventCount++
  const now = Date.now()

  if (pass.lastEventTime !== null) {
    const timeSinceLastEvent = now - pass.lastEventTime
    if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
      pass.stallCount++
      pass.totalStallTime += timeSinceLastEvent
      logForDebugging(
        `stream stalled ${(timeSinceLastEvent / 1000).toFixed(1)}s between events (stall #${pass.stallCount})`,
        { level: 'warn' },
      )
    }
  }
  pass.lastEventTime = now

  if (pass.isFirstChunk) {
    logForDebugging('stream live — first chunk received')
    if (!options.agentId) {
      headlessProfilerCheckpoint('first_chunk')
      noteRunPhase('first_byte')
    }
    pass.isFirstChunk = false
  }
}

export function startMessage(call: CallState, part: Extract<BetaRawMessageStreamEvent, { type: 'message_start' }>, noteServedModel: (model: string | undefined) => void): void {
  call.partialMessage = part.message
  call.ttftMs = Date.now() - call.start
  call.usage = updateUsage(call.usage, part.message?.usage)
  noteServedModel(part.message?.model)
  noteCacheDiagnostics(part.message, part.message?.usage, call.ledgerFirstDifference)
}

export function openContentBlock(contentBlocks: (BetaContentBlock | ConnectorTextBlock)[], part: Extract<BetaRawMessageStreamEvent, { type: 'content_block_start' }>): void {
  const block = part.content_block
  if (!block) {
    throw new Error(malformedStreamFrameText('content_block_start', 'content_block'))
  }
  switch (block.type) {
    case 'tool_use':
      contentBlocks[part.index] = { ...block, input: '' }
      break
    case 'server_tool_use':
      contentBlocks[part.index] = { ...block, input: '' }
      break
    case 'text':
      contentBlocks[part.index] = { ...block, text: '' }
      break
    case 'thinking':
      contentBlocks[part.index] = { ...block, thinking: '', signature: '' }
      break
    default:
      contentBlocks[part.index] = { ...block }
      break
  }
}

export function applyBlockDelta(contentBlocks: (BetaContentBlock | ConnectorTextBlock)[], part: Extract<BetaRawMessageStreamEvent, { type: 'content_block_delta' }>): void {
  const block = contentBlocks[part.index]
  if (!block) {
    throw new RangeError('Content block not found')
  }
  const delta = part.delta
  if (delta === null || delta === undefined) {
    throw new Error(malformedStreamFrameText('content_block_delta', 'delta'))
  }
  switch (delta.type) {
    case 'input_json_delta':
      if (block.type !== 'tool_use' && block.type !== 'server_tool_use') {
        throw new Error('Content block is not a input_json block')
      }
      if (typeof block.input !== 'string') {
        throw new Error('Content block input is not a string')
      }
      block.input += delta.partial_json
      break
    case 'text_delta':
      if (block.type !== 'text') throw new Error('Content block is not a text block')
      block.text += delta.text
      break
    case 'signature_delta':
      if (block.type !== 'thinking') throw new Error('Content block is not a thinking block')
      block.signature = delta.signature
      break
    case 'thinking_delta':
      if (block.type !== 'thinking') throw new Error('Content block is not a thinking block')
      block.thinking += delta.thinking
      break
  }
}

export function settleMessageDelta(call: CallState, part: Extract<BetaRawMessageStreamEvent, { type: 'message_delta' }>, newMessages: AssistantMessage[], pricingModel: () => string, options: Options, messages: Message[]): void {
  call.stopReason = part.delta.stop_reason
  call.usage = updateUsage(call.usage, part.usage)
  const settledUsage = { ...call.usage, request_started_at_ms: call.start }
  if (call.partialMessage) {
    call.partialMessage.stop_reason = part.delta.stop_reason
    call.partialMessage.stop_sequence = part.delta.stop_sequence
    call.partialMessage.usage = settledUsage
  }
  const lastMessage = newMessages.at(-1)
  if (lastMessage) {
    lastMessage.message.usage = settledUsage
    lastMessage.message.stop_reason = part.delta.stop_reason
    lastMessage.message.stop_sequence = part.delta.stop_sequence
    void settleTranscriptMessage(lastMessage)
  }
  if (!call.ledgerSettled) {
    call.ledgerSettled = true
    const model = pricingModel()
    addToTotalSessionCost(calculateUSDCost(model, settledUsage), settledUsage, model)
  }
  void checkResponseForCacheBreak(
    options.querySource,
    call.usage.cache_read_input_tokens,
    call.usage.cache_creation_input_tokens,
    messages,
    options.agentId,
    call.streamRequestId ?? null,
  )
}

export function noteWatchdogCleanExit(pass: StreamPass): void {
  const exitDelayMs =
    pass.streamWatchdogFiredAt !== null
      ? Math.round(performance.now() - pass.streamWatchdogFiredAt)
      : -1
  logForDiagnosticsNoPII(
    'info',
    'cli_stream_loop_exited_after_watchdog_clean',
  )
  logForDebugging(
    `stream loop exited ${exitDelayMs}ms after watchdog abort (clean exit)`,
  )
  pass.streamWatchdogFiredAt = null
}

export function observeStreamEnd(call: CallState, pass: StreamPass, turnOwning: boolean, prefixKey: string): void {
  if (pass.stallCount > 0) {
    logForDebugging(
      `stream finished carrying ${pass.stallCount} stall(s), ${(pass.totalStallTime / 1000).toFixed(1)}s stalled in total`,
      { level: 'warn' },
    )
  }

  cacheClockObserve({
    cacheReadTokens: call.usage.cache_read_input_tokens,
    cacheCreationTotal: call.usage.cache_creation_input_tokens,
    cacheCreation5m: call.usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
    cacheCreation1h: call.usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
    uncachedInputTokens: call.usage.input_tokens,
    now: Date.now(),
    prefixKey: turnOwning ? prefixKey : null,
    startedAt: call.start,
  })

  const resp = call.streamResponse
  if (resp) {
    extractQuotaStatusFromHeaders(resp.headers, call.start)
    clearAnthropicUsageLimit(call.start)
  }
}

export function noteWatchdogErrorExit(pass: StreamPass & { streamWatchdogFiredAt: number }): void {
  const exitDelayMs = Math.round(performance.now() - pass.streamWatchdogFiredAt)
  logForDiagnosticsNoPII(
    'info',
    'cli_stream_loop_exited_after_watchdog_error',
  )
  logForDebugging(
    `stream loop exited ${exitDelayMs}ms after watchdog abort (error exit)`,
  )
}

export function sdkAbortError(signal: AbortSignal, streamingError: APIUserAbortError): APIUserAbortError | APIConnectionTimeoutError {
  if (signal.aborted) return streamingError
  return new APIConnectionTimeoutError({ message: 'Request timed out' })
}
