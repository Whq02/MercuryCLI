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
type StreamWatch = {
  STREAM_IDLE_TIMEOUT_MS: number
  streamIdleWatchdog: ReturnType<typeof createStreamIdleWatchdog>
  activityRelay: ReturnType<typeof createStreamActivityRelay>
  preEventSilenceWords: () => string
  clearIdleTimers: () => void
  recordEvent: (part: BetaRawMessageStreamEvent) => void
  settledTail: () => AssistantMessage | null
  settledToolUseTail: () => AssistantMessage | null
  settleTypedEnd: (end: StreamEndV1, toolUseTail?: boolean) => void
}

export function watchStream(ctx: QueryCtx, call: CallState, pass: StreamPass): StreamWatch {
  const STREAM_IDLE_TIMEOUT_MS = streamIdleTimeoutMsForRoute('anthropic')
  const STREAM_IDLE_WARNING_MS = streamIdleWarningMsOf(STREAM_IDLE_TIMEOUT_MS)
  const wait = pass.firstByte.wait
  const silentAfterHeadersMs = silentAfterHeadersWindowMs({
    route: 'anthropic',
    cold: wait?.cold ?? false,
    promptTokens: wait?.promptTokens ?? 0,
    idleMs: STREAM_IDLE_TIMEOUT_MS,
  })
  const openBlockIndices = new Set<number>()

  const streamIdleWatchdog = createStreamIdleWatchdog({
    timeoutMs: STREAM_IDLE_TIMEOUT_MS,
    silentAfterHeadersMs,
    onWarning: silentMs => {
      logForDebugging(
        `stream idle warning: no activity for ${patienceSeconds(silentMs)} (warning threshold ${patienceSeconds(STREAM_IDLE_WARNING_MS)}, timeout ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)})`,
        { level: 'warn' },
      )
    },
    onFire: fire => {
      pass.streamIdleAborted = true
      pass.streamWatchdogFiredAt = performance.now()
      logForDiagnosticsNoPII('warn', 'cli_stream_idle_watchdog_fired')
      logForDebugging(
        fire.noBytes
          ? `stream idle watchdog fired (${silentAfterHeadersFaultWords(getPublicModelDisplayName(ctx.options.model) ?? ctx.options.model, fire.silentMs, pass.firstByte.wait?.promptTokens ?? 0)})`
          : `stream idle watchdog fired after ${patienceSeconds(fire.silentMs)} of silence (${pass.streamEventCount} event(s) received)`,
        { level: 'warn' },
      )
      const controller = call.stream?.controller
      if (controller && !controller.signal.aborted) {
        controller.abort()
      }
    },
  })

  const activityRelay = createStreamActivityRelay(atMs => {
    ctx.options.onStreamActivity?.(atMs)
  })

  pass.noteTransportActivity = () => {
    pass.transportSawByte = true
    streamIdleWatchdog.noteActivity()
    activityRelay.noteChunk()
  }

  const preEventSilenceWords = (): string => {
    const fired = streamIdleWatchdog.fired()
    if (fired?.noBytes === true) {
      return silentAfterHeadersFaultWords(
        getPublicModelDisplayName(ctx.options.model) ?? ctx.options.model,
        fired.silentMs,
        pass.firstByte.wait?.promptTokens ?? 0,
      )
    }
    return `no stream events within ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)}`
  }

  const clearIdleTimers = (): void => {
    streamIdleWatchdog.stop()
    pass.noteTransportActivity = null
  }

  const recordEvent = (part: BetaRawMessageStreamEvent): void => {
    if (part.type === 'content_block_start') {
      openBlockIndices.add(part.index)
    } else if (part.type === 'content_block_stop') {
      openBlockIndices.delete(part.index)
    }
  }

  const settledTail = (): AssistantMessage | null => {
    if (openBlockIndices.size > 0 || pass.streamedToolUse) return null
    const last = ctx.newMessages.at(-1)
    if (!last) return null
    const blocks = last.message.content
    if (!Array.isArray(blocks) || blocks.length === 0) return null
    const hasText = blocks.some(block => block.type === 'text' && block.text.length > 0)
    const hasToolUse = blocks.some(block => block.type === 'tool_use')
    return hasText && !hasToolUse ? last : null
  }

  const settledToolUseTail = (): AssistantMessage | null => {
    if (openBlockIndices.size > 0 || !pass.streamedToolUse) return null
    const last = ctx.newMessages.at(-1)
    if (!last) return null
    const blocks = last.message.content
    if (!Array.isArray(blocks) || blocks.length === 0) return null
    return blocks.some(block => block.type === 'tool_use') ? last : null
  }

  const settleTypedEnd = (end: StreamEndV1, toolUseTail = false): void => {
    const last = ctx.newMessages.at(-1)
    if (!last) return
    const stopReason = toolUseTail ? 'tool_use' : 'end_turn'
    call.stopReason = stopReason
    if (call.partialMessage) {
      call.partialMessage.stop_reason = stopReason
    }
    last.message.stop_reason = stopReason
    last.message.usage = { ...call.usage, request_started_at_ms: call.start }
    last.streamEnd = end
    logForDebugging(streamEndReceiptLine(end), { level: 'warn' })
    void settleTranscriptMessage(last)
  }

  return {
    STREAM_IDLE_TIMEOUT_MS,
    streamIdleWatchdog,
    activityRelay,
    preEventSilenceWords,
    clearIdleTimers,
    recordEvent,
    settledTail,
    settledToolUseTail,
    settleTypedEnd,
  }
}
