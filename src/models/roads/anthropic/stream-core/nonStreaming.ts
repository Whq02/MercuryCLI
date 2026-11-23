import {
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '../../../../engine/request-parts/sdkErrors.js'
import type { ApiMessage as BetaMessage } from '../../../../engine/message-shapes/wire.js'
import type { AnthropicMessageParams as BetaMessageStreamParams } from '../anthropicWire.js'
import type { QuerySource } from 'src/engine/requests/querySource.js'
import { logForDiagnosticsNoPII } from 'src/platform/logs/diagnosticsLog.js'
import type { ThinkingConfig } from 'src/models/effort/thinking.js'
import type { SystemAPIErrorMessage } from '../../../../engine/message-shapes/message.js'
import { normalizeModelStringForAPI } from '../../../catalogue/engineModel.js'
import {
  anthropicLimitVerdict,
  clearAnthropicUsageLimit,
} from '../anthropicLimits.js'
import { refreshProviderUsage } from '../../providerUsage.js'
import { getAnthropicClient } from '../anthropicClientFactory.js'
import {
  type RetryContext,
  withRetry,
} from '../../../../engine/requests/withRetry.js'
import type { HeldBusyRetryWait } from '../../busyRetry.js'
import { nonstreamingFallbackCeilingMs, patienceSeconds } from '../../patience.js'
import type { Options } from '../streamCore.js'
export function getNonstreamingFallbackTimeoutMs(): number {
  return nonstreamingFallbackCeilingMs()
}

export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
    onHeldWait?: (wait: HeldBusyRetryWait) => void
  },
  paramsFromContext: (context: RetryContext) => BetaMessageStreamParams,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (params: BetaMessageStreamParams) => void,
  _originatingRequestId?: string | null,
  afterSilence?: { idleMs: number; model: string },
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage> {
  const retryGen = withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
      }),
    async (client, attempt, retryContext) => {
      if (attempt > 1 || anthropicLimitVerdict().status === 'rejected') {
        await refreshProviderUsage('anthropic', { force: true, reason: 'operator' })
      }
      const start = Date.now()
      const params = paramsFromContext(retryContext)
      captureRequest(params)
      onAttempt(attempt, start, params.max_tokens)
      const adjusted = adjustParamsForNonStreaming(params, MAX_NON_STREAMING_TOKENS)
      const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
      try {
        const response = (await client.beta.messages.create(
          {
            ...adjusted,
            model: normalizeModelStringForAPI(adjusted.model),
          },
          {
            signal: retryOptions.signal,
            timeout: fallbackTimeoutMs,
          },
        )) as BetaMessage
        clearAnthropicUsageLimit(start)
        return response
      } catch (error) {
        if (error instanceof APIUserAbortError) {
          throw error
        }
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        if (afterSilence && isFirstByteTimeout(error)) {
          throw new Error(
            `the stream went quiet for ${patienceSeconds(afterSilence.idleMs)} and one non-streamed answer got nothing in ${patienceSeconds(fallbackTimeoutMs)} from ${afterSilence.model} — no keep-alive arrived: a dead connection, or a request the provider parked; the turn was ended`,
          )
        }
        throw error
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
      ...(retryOptions.onHeldWait !== undefined ? { onHeldWait: retryOptions.onHeldWait } : {}),
      healClientContract: true,
    },
  )

  let step = await retryGen.next()
  while (!step.done) {
    const value = step.value
    if (value && value.type === 'system') {
      yield value
    }
    step = await retryGen.next()
  }
  return step.value
}

export function isFirstByteTimeout(error: unknown): boolean {
  return (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof Error && error.constructor?.name === 'APIConnectionTimeoutError')
  )
}

export const MAX_NON_STREAMING_TOKENS = 64_000

export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  const maxTokens = Math.min(params.max_tokens, maxTokensCap)
  if (
    params.thinking &&
    params.thinking.type === 'enabled' &&
    params.thinking.budget_tokens
  ) {
    return {
      ...params,
      max_tokens: maxTokens,
      thinking: {
        ...params.thinking,
        budget_tokens: Math.min(params.thinking.budget_tokens, maxTokens - 1),
      },
    }
  }
  return {
    ...params,
    max_tokens: maxTokens,
  }
}
