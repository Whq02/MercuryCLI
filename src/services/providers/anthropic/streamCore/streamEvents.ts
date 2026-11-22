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
import type { ConnectorTextBlock } from '../../../../types/connectorText.js'
import type { AssistantMessage, Message } from '../../../../types/message.js'
import {
  clearAnthropicUsageLimit,
  extractQuotaStatusFromHeaders,
} from '../../../anthropicLimits.js'
import { EMPTY_USAGE } from '../../../api/logging.js'
import { updateUsage } from '../cacheAndUsage.js'
import {
  createStreamActivityRelay,
  createStreamIdleWatchdog,
  type RequestWaitV1,
} from '../../streamIdleBudget.js'
import type { Options } from '../streamCore.js'
import type { CallState, StreamPass } from './state.js'
import { notBuilt, type Unbuilt } from '../../../../pi/holes.js'

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
  return notBuilt('src/services/providers/anthropic/streamCore/streamEvents.ts:114')
}

export function applyBlockDelta(contentBlocks: (BetaContentBlock | ConnectorTextBlock)[], part: Extract<BetaRawMessageStreamEvent, { type: 'content_block_delta' }>): void {
  return notBuilt('src/services/providers/anthropic/streamCore/streamEvents.ts:150')
}

export function settleMessageDelta(call: CallState, part: Extract<BetaRawMessageStreamEvent, { type: 'message_delta' }>, newMessages: AssistantMessage[], pricingModel: () => string, options: Options, messages: Message[]): void {
  return notBuilt('src/services/providers/anthropic/streamCore/streamEvents.ts:195')
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
  return notBuilt('src/services/providers/anthropic/streamCore/streamEvents.ts:262')
}

export function sdkAbortError(signal: AbortSignal, streamingError: APIUserAbortError): Unbuilt {
  return notBuilt('src/services/providers/anthropic/streamCore/streamEvents.ts:275')
}
