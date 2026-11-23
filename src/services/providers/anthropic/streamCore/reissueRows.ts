import { APIError } from '../../../../utils/api/sdkErrors.js'
import type { ApiMessage as BetaMessage } from '../../../../types/wire.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { resetApiConnectionPool } from 'src/utils/proxy.js'
import { noteRequestOnWire } from '../prefixLedger.js'
import type {
  AssistantMessage,
  SystemAPIErrorMessage,
  SystemStreamCutMessage,
} from '../../../../types/message.js'
import { isTurnOwningQuerySource } from '../../../../utils/effort.js'
import { errorMessage } from '../../../../utils/errors.js'
import {
  createStreamCutMessage,
  createSystemAPIErrorMessage,
} from '../../../messages.js'
import { transportCutOf, transportCutWords } from '../../../../utils/api/transportEvidence.js'
import { createStreamIdleWatchdog } from '../../streamIdleBudget.js'
import { patienceSeconds } from '../../patience.js'
import type { Options } from '../streamCore.js'
import type { createCallLedger } from './callLedger.js'
import { getNonstreamingFallbackTimeoutMs } from './nonStreaming.js'
import type { CallState, StreamPass } from './state.js'
type CallLedger = ReturnType<typeof createCallLedger>

export function preEventReissueRow(call: CallState, streamingError: unknown, preEventSilenceWords: () => string, STREAM_IDLE_TIMEOUT_MS: number): SystemAPIErrorMessage {
  const silence = preEventSilenceWords()
  call.preFirstEventStreamRetryUsed = true
  resetApiConnectionPool()
  logForDiagnosticsNoPII('info', 'cli_stream_preevent_streaming_retry')
  logForDebugging(`watchdog: ${silence} — reissuing the stream (pass 2)`, { level: 'warn' })
  const noticeError = Object.assign(new Error(`${silence}; reissuing the stream`), { cause: streamingError })
  return createSystemAPIErrorMessage(noticeError, 0, 1, 2, {
    recoveryTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  })
}

export function streamCutReissueRow(call: CallState, options: Options, cut: NonNullable<ReturnType<typeof transportCutOf>>): SystemStreamCutMessage {
  const cutWords = transportCutWords('Anthropic', cut)
  call.streamCutRetryUsed = true
  resetApiConnectionPool()
  if (options.onStreamingFallback) {
    options.onStreamingFallback()
  }
  logForDiagnosticsNoPII('warn', 'cli_stream_cut_streaming_retry')
  logForDebugging(`${cutWords} — reissuing the stream on a fresh connection (pass 2)`, { level: 'warn' })
  return createStreamCutMessage({
    count: 1,
    content: `${cutWords}; the request was sent again on a fresh connection (reissue 1 of 1)`,
    road: 'Anthropic',
    sent: cut.words,
    code: cut.code,
  })
}

export function oneShotNoticeRow(call: CallState, pass: StreamPass, options: Options, streamingError: unknown, cut: ReturnType<typeof transportCutOf>, STREAM_IDLE_TIMEOUT_MS: number, streamIdleWatchdog: ReturnType<typeof createStreamIdleWatchdog>, preEventSilenceWords: () => string) {
  logForDebugging(
    `The stream failed; the request is retried as one shot: ${errorMessage(streamingError)}`,
    { level: 'error' },
  )
  if (pass.streamIdleAborted) resetApiConnectionPool()
  if (cut !== null) resetApiConnectionPool()
  call.didFallBackToNonStreaming = true
  if (options.onStreamingFallback) {
    options.onStreamingFallback()
  }
  const fallbackWaitWords = `waiting up to ${patienceSeconds(getNonstreamingFallbackTimeoutMs())} for ONE non-streamed completion (no tokens stream while it runs; esc abandons it)`
  const noticeError = pass.streamIdleAborted
    ? Object.assign(
        new Error(
          pass.sawFirstStreamEvent
            ? `stream idle watchdog fired after ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)} of mid-stream silence (${pass.streamEventCount} event(s) arrived, then the stream went quiet — the connection likely dropped) — ${fallbackWaitWords}`
            : streamIdleWatchdog.fired()?.noBytes === true
              ? `${preEventSilenceWords()}, TWICE (the request authenticates and is accepted, then nothing arrives) — ${fallbackWaitWords}; /model can switch families meanwhile`
              : `stream idle watchdog fired after ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)} with no first event, TWICE (the request authenticates and is accepted, then nothing arrives — a dead connection, or a request the server parks) — ${fallbackWaitWords}; /model can switch families meanwhile`,
        ),
        { cause: streamingError },
      )
    : cut !== null
      ? Object.assign(
          new Error(`${transportCutWords('Anthropic', cut)}${call.streamCutRetryUsed ? ', twice' : ''} — ${fallbackWaitWords}`),
          { cause: streamingError },
        )
      : (streamingError as APIError)
  return createSystemAPIErrorMessage(noticeError, 0, 1, 1, {
    recoveryTimeoutMs: getNonstreamingFallbackTimeoutMs(),
  })
}

export function oneShotAnswerOf(call: CallState, result: BetaMessage, noteServedModel: CallLedger['noteServedModel'], mintAssistantMessage: CallLedger['mintAssistantMessage'], newMessages: AssistantMessage[], options: Options, rosterOwnerKey: string): AssistantMessage {
  const nonStreamContent = Array.isArray(result.content) ? result.content : []
  noteServedModel(result.model)
  const m = mintAssistantMessage(result, nonStreamContent)
  newMessages.push(m)
  call.fallbackMessage = m
  if (isTurnOwningQuerySource(options.querySource)) noteRequestOnWire(rosterOwnerKey)
  return m
}

export function streamCreation404Row(call: CallState, options: Options, originalError: APIError): SystemAPIErrorMessage {
  logForDebugging('The streaming endpoint answered 404; the request is retried as one shot', { level: 'warn' })
  call.didFallBackToNonStreaming = true
  if (options.onStreamingFallback) {
    options.onStreamingFallback()
  }
  return createSystemAPIErrorMessage(originalError, 0, 1, 1, {
    recoveryTimeoutMs: getNonstreamingFallbackTimeoutMs(),
  })
}
