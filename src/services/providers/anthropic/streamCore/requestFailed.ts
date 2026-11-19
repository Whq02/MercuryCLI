import {
  APIError,
  APIUserAbortError,
} from '../../../api/sdkErrors.js'
import { logForDebugging } from 'src/utils/debug.js'
import { errorMessage } from '../../../../utils/errors.js'
import { createSystemAPIErrorMessage } from '../../../../utils/messages.js'
import { getAssistantMessageFromError } from '../../../api/errors.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
} from '../../../api/withRetry.js'
import { executeNonStreamingRequest, getNonstreamingFallbackTimeoutMs } from './nonStreaming.js'
import { oneShotAnswerOf } from './reissueRows.js'
import type { CallState, QueryCtx, QueryYield } from './state.js'

export async function* requestFailed(ctx: QueryCtx, call: CallState, errorFromRetry: unknown): AsyncGenerator<QueryYield, boolean> {
  const { messages, thinkingConfig, signal, options, modelRefusalRequest, captureModelRequest, rosterOwnerKey, messagesForAPI, paramsFromContext, heldWaitDoor, newMessages, noteServedModel, mintAssistantMessage, yieldAbortedPartialText, logRequestFailure } = ctx
  const is404StreamCreationError =
    !call.didFallBackToNonStreaming &&
    errorFromRetry instanceof CannotRetryError &&
    errorFromRetry.originalError instanceof APIError &&
    errorFromRetry.originalError.status === 404

  if (is404StreamCreationError) {
    const failedRequestId =
      (errorFromRetry.originalError as APIError).requestID ?? 'unknown'
    logForDebugging(
      'The streaming endpoint answered 404; the request is retried as one shot',
      { level: 'warn' },
    )
    call.didFallBackToNonStreaming = true
    if (options.onStreamingFallback) {
      options.onStreamingFallback()
    }
    yield createSystemAPIErrorMessage(
      errorFromRetry.originalError as APIError,
      0,
      1,
      1,
      { recoveryTimeoutMs: getNonstreamingFallbackTimeoutMs() },
    )

    try {
      const result = yield* executeNonStreamingRequest(
        { model: options.model, source: options.querySource, fetchOverride: options.fetchOverride },
        {
          model: options.model,
          fallbackModel: options.fallbackModel,
          thinkingConfig,
          signal,
          ...(heldWaitDoor !== undefined ? { onHeldWait: heldWaitDoor } : {}),
        },
        paramsFromContext,
        (_attempt, _startTime, tokens) => {
          call.maxOutputTokens = tokens
        },
        captureModelRequest,
        failedRequestId,
      )

      const m = oneShotAnswerOf(call, result, noteServedModel, mintAssistantMessage, newMessages, options, rosterOwnerKey)
      yield m

    } catch (fallbackError) {
      if (fallbackError instanceof FallbackTriggeredError) {
        throw fallbackError
      }

      logForDebugging(
        `The one-shot retry failed too: ${errorMessage(fallbackError)}`,
        { level: 'error' },
      )

      const { error, errorModel } = logRequestFailure(fallbackError)

      if (error instanceof APIUserAbortError) {
        yield* yieldAbortedPartialText()
        return true
      }

      if ((error as { status?: unknown }).status === 429) {
        await (await import('../../catalogueOnDemand.js')).readCataloguesForOtherFamilies('anthropic')
      }
      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
        modelRefusalRequest: modelRefusalRequest.current,
      })
      return true
    }
  } else {
    logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
      level: 'error',
    })

    const { error, errorModel } = logRequestFailure(errorFromRetry)

    if (error instanceof APIUserAbortError) {
      yield* yieldAbortedPartialText()
      return true
    }

    if ((error as { status?: unknown }).status === 429) {
      await (await import('../../catalogueOnDemand.js')).readCataloguesForOtherFamilies('anthropic')
    }
    yield getAssistantMessageFromError(error, errorModel, {
      messages,
      messagesForAPI,
      modelRefusalRequest: modelRefusalRequest.current,
    })
    return true
  }
  return false
}
