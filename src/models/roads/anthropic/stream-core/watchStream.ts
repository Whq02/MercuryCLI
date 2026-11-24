import type { ApiStreamEvent as BetaRawMessageStreamEvent } from '../../../../engine/message-shapes/wire.js'
import { logForDebugging } from 'src/platform/logs/debugLog.js'
import { logForDiagnosticsNoPII } from 'src/platform/logs/diagnosticsLog.js'
import type { AssistantMessage } from '../../../../engine/message-shapes/message.js'
import { getPublicModelDisplayName } from '../../../catalogue/engineModel.js'
import { settleTranscriptMessage } from '../../../../sessions/transcripts/writer.js'
import {
  silentAfterHeadersFaultWords,
  silentAfterHeadersWindowMs,
  createStreamActivityRelay,
  createStreamIdleWatchdog,
  streamEndReceiptLine,
  streamIdleTimeoutMsForRoute,
  streamIdleWarningMsOf,
  type StreamEndV1,
} from '../../streamIdleBudget.js'
import { patienceSeconds } from '../../patience.js'
import type { CallState, CallCtx, StreamPass } from './callState.js'
type StreamWatch = {
  STREAM_IDLE_TIMEOUT_MS: number
  streamIdleWatchdog: ReturnType<typeof createStreamIdleWatchdog>
  activityRelay: ReturnType<typeof createStreamActivityRelay>
  modelDisplayName: string
  preEventSilenceWords: () => string
  clearIdleTimers: () => void
  settledTailType: () => string | null
  settledTailStands: () => boolean
  settledToolUseTailStands: () => boolean
  settleTypedEnd: (
    end: StreamEndV1,
    stopReason?: 'end_turn' | 'tool_use',
  ) => Generator<{ type: 'stream_event'; event: BetaRawMessageStreamEvent }, void>
}

export function watchStream(ctx: CallCtx, call: CallState, pass: StreamPass): StreamWatch {
  const STREAM_IDLE_TIMEOUT_MS = streamIdleTimeoutMsForRoute('anthropic')
  const STREAM_IDLE_WARNING_MS = streamIdleWarningMsOf(STREAM_IDLE_TIMEOUT_MS)
  const modelDisplayName = getPublicModelDisplayName(ctx.options.model) ?? ctx.options.model
  const wait = pass.firstByte.wait
  const silentAfterHeadersMs = silentAfterHeadersWindowMs({
    route: 'anthropic',
    cold: wait?.cold ?? false,
    promptTokens: wait?.promptTokens ?? 0,
    idleMs: STREAM_IDLE_TIMEOUT_MS,
  })

  const streamIdleWatchdog = createStreamIdleWatchdog({
    timeoutMs: STREAM_IDLE_TIMEOUT_MS,
    silentAfterHeadersMs,
    onWarning: () => {
      logForDebugging(`stream silent for ${patienceSeconds(STREAM_IDLE_WARNING_MS)} — watchdog warning`, { level: 'warn' })
      logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
    },
    onFire: fire => {
      pass.streamIdleAborted = true
      pass.streamWatchdogFiredAt = performance.now()
      logForDebugging(
        fire.noBytes
          ? `${silentAfterHeadersFaultWords(modelDisplayName, fire.silentMs, pass.firstByte.wait?.promptTokens ?? 0)} — watchdog aborting the stream`
          : `stream silent for ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)} — watchdog aborting the stream`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
      ctx.releaseStreamResources()
    },
  })

  const activityRelay = createStreamActivityRelay(atMs => {
    ctx.options.onStreamActivity?.(atMs)
  })

  if (pass.transportSawByte) {
    streamIdleWatchdog.noteActivity()
  }

  pass.noteTransportActivity = () => {
    pass.transportSawByte = true
    streamIdleWatchdog.noteActivity()
    activityRelay.noteChunk()
  }

  const preEventSilenceWords = (): string => {
    const fired = streamIdleWatchdog.fired()
    if (fired?.noBytes === true) {
      return silentAfterHeadersFaultWords(
        modelDisplayName,
        fired.silentMs,
        pass.firstByte.wait?.promptTokens ?? 0,
      )
    }
    return `no stream events within ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)} of dispatch — the request was accepted and the wait is provider-side (a switched or uncached prompt can ingest slowly)`
  }

  const clearIdleTimers = (): void => {
    pass.noteTransportActivity = null
    streamIdleWatchdog.stop()
  }

  const settledTailType = (): string | null => {
    if (!call.partialMessage || ctx.newMessages.length === 0 || call.stopReason !== null) {
      return null
    }
    let lastType: string | null = null
    for (let i = 0; i < ctx.contentBlocks.length; i++) {
      const block = ctx.contentBlocks[i]
      if (block === undefined) continue
      if (!ctx.stoppedBlockIndices.has(i)) return null
      lastType = block.type
    }
    return lastType
  }

  const settledTailStands = (): boolean =>
    settledTailType() === 'text' && !pass.streamedToolUse

  const settledToolUseTailStands = (): boolean =>
    settledTailType() === 'tool_use'

  function* settleTypedEnd(
    end: StreamEndV1,
    stopReason: 'end_turn' | 'tool_use' = 'end_turn',
  ): Generator<{ type: 'stream_event'; event: BetaRawMessageStreamEvent }, void> {
    const last: AssistantMessage | undefined = ctx.newMessages.at(-1)
    if (!last) return
    call.stopReason = stopReason
    last.message.usage = call.usage
    last.message.stop_reason = stopReason
    last.streamEnd = end
    void settleTranscriptMessage(last)
    logForDebugging(streamEndReceiptLine(end), { level: 'warn' })
    yield {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: call.usage,
      },
    }
    yield {
      type: 'stream_event',
      event: { type: 'message_stop' },
    }
  }

  return {
    STREAM_IDLE_TIMEOUT_MS,
    streamIdleWatchdog,
    activityRelay,
    modelDisplayName,
    preEventSilenceWords,
    clearIdleTimers,
    settledTailType,
    settledTailStands,
    settledToolUseTailStands,
    settleTypedEnd,
  }
}
