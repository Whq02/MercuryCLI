import type { ApiStreamEvent as BetaRawMessageStreamEvent } from '../../../../types/wire.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import type { AssistantMessage } from '../../../../types/message.js'
import { getPublicModelDisplayName } from '../../../model/model.js'
import { settleTranscriptMessage } from '../../../../utils/sessionStorage/writer.js'
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
import type { CallState, QueryCtx, StreamPass } from './state.js'

export function watchStream(ctx: QueryCtx, call: CallState, pass: StreamPass) {
  const { options, newMessages, contentBlocks, stoppedBlockIndices, releaseStreamResources } = ctx
  const { firstByte } = pass
  const STREAM_IDLE_TIMEOUT_MS = streamIdleTimeoutMsForRoute('anthropic')
  const STREAM_IDLE_WARNING_MS = streamIdleWarningMsOf(STREAM_IDLE_TIMEOUT_MS)
  const modelWords = getPublicModelDisplayName(options.model) ?? options.model
  const preEventSilenceWords = (): string => {
    const fired = streamIdleWatchdog.fired()
    return fired?.noBytes === true
      ? silentAfterHeadersFaultWords(modelWords, fired.silentMs, firstByte.wait?.promptTokens ?? 0)
      : `no stream events within ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)} of dispatch — the request was accepted and the wait is provider-side (a switched or uncached prompt can ingest slowly)`
  }
  const streamIdleWatchdog = createStreamIdleWatchdog({
    timeoutMs: STREAM_IDLE_TIMEOUT_MS,
    silentAfterHeadersMs: silentAfterHeadersWindowMs({
      route: 'anthropic',
      cold: firstByte.wait?.cold === true,
      promptTokens: firstByte.wait?.promptTokens ?? 0,
      idleMs: STREAM_IDLE_TIMEOUT_MS,
    }),
    onWarning: () => {
      logForDebugging(
        `stream silent for ${patienceSeconds(STREAM_IDLE_WARNING_MS)} — watchdog warning`,
        { level: 'warn' },
      )
      logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
    },
    onFire: () => {
      pass.streamIdleAborted = true
      pass.streamWatchdogFiredAt = performance.now()
      logForDebugging(
        streamIdleWatchdog.fired()?.noBytes === true
          ? `${preEventSilenceWords()} — watchdog aborting the stream`
          : `stream silent for ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)} — watchdog aborting the stream`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
      releaseStreamResources()
    },
  })
  if (pass.transportSawByte) streamIdleWatchdog.noteActivity()
  const activityRelay = createStreamActivityRelay(atMs => options.onStreamActivity?.(atMs))
  pass.noteTransportActivity = () => {
    streamIdleWatchdog.noteActivity()
    activityRelay.noteChunk()
  }
  function clearStreamIdleTimers(): void {
    pass.noteTransportActivity = null
    streamIdleWatchdog.stop()
  }
  function settledTailType(): string | null {
    if (!call.partialMessage || newMessages.length === 0 || call.stopReason !== null) return null
    let last: (typeof contentBlocks)[number] | undefined
    for (let i = 0; i < contentBlocks.length; i++) {
      const block = contentBlocks[i]
      if (block === undefined) continue
      if (!stoppedBlockIndices.has(i)) return null
      last = block
    }
    return last?.type ?? null
  }
  function settledTailStands(): boolean {
    return !pass.streamedToolUse && settledTailType() === 'text'
  }
  function* settleTypedEnd(end: StreamEndV1, reason: 'end_turn' | 'tool_use' = 'end_turn') {
    const lastMsg = newMessages.at(-1)
    if (!lastMsg) return
    call.stopReason = reason
    lastMsg.message.usage = call.usage as AssistantMessage['message']['usage']
    lastMsg.message.stop_reason = reason
    lastMsg.streamEnd = end
    void settleTranscriptMessage(lastMsg)
    logForDebugging(streamEndReceiptLine(end), { level: 'warn' })
    const deltaEvent: BetaRawMessageStreamEvent = {
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      usage: call.usage,
    }
    yield {
      type: 'stream_event' as const,
      event: deltaEvent,
    }
    yield {
      type: 'stream_event' as const,
      event: { type: 'message_stop' } as BetaRawMessageStreamEvent,
    }
  }

  return { STREAM_IDLE_TIMEOUT_MS, modelWords, preEventSilenceWords, streamIdleWatchdog, activityRelay, clearStreamIdleTimers, settledTailType, settledTailStands, settleTypedEnd }
}
