import { flagEnv } from '../../../../substrate/flagRegistry.js'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '../../../api/sdkErrors.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { resetApiConnectionPool } from 'src/utils/proxy.js'
import { noteRequestOnWire } from '../prefixLedger.js'
import { isTurnOwningQuerySource } from '../../../../utils/effort.js'
import { isEnvTruthy } from '../../../../utils/envUtils.js'
import { errorMessage } from '../../../../utils/errors.js'
import {
  createStreamCutMessage,
  createSystemAPIErrorMessage,
} from '../../../../utils/messages.js'
import { transportCutOf, transportCutWords } from '../../../api/transportEvidence.js'
import { is529Error } from '../../../api/withRetry.js'
import { EMPTY_STREAM_TRIES, emptyStreamRetryNotice, emptyStreamRetryWaitMs, emptyStreamSpentWords } from '../../emptyStreamRetry.js'
import { retrySeconds } from '../../../api/recoveryBudget.js'
import { sleep } from '../../../../utils/sleep.js'
import { retryNoticeWait } from '../../streamIdleBudget.js'
import { patienceSeconds } from '../../patience.js'
import { executeNonStreamingRequest, getNonstreamingFallbackTimeoutMs } from './nonStreaming.js'
import { NO_EVENTS_MESSAGE } from './readStream.js'
import type { CallState, QueryCtx, QueryYield, StreamPass, StreamWatch } from './state.js'

const EMPTY_CLOSE_DETAIL = 'closed with no events'

function spokenByProvider(error: unknown): boolean {
  return error instanceof APIError && !(error instanceof APIConnectionError)
}

export async function* recoverStream(ctx: QueryCtx, call: CallState, pass: StreamPass, watch: StreamWatch, streamingError: unknown): AsyncGenerator<QueryYield, 'again' | 'done'> {
  const { signal, options, startIncludingRetries } = ctx
  const { STREAM_IDLE_TIMEOUT_MS, preEventSilenceWords, streamIdleWatchdog, clearStreamIdleTimers, settledTailStands, settleTypedEnd } = watch
  clearStreamIdleTimers()

  if (pass.streamIdleAborted && pass.streamWatchdogFiredAt !== null) {
    const exitDelayMs = Math.round(
      performance.now() - pass.streamWatchdogFiredAt,
    )
    logForDiagnosticsNoPII(
      'info',
      'cli_stream_loop_exited_after_watchdog_error',
    )
    logForDebugging(
      `stream loop exited ${exitDelayMs}ms after watchdog abort (error exit)`,
    )
  }

  if (pass.streamIdleAborted && !signal.aborted && settledTailStands()) {
    yield* settleTypedEnd({
      reason: 'silent-after-last-item',
      provider: 'Anthropic',
      silentMs: streamIdleWatchdog.fired()?.silentMs ?? STREAM_IDLE_TIMEOUT_MS,
    })
    return 'done'
  }

  if (streamingError instanceof APIUserAbortError) {
    if (signal.aborted) {
      logForDebugging(
        `Streaming aborted by user: ${errorMessage(streamingError)}`,
      )
      throw streamingError
    } else {
      logForDebugging(
        `Streaming timeout (SDK abort): ${streamingError.message}`,
        { level: 'error' },
      )
      throw new APIConnectionTimeoutError({ message: 'Request timed out' })
    }
  }

  if (!pass.sawFirstStreamEvent && !pass.streamIdleAborted && !signal.aborted && !spokenByProvider(streamingError)) {
    call.emptyStreamEnds++
    const cutBeforeEvents = transportCutOf(streamingError)
    const detail = cutBeforeEvents !== null ? cutBeforeEvents.code : errorMessage(streamingError) === NO_EVENTS_MESSAGE ? EMPTY_CLOSE_DETAIL : errorMessage(streamingError)
    if (call.emptyStreamEnds < EMPTY_STREAM_TRIES) {
      resetApiConnectionPool()
      const waitMs = emptyStreamRetryWaitMs()
      const notice = emptyStreamRetryNotice({ provider: 'Anthropic', detail, cause: streamingError, attempt: call.emptyStreamEnds + 1, waitMs })
      logForDebugging(`${notice.error.message} — retrying in ${retrySeconds(waitMs)} (attempt ${call.emptyStreamEnds + 1} of ${EMPTY_STREAM_TRIES})`, { level: 'warn' })
      yield notice
      options.onWait?.(retryNoticeWait(notice))
      await sleep(waitMs, signal)
      if (signal.aborted) throw new APIUserAbortError()
      return 'again'
    }
    logForDebugging(`${emptyStreamSpentWords('Anthropic', Date.now() - startIncludingRetries)} (${detail})`, { level: 'error' })
    throw new Error(`${emptyStreamSpentWords('Anthropic', Date.now() - startIncludingRetries)} — ${detail}; try again shortly`)
  }

  const disableFallback =
    isEnvTruthy(flagEnv('MERCURY_DISABLE_NONSTREAMING_FALLBACK')) ||
    (pass.streamIdleAborted && pass.streamedToolUse)

  if (disableFallback) {
    logForDebugging(
      `The stream failed and the one-shot retry is off: ${errorMessage(streamingError)}`,
      { level: 'error' },
    )
    throw streamingError
  }

  if (
    pass.streamIdleAborted &&
    !pass.sawFirstStreamEvent &&
    !call.preFirstEventStreamRetryUsed
  ) {
    call.preFirstEventStreamRetryUsed = true
    resetApiConnectionPool()
    logForDiagnosticsNoPII('info', 'cli_stream_preevent_streaming_retry')
    logForDebugging(
      `watchdog: ${preEventSilenceWords()} — reissuing the stream (pass 2)`,
      { level: 'warn' },
    )
    yield createSystemAPIErrorMessage(
      Object.assign(
        new Error(
          `${preEventSilenceWords()}; reissuing the stream`,
        ),
        { cause: streamingError },
      ),
      0,
      1,
      2,
      { recoveryTimeoutMs: STREAM_IDLE_TIMEOUT_MS },
    )
    return 'again'
  }

  const cut = signal.aborted ? null : transportCutOf(streamingError)
  if (cut !== null && !pass.streamedToolUse && !call.streamCutRetryUsed) {
    call.streamCutRetryUsed = true
    resetApiConnectionPool()
    if (options.onStreamingFallback) {
      options.onStreamingFallback()
    }
    logForDiagnosticsNoPII('warn', 'cli_stream_cut_streaming_retry')
    logForDebugging(
      `${transportCutWords('Anthropic', cut)} — reissuing the stream on a fresh connection (pass 2)`,
      { level: 'warn' },
    )
    yield createStreamCutMessage({
      count: 1,
      content: `${transportCutWords('Anthropic', cut)}; the request was sent again on a fresh connection (reissue 1 of 1)`,
      road: 'Anthropic',
      sent: cut.words,
      code: cut.code,
    })
    return 'again'
  }

  yield* oneShotAfterStreamFailure(ctx, call, pass, watch, streamingError, cut)
  return 'done'
}

async function* oneShotAfterStreamFailure(ctx: QueryCtx, call: CallState, pass: StreamPass, watch: StreamWatch, streamingError: unknown, cut: ReturnType<typeof transportCutOf>): AsyncGenerator<QueryYield, void> {
  const { thinkingConfig, signal, options, captureModelRequest, rosterOwnerKey, paramsFromContext, heldWaitDoor, newMessages, noteServedModel, mintAssistantMessage } = ctx
  const { STREAM_IDLE_TIMEOUT_MS, modelWords, preEventSilenceWords, streamIdleWatchdog } = watch
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
  yield createSystemAPIErrorMessage(noticeError, 0, 1, 1, {
    recoveryTimeoutMs: getNonstreamingFallbackTimeoutMs(),
  })

  logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
  const result = yield* executeNonStreamingRequest(
    { model: options.model, source: options.querySource, fetchOverride: options.fetchOverride },
    {
      model: options.model,
      fallbackModel: options.fallbackModel,
      thinkingConfig,
      signal,
      initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
      querySource: options.querySource,
      ...(heldWaitDoor !== undefined ? { onHeldWait: heldWaitDoor } : {}),
    },
    paramsFromContext,
    (_attempt, _startTime, tokens) => {
      call.maxOutputTokens = tokens
    },
    captureModelRequest,
    call.streamRequestId,
    pass.streamIdleAborted
      ? { idleMs: streamIdleWatchdog.fired()?.silentMs ?? STREAM_IDLE_TIMEOUT_MS, model: modelWords }
      : undefined,
  )

  const nonStreamContent = Array.isArray(result.content) ? result.content : []
  noteServedModel(result.model)
  const m = mintAssistantMessage(result, nonStreamContent)
  newMessages.push(m)
  call.fallbackMessage = m
  if (isTurnOwningQuerySource(options.querySource)) noteRequestOnWire(rosterOwnerKey)
  yield m
}
