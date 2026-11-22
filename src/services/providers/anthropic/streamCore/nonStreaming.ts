import {
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '../../../../utils/api/sdkErrors.js'
import type { ApiMessage as BetaMessage } from '../../../../types/wire.js'
import type { AnthropicMessageParams as BetaMessageStreamParams } from '../../../../types/anthropicWire.js'
import type { QuerySource } from 'src/constants/querySource.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import type { SystemAPIErrorMessage } from '../../../../types/message.js'
import { normalizeModelStringForAPI } from '../../../model/model.js'
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
import { notBuilt, unbuilt, type Unbuilt } from '../../../../pi/holes.js'

export function getNonstreamingFallbackTimeoutMs(): number {
  return notBuilt('src/services/providers/anthropic/streamCore/nonStreaming.ts:26')
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
  return notBuilt('src/services/providers/anthropic/streamCore/nonStreaming.ts:30')
}

export function isFirstByteTimeout(error: unknown): boolean {
  return notBuilt('src/services/providers/anthropic/streamCore/nonStreaming.ts:95')
}

export const MAX_NON_STREAMING_TOKENS: Unbuilt = unbuilt('src/services/providers/anthropic/streamCore/nonStreaming.ts:100')

export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  return notBuilt('src/services/providers/anthropic/streamCore/nonStreaming.ts:102')
}
