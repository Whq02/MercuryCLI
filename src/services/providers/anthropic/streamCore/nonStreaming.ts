import {
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '../../../api/sdkErrors.js'
import type { ApiMessage as BetaMessage } from '../../../../types/wire.js'
import type { AnthropicMessageParams as BetaMessageStreamParams } from '../anthropicWire.js'
import type { QuerySource } from 'src/constants/querySource.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import type { SystemAPIErrorMessage } from '../../../../types/message.js'
import { normalizeModelStringForAPI } from '../../../../utils/model/model.js'
import {
  anthropicLimitVerdict,
  clearAnthropicUsageLimit,
} from '../../../anthropicLimits.js'
import { refreshProviderUsage } from '../../providerUsage.js'
import { getAnthropicClient } from '../../../api/client.js'
import {
  type RetryContext,
  withRetry,
} from '../../../api/withRetry.js'
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
  originatingRequestId?: string | null,
  afterSilence?: { idleMs: number; model: string },
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage> {
  const timeout = getNonstreamingFallbackTimeoutMs()
  const client = () => getAnthropicClient({ maxRetries: 0, fetchOverride: clientOptions.fetchOverride, source: clientOptions.source })
  const attemptRequest = async (anthropic: Awaited<ReturnType<typeof getAnthropicClient>>, attempt: number, context: RetryContext) => {
    if (attempt > 1 || anthropicLimitVerdict().status === 'rejected') await refreshProviderUsage('anthropic', { force: true, reason: 'operator' })
    const started = Date.now()
    const params = paramsFromContext(context)
    captureRequest(params)
    onAttempt(attempt, started, params.max_tokens)
    const fitted = adjustParamsForNonStreaming(params, MAX_NON_STREAMING_TOKENS)
    return nonStreamingAnswer(anthropic, fitted, retryOptions.signal, timeout, started, afterSilence)
  }
  const retries = withRetry(client, attemptRequest, {
    model: retryOptions.model, fallbackModel: retryOptions.fallbackModel,
    thinkingConfig: retryOptions.thinkingConfig, signal: retryOptions.signal,
    initialConsecutive529Errors: retryOptions.initialConsecutive529Errors, querySource: retryOptions.querySource,
    ...(retryOptions.onHeldWait !== undefined ? { onHeldWait: retryOptions.onHeldWait } : {}), healClientContract: true,
  })
  while (true) {
    const step = await retries.next()
    if (step.done) return step.value as BetaMessage
    if (step.value.type === 'system') yield step.value
  }
}

async function nonStreamingAnswer(
  client: Awaited<ReturnType<typeof getAnthropicClient>>, params: BetaMessageStreamParams,
  signal: AbortSignal, timeout: number, started: number, silence?: { idleMs: number; model: string },
) {
  try {
    const reply = await client.beta.messages.create(
      { ...params, model: normalizeModelStringForAPI(params.model) }, { signal, timeout },
    )
    clearAnthropicUsageLimit(started)
    return reply
  } catch (error) {
    if (error instanceof APIUserAbortError) throw error
    logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
    if (silence !== undefined && isFirstByteTimeout(error)) {
      throw new Error(`the stream went quiet for ${patienceSeconds(silence.idleMs)} and one non-streamed answer got nothing in ${patienceSeconds(timeout)} from ${silence.model} — no keep-alive arrived: a dead connection, or a request the provider parked; the turn was ended`)
    }
    throw error
  }
}

export function isFirstByteTimeout(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) return true
  return error instanceof Error && error.constructor?.name === 'APIConnectionTimeoutError'
}

export const MAX_NON_STREAMING_TOKENS = 64_000

export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  const max_tokens = Math.min(params.max_tokens, maxTokensCap)
  const budgetBelow = (thinking: T['thinking'], ceiling: number): T['thinking'] =>
    thinking?.type === 'enabled' && thinking.budget_tokens
      ? { ...thinking, budget_tokens: Math.min(thinking.budget_tokens, ceiling) }
      : thinking
  return 'thinking' in params
    ? { ...params, max_tokens, thinking: budgetBelow(params.thinking, max_tokens - 1) }
    : { ...params, max_tokens }
}
