import { APIConnectionTimeoutError } from '../../../../utils/api/sdkErrors.js'
import type { AnthropicMessageParams as BetaMessageStreamParams } from '../../../../types/anthropicWire.js'
import { randomUUID } from 'crypto'
import { logForDebugging } from 'src/utils/debug.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isFirstPartyAnthropicBaseUrl } from 'src/utils/model/providers.js'
import { noteRunPhase } from 'src/utils/runPhases.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { noteRequestOnWire } from '../prefixLedger.js'
import type {
  Message,
  SystemAPIErrorMessage,
} from '../../../../types/message.js'
import { isTurnOwningQuerySource } from '../../../../utils/effort.js'
import { getPublicModelDisplayName } from '../../../model/model.js'
import { anthropicLimitVerdict } from '../../../anthropicLimits.js'
import { refreshProviderUsage } from '../../providerUsage.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from '../../../api/client.js'
import { recordPromptState } from '../../../api/promptCacheBreakDetection.js'
import { withRetry } from '../../../api/withRetry.js'
import type { HeldBusyRetryWait } from '../../busyRetry.js'
import {
  coldPrefixOf,
  estimateRequestTokens,
  firstByteBudgetMs,
  firstByteTimeoutLine,
  retryReasonWords,
  streamActivityFetchOptions,
  streamIdleTimeoutMsForRoute,
  type RequestWaitV1,
} from '../../streamIdleBudget.js'
import type { Options } from '../streamCore.js'
import { isFirstByteTimeout } from './nonStreaming.js'
import type { CallState, StreamPass } from './state.js'
import type { wireParamsFor } from './wireParams.js'
import { noteMessageEffortRefusal } from '../messageEffort.js'
import { notBuilt, type Unbuilt } from '../../../../pi/holes.js'

type PassRetryInputs = Unbuilt

export function streamPassRetries(call: CallState, pass: StreamPass, arg2: PassRetryInputs): Unbuilt {
  return notBuilt('src/services/providers/anthropic/streamCore/passRetries.ts:49')
}

export function retryWaitOf(notice: SystemAPIErrorMessage): RequestWaitV1 {
  return {
    kind: 'retry',
    attempt: notice.retryAttempt,
    of: notice.maxRetries,
    reason: retryReasonWords(notice.errorDetail?.status ?? (notice.error as { status?: number | null } | undefined)?.status, notice.error?.message),
    delayMs: notice.retryInMs,
    sinceMs: Date.now(),
  }
}
