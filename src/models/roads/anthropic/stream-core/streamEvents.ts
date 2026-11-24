import {
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '../../../../engine/request-parts/sdkErrors.js'
import type {
  ContentBlock as BetaContentBlock,
  ApiStreamEvent as BetaRawMessageStreamEvent,
} from '../../../../engine/message-shapes/wire.js'
import { cacheClockObserve } from 'src/platform/cache-clock/cacheClock.js'
import { logForDebugging } from 'src/platform/logs/debugLog.js'
import { logForDiagnosticsNoPII } from 'src/platform/logs/diagnosticsLog.js'
import { headlessProfilerCheckpoint } from 'src/platform/logs/headlessProfiler.js'
import { noteRunPhase } from 'src/platform/logs/runPhases.js'
import { noteCacheDiagnostics } from '../cacheDiagnostics.js'
import { addToTotalSessionCost } from 'src/models/usage/sessionCost.js'
import { calculateUSDCost } from 'src/models/usage/modelCost.js'
import type { ConnectorTextBlock } from '../connectorText.js'
import type { AssistantMessage, Message } from '../../../../engine/message-shapes/message.js'
import { errorMessage } from '../../../../platform/errors/errors.js'
import { settleTranscriptMessage } from '../../../../sessions/transcripts/writer.js'
import {
  clearAnthropicUsageLimit,
  extractQuotaStatusFromHeaders,
} from '../anthropicLimits.js'
import { malformedStreamFrameText } from '../../../../engine/requests/apiErrorRows.js'
import { EMPTY_USAGE } from '../../../../engine/requests/apiCallLogging.js'
import { checkResponseForCacheBreak } from '../../../../engine/requests/promptCacheBreakDetection.js'
import { updateUsage, usageBeyond } from '../cacheAndUsage.js'
import {
  createStreamActivityRelay,
  createStreamIdleWatchdog,
  type RequestWaitV1,
} from '../../streamIdleBudget.js'
import type { Options } from '../streamCore.js'
import type { CallState, StreamPass } from './callState.js'
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
  const charged = call.ledgerSettled ? call.usage : null
  call.usage = updateUsage(call.usage, part.usage)
  call.stopReason = part.delta.stop_reason
  const lastMessage = newMessages.at(-1)
  if (lastMessage) {
    lastMessage.message.usage = call.usage
    lastMessage.message.stop_reason = call.stopReason
    void settleTranscriptMessage(lastMessage)
  }
  const model = pricingModel()
  const cost = calculateUSDCost(model, call.usage)
  if (charged === null) addToTotalSessionCost(cost, call.usage, model)
  else addToTotalSessionCost(Math.max(0, cost - calculateUSDCost(model, charged)), usageBeyond(call.usage, charged), model, { basis: 'same-attempt' })
  call.ledgerSettled = true
  void checkResponseForCacheBreak(
    options.querySource,
    call.usage.cache_read_input_tokens,
    call.usage.cache_creation_input_tokens,
    messages,
    options.agentId,
    call.clientRequestId ?? null,
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
  if (signal.aborted) {
    logForDebugging(`Streaming aborted by user: ${errorMessage(streamingError)}`)
    return streamingError
  }
  logForDebugging(`Streaming timeout (SDK abort): ${streamingError.message}`, { level: 'error' })
  return new APIConnectionTimeoutError({ message: 'Request timed out' })
}
