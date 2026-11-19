import type { AnthropicStream } from '../anthropicStream.js'
import { cacheClockObserve } from 'src/utils/cache/cacheClock.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { noteRunPhase } from 'src/utils/runPhases.js'
import {
  clearAnthropicUsageLimit,
  extractQuotaStatusFromHeaders,
} from '../../../anthropicLimits.js'
import { handleStreamPart } from './streamPart.js'
import type { CallState, QueryCtx, QueryYield, StreamPass, StreamWatch } from './state.js'

export const NO_EVENTS_MESSAGE = 'Stream ended without receiving any events'

export async function* readStream(ctx: QueryCtx, call: CallState, pass: StreamPass, watch: StreamWatch, stream: AnthropicStream): AsyncGenerator<QueryYield, 'return' | 'read'> {
  const { signal, options, newMessages, prefixKey, turnOwning, releaseStreamResources, yieldAbortedPartialText } = ctx
  const { STREAM_IDLE_TIMEOUT_MS, streamIdleWatchdog, activityRelay, clearStreamIdleTimers, settledTailType, settledTailStands, settleTypedEnd } = watch
  let isFirstChunk = true
  let lastEventTime: number | null = null
  const STALL_THRESHOLD_MS = 30_000
  let totalStallTime = 0
  let stallCount = 0

  for await (const part of stream) {
    streamIdleWatchdog.noteActivity()
    activityRelay.noteEvent()
    pass.sawFirstStreamEvent = true
    pass.streamEventCount++
    const now = Date.now()

    if (lastEventTime !== null) {
      const timeSinceLastEvent = now - lastEventTime
      if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
        stallCount++
        totalStallTime += timeSinceLastEvent
        logForDebugging(
          `stream stalled ${(timeSinceLastEvent / 1000).toFixed(1)}s between events (stall #${stallCount})`,
          { level: 'warn' },
        )
      }
    }
    lastEventTime = now

    if (isFirstChunk) {
      logForDebugging('stream live — first chunk received')
      if (!options.agentId) {
        headlessProfilerCheckpoint('first_chunk')
        noteRunPhase('first_byte')
      }
      isFirstChunk = false
    }

        yield* handleStreamPart(ctx, call, pass, part)

    yield {
      type: 'stream_event',
      event: part,
      ...(part.type === 'message_start' ? { ttftMs: call.ttftMs } : undefined),
    }
    if (pass.sawMessageStop) break
  }
  clearStreamIdleTimers()

  if (signal.aborted) {
    yield* yieldAbortedPartialText()
    releaseStreamResources()
    return 'return'
  }

  if (pass.streamIdleAborted) {
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
    if (settledTailStands()) {
      yield* settleTypedEnd({
        reason: 'silent-after-last-item',
        provider: 'Anthropic',
        silentMs: streamIdleWatchdog.fired()?.silentMs ?? STREAM_IDLE_TIMEOUT_MS,
      })
    } else {
      throw new Error('Stream idle timeout - no chunks received')
    }
  }

  if (!call.partialMessage || (newMessages.length === 0 && !call.stopReason)) {
    logForDebugging(
      !call.partialMessage
        ? 'stream closed before message_start'
        : 'stream closed after message_start with no completed block and no stop_reason — routing to the non-streaming fallback',
      { level: 'error' },
    )
    throw new Error(NO_EVENTS_MESSAGE)
  }
  if (call.stopReason === null) {
    if (settledTailStands()) {
      yield* settleTypedEnd({ reason: 'closed-after-last-item', provider: 'Anthropic' })
    } else if (settledTailType() === 'tool_use') {
      yield* settleTypedEnd({ reason: 'closed-after-last-item', provider: 'Anthropic' }, 'tool_use')
    } else {
      logForDebugging(
        'stream closed with no stop_reason and a block still open, or a settled tail that is neither text nor a tool call — routing to the non-streaming fallback',
        { level: 'error' },
      )
      throw new Error(NO_EVENTS_MESSAGE)
    }
  }

  if (stallCount > 0) {
    logForDebugging(
      `stream finished carrying ${stallCount} stall(s), ${(totalStallTime / 1000).toFixed(1)}s stalled in total`,
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

  const resp = call.streamResponse as unknown as Response | undefined
  if (resp) {
    extractQuotaStatusFromHeaders(resp.headers, call.start)
    clearAnthropicUsageLimit(call.start)
  }
  return 'read'
}
