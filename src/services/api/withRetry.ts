import type Anthropic from '@anthropic-ai/sdk'
import { flagEnabled } from '../../substrate/flagRegistry.js'

import type { SystemAPIErrorMessage } from '../../types/message.js'
import {
  apiKeyHelperFailedLast,
  clearApiKeyHelperCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isAnthropicOAuthSignInExpired,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { isRevokedSignInText } from '../providers/credentialWall.js'
import { logError } from '../../utils/log.js'
import { createSystemAPIErrorMessage } from '../../utils/messages.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { checkFeatureGate_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { isMockRateLimitError } from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { errorHeaders, headerValue, retryAfterHeaderMs, retryAfterOf } from './retryAfter.js'
import { APIConnectionError, APIError, APIUserAbortError } from './sdkErrors.js'
import { deepestErrorDetail, isStaleSocketCode } from './transportEvidence.js'


export const BASE_DELAY_MS = 500

const MAX_DELAY_MS = 32_000
const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000
const CONSECUTIVE_529_FALLBACK_THRESHOLD = 3

const OVERLOADED_TYPE_MARKER = '"type":"overloaded_error"'

const FOREGROUND_QUERY_SOURCES = new Set([
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  'auto_mode',
  ...([] as string[]),
])

export type RetryContext = {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
}

export class CannotRetryError extends Error {
  originalError: unknown
  retryContext: RetryContext

  constructor(originalError: unknown, retryContext: RetryContext) {
    const message =
      originalError instanceof Error ? originalError.message : String(originalError)
    super(message)
    this.name = 'RetryError'
    this.originalError = originalError
    this.retryContext = retryContext
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  originalModel: string
  fallbackModel: string

  constructor(originalModel: string, fallbackModel: string) {
    super(`Model fallback triggered: ${originalModel} → ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
    this.originalModel = originalModel
    this.fallbackModel = fallbackModel
  }
}

export function getDefaultMaxRetries(): number {
  const env = process.env.MERCURY_MAX_RETRIES
  if (env !== undefined && env !== '') {
    return Number.parseInt(env, 10)
  }
  return 10
}


function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : String(error)
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

export function is529Error(error: unknown): boolean {
  return statusOf(error) === 529 || errorMessage(error).includes(OVERLOADED_TYPE_MARKER)
}

function isConnectionErrorLike(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true
  if (!(error instanceof Error)) return false
  const className = error.constructor?.name
  return className === 'APIConnectionError' || className === 'APIConnectionTimeoutError'
}

export function isStaleConnectionError(error: unknown): boolean {
  if (!isConnectionErrorLike(error)) return false
  return isStaleSocketCode(deepestErrorDetail(error).code)
}

function isRevokedTokenError(error: unknown): boolean {
  return statusOf(error) === 403 && isRevokedSignInText(errorMessage(error))
}

export function isRetryableError(error: unknown): boolean {
  if (isMockRateLimitError(error)) return false
  const status = statusOf(error)
  if (errorMessage(error).includes(OVERLOADED_TYPE_MARKER)) return true
  if (parseMaxTokensContextOverflowError(error) !== undefined) return true
  const shouldRetry = headerValue(errorHeaders(error), 'x-should-retry')
  if (shouldRetry === 'false') return false
  if (shouldRetry === 'true' && (!isClaudeAISubscriber() || isEnterpriseSubscriber())) return true
  if (isConnectionErrorLike(error)) return true
  if (status === 408 || status === 409) return true
  if (status !== undefined && status >= 500) return true
  if (status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }
  if (status === 401) {
    const helperFailed = apiKeyHelperFailedLast()
    clearApiKeyHelperCache()
    if (helperFailed) return false
    if (isAnthropicOAuthSignInExpired()) return false
    return true
  }
  if (isRevokedTokenError(error)) return true
  return false
}


const OVERFLOW_SUBSTRING = 'input length and `max_tokens` exceed context limit'
const OVERFLOW_PATTERN =
  /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/

export function parseMaxTokensContextOverflowError(
  error: unknown,
): { inputTokens: number; maxTokens: number; contextLimit: number } | undefined {
  if (statusOf(error) !== 400) return undefined
  const message = errorMessage(error)
  if (message === '') return undefined
  if (!message.includes(OVERFLOW_SUBSTRING)) return undefined
  const match = OVERFLOW_PATTERN.exec(message)
  if (!match) return undefined
  return {
    inputTokens: Number.parseInt(match[1] as string, 10),
    maxTokens: Number.parseInt(match[2] as string, 10),
    contextLimit: Number.parseInt(match[3] as string, 10),
  }
}


export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs: number = MAX_DELAY_MS,
): number {
  const asked = retryAfterHeaderMs(retryAfterHeader)
  if (asked !== undefined) return Math.min(asked, MAX_RETRY_AFTER_MS)
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), maxDelayMs)
  return base + Math.random() * 0.25 * base
}


type WithRetryOptions = {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  signal?: AbortSignal
  querySource?: string
  initialConsecutive529Errors?: number
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, retryContext: RetryContext) => Promise<T>,
  options: WithRetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = options.maxRetries ?? getDefaultMaxRetries()

  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
  }

  let client: Anthropic | null = null
  let lastError: unknown
  let previousError: unknown
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) throw new APIUserAbortError()

    const previousStatus = statusOf(previousError)
    const needsRebuild =
      client === null ||
      previousStatus === 401 ||
      isRevokedTokenError(previousError) ||
      isStaleConnectionError(previousError)
    if (needsRebuild) {
      if (previousStatus === 401 || isRevokedTokenError(previousError)) {
        const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
        if (failedAccessToken !== undefined) {
          await handleOAuth401Error(failedAccessToken).catch(() => false)
        }
      }
      if (isStaleConnectionError(previousError)) {
        if (checkFeatureGate_CACHED_MAY_BE_STALE('mercury_disable_keepalive_on_econnreset')) {
          disableKeepAlive()
        }
      }
      client = await getClient()
    }

    try {
      return await operation(client as Anthropic, attempt, retryContext)
    } catch (error) {
      lastError = error
      previousError = error
      if (error instanceof APIError) {
        logForDebugging(`API error (attempt ${attempt}): ${error.status} ${error.message}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`API error (attempt ${attempt}): ${errorMessage(error)}`, {
          level: 'error',
        })
      }

      const status = statusOf(error)
      const overload = is529Error(error)

      if (overload) {
        const source = options.querySource
        if (source !== undefined && !FOREGROUND_QUERY_SOURCES.has(source)) {
          throw new CannotRetryError(error, retryContext)
        }
      }

      if (overload) {
        const countingEnabled =
          flagEnabled('MERCURY_FALLBACK_ALL_MODELS') ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(retryContext.model))
        if (countingEnabled) {
          consecutive529Errors++
          if (consecutive529Errors >= CONSECUTIVE_529_FALLBACK_THRESHOLD) {
            if (options.fallbackModel !== undefined) {
              throw new FallbackTriggeredError(retryContext.model, options.fallbackModel)
            }
            throw new CannotRetryError(new Error(REPEATED_529_ERROR_MESSAGE), retryContext)
          }
        }
      } else {
        consecutive529Errors = 0
      }

      if (attempt > maxRetries) {
        throw new CannotRetryError(error, retryContext)
      }

      if (!isRetryableError(error)) {
        throw new CannotRetryError(error, retryContext)
      }

      const overflow = parseMaxTokensContextOverflowError(error)
      if (overflow !== undefined) {
        const SAFETY_BUFFER = 1000
        const FLOOR = 3000
        const available = Math.max(0, overflow.contextLimit - overflow.inputTokens - SAFETY_BUFFER)
        if (available < FLOOR) {
          logError(
            new Error(
              `max_tokens overflow unrecoverable: available context ${available} is under the ${FLOOR} floor`,
            ),
          )
          throw error
        }
        const thinkingBudget =
          retryContext.thinkingConfig.type === 'enabled'
            ? (retryContext.thinkingConfig as { budget_tokens?: number }).budget_tokens ?? 0
            : 0
        const minRequired = thinkingBudget > 0 ? thinkingBudget + 1 : 1
        retryContext.maxTokensOverride = Math.max(FLOOR, available, minRequired)
        continue
      }

      const delayMs = getRetryDelay(attempt, retryAfterOf(error))
      yield createSystemAPIErrorMessage(
        error instanceof Error ? error : new Error(errorMessage(error)),
        delayMs,
        attempt,
        maxRetries,
      )
      await sleep(delayMs, options.signal)
    }
  }

  const zeroAttempts = !(1 <= maxRetries + 1)
  throw new CannotRetryError(
    lastError ??
      new Error(
        zeroAttempts
          ? `MERCURY_MAX_RETRIES=${process.env.MERCURY_MAX_RETRIES ?? ''} is not a non-negative integer — no request was attempted; unset it or set a number`
          : 'retry attempts exhausted',
      ),
    retryContext,
  )
}
